// Review ループの fix（push しない）のコミットを refs/heads/<branch> に載せる契約の回帰テスト（Issue #4・Issue #26）。
//
// 事象 1（Issue #4）: fix は隔離 worktree で `git checkout --detach <branch>` して直し、コミット後に `git branch -f <branch> HEAD`
// でブランチを更新していた。ブランチを Implement の worktree が checkout したままだと `git branch -f` は拒否され、
// fix のコミットは detached HEAD にだけ残った。ホストはそれでも次の巡に進み、次の Review は直す前のブランチを見ていた。
// 事象 2（Issue #26）: 対策として fix 自身が `git -C <checkout している worktree> merge --ff-only <fixHeadSha>` するようにしたが、
// Claude Code は隔離された worktree のエージェントが別の worktree を git -C で指すことを（権限の設定とは別に）拒否する。
// fix は branchSynced: false を返し、Issue が blocked で止まっていた。
//
// 契約:
//   1. Review ループの fix のプロンプトはブランチ・他の worktree に触れさせず、fixHeadSha（git rev-parse HEAD）と worktreePath を返させる。
//   2. ホストは scripts/branch-ff.sh を隔離されていないエージェントで 1 回実行させ、ok かつ synced / already-synced のときだけ次の巡に進む。
//      それ以外（sha の形が不正・結果なし・失敗の語）は Issue を blocked にして fix のコミットの sha と fix worktree を記録する。
//   3. branch-ff.sh は祖先関係・作業ツリーの clean・許可リストを確かめてから git merge --ff-only で進める。checkout している worktree が
//      無ければ fix の worktree でブランチを checkout してから ff する。git update-ref は使わない（実際の git で確かめる）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runScript, BASE_ARGS, definitionPart, STUB_SKILL_DIR } from './lib/stub-run.mjs'
import { availableBashes } from './lib/signed-output.mjs'
import { trackTmp } from './lib/tmp-track.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'branch-ff.sh')
const BASHES = availableBashes()

// fixPrompt は境界 nonce の seed を要するため、テスト専用の setter を付けたスライスで読む（fix-no-discussion-comment と同じ方法）。
const sliceDir = trackTmp(mkdtempSync(join(tmpdir(), 'implement-issue-tree-review-fix-branch-sync-')))
const slicePath = join(sliceDir, 'defs.mjs')
// branchFfCommand はスクリプトの場所（args.skillDir）を要するため、定義部の前に args を置く
writeFileSync(slicePath, `const args = ${JSON.stringify({ skillDir: STUB_SKILL_DIR })}\n${definitionPart}\nexport { fixPrompt, FIX_SCHEMA, branchFfCommand }\nexport function __setBoundaryNonceSeedForTest(v) { boundaryNonceSeed = v }\n`)
const defs = await import(pathToFileURL(slicePath).href)
defs.__setBoundaryNonceSeedForTest('a'.repeat(64))
const { fixPrompt, FIX_SCHEMA } = defs

const item = { number: 2, title: 'issue 2' }
const impl = { branch: 'feat/2-x', prNumber: 0 }

// ---------------------------------------------------------------------------
// プロンプトとスキーマ
// ---------------------------------------------------------------------------

test('fixPrompt（Review ループ）: ブランチ・他の worktree に触れさせず、fixHeadSha を返させる（ff はホストが行う）', () => {
  const p = fixPrompt(item, impl, { summary: 'High: x' }, false, [])
  assert.match(p, /^4c\. fix のコミットの記録（必須/m)
  assert.match(p, /git rev-parse HEAD の結果（40 桁の 16 進）を fixHeadSha として返す/)
  // 隔離された agent が実行すると拒否される・ブランチだけを動かす操作を指示しない
  assert.doesNotMatch(p, /git -C <その worktree>/, '別の worktree を git -C で指す操作を指示しない')
  assert.doesNotMatch(p, /merge --ff-only <fixHeadSha>/)
  assert.doesNotMatch(p, /git update-ref refs\/heads/)
  assert.doesNotMatch(p, /git branch -f feat\/2-x HEAD/)
  assert.match(p, /git branch -f・git update-ref・git merge・git -C <他の worktree> を実行しない/)
  assert.match(p, /この worktree の HEAD（fix のコミット）は消さない・動かさない/)
  const ret = p.split('\n').find((l) => l.startsWith('返却:'))
  assert.match(ret, /fixHeadSha（手順 4c で控えた HEAD の sha。40 桁の 16 進。必須）/)
  assert.doesNotMatch(ret, /branchSynced/)
  assert.doesNotMatch(p, /branchSynced/)
})

test('fixPrompt（Merge ループ）: push する fix には 4c と fixHeadSha を出さない（リモートを直接更新するため）', () => {
  const p = fixPrompt({ ...item }, { branch: 'feat/2-x', prNumber: 1002 }, { summary: 's' }, true, [])
  assert.doesNotMatch(p, /^4c\. /m)
  assert.doesNotMatch(p, /fixHeadSha/)
})

test('FIX_SCHEMA: fixHeadSha は任意の string、branchSynced は持たない', () => {
  assert.equal(FIX_SCHEMA.properties.fixHeadSha?.type, 'string')
  assert.ok(!FIX_SCHEMA.required.includes('fixHeadSha'), 'Merge ループの fix は返さないため required にしない')
  assert.equal(FIX_SCHEMA.properties.branchSynced, undefined)
})

test('branchFfCommand: run-verified.sh 経由で、検証済みの値だけを単一引用符で渡す。許可リストは重複と不正なパスを除く', () => {
  const c = defs.branchFfCommand('feat/2-x', 'e'.repeat(40), '/repo/wt/f2', ['/repo/wt/2', '/repo/wt/2', '', '../x', 'relative', '/a/../b', '/ok;rm', undefined])
  assert.ok(c.includes("/scripts/run-verified.sh' @@SCRIPT_SHA256:branch-ff.sh@@ branch-ff.sh"), c)
  assert.ok(c.endsWith(`branch-ff.sh --branch 'feat/2-x' --sha ${'e'.repeat(40)} --fix-worktree '/repo/wt/f2' --allow '/repo/wt/2'`), c)
  assert.throws(() => defs.branchFfCommand('feat/2-x;rm', 'e'.repeat(40), '/repo/wt/f2', []))
  assert.throws(() => defs.branchFfCommand('feat/2-x', 'E'.repeat(40), '/repo/wt/f2', []))
  // fix がパスを返さない・不正なパスなら --fix-worktree を付けない（checkout している worktree の側でなら ff できる）
  for (const p of ['', undefined, '../x', '/a/../b']) {
    const c2 = defs.branchFfCommand('feat/2-x', 'e'.repeat(40), p, ['/repo/wt/2'])
    assert.ok(c2.endsWith(`branch-ff.sh --branch 'feat/2-x' --sha ${'e'.repeat(40)} --allow '/repo/wt/2'`), c2)
  }
})

// ---------------------------------------------------------------------------
// scripts/branch-ff.sh（実際の git）
// ---------------------------------------------------------------------------

// コミット identity・署名・既定ブランチ名は実行環境のユーザー設定に依存させない。作業は temp 配下だけ。
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV }).trim()
}

// main リポジトリ・Implement の worktree（feat/2-x を checkout し実装をコミット済み）・fix の worktree
// （feat/2-x を detach で取得し fix をコミット済み）を作る。
function buildFixture() {
  const root = realpathSync(trackTmp(mkdtempSync(join(tmpdir(), 'implement-issue-tree-fixsync-'))))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', 'a.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])
  const implWt = join(root, 'impl')
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/2-x', implWt, 'main'])
  writeFileSync(join(implWt, 'impl.txt'), 'impl\n')
  git(implWt, ['add', 'impl.txt'])
  git(implWt, ['commit', '-q', '-m', 'feat: 実装'])
  const fixWt = join(root, 'fix')
  git(repo, ['worktree', 'add', '-q', '--detach', fixWt, 'feat/2-x'])
  writeFileSync(join(fixWt, 'fix.txt'), 'fix\n')
  git(fixWt, ['add', 'fix.txt'])
  git(fixWt, ['commit', '-q', '-m', 'fix: Review の指摘を直す'])
  const oldTip = git(repo, ['rev-parse', 'refs/heads/feat/2-x'])
  const fixSha = git(fixWt, ['rev-parse', 'HEAD'])
  return { root, repo, implWt, fixWt, oldTip, fixSha, done: () => rmSync(root, { recursive: true, force: true }) }
}

// スクリプトをメイン worktree（ホストの非隔離エージェントのカレント）で実行し、最後の行の結果を分解する
function runFf(bash, cwd, args) {
  const r = spawnSync(bash, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: GIT_ENV })
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const m = /^BRANCH_FF_RESULT (\{.*\})$/.exec(last)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: m ? JSON.parse(m[1]) : null }
}
// fixWt が null なら --fix-worktree を付けない（fix がパスを返さなかったとき）
const ffArgs = (f, { sha = f.fixSha, fixWt = f.fixWt, allow = [f.implWt] } = {}) => [
  '--branch', 'feat/2-x', '--sha', sha, ...(fixWt === null ? [] : ['--fix-worktree', fixWt]), ...allow.flatMap((p) => ['--allow', p]),
]

test('git: 別の worktree が checkout 中だと git branch -f は拒否される（Issue #4 の再現）', () => {
  const f = buildFixture()
  try {
    assert.throws(() => git(f.fixWt, ['branch', '-f', 'feat/2-x', 'HEAD']), 'git branch -f が通ってしまう（前提が崩れた）')
  } finally {
    f.done()
  }
})

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} branch-ff.sh: checkout している worktree（許可リスト）の側で ff し、その worktree は clean のまま fix のコミットへ進む`, () => {
    const f = buildFixture()
    try {
      const r = runFf(bash, f.repo, ffArgs(f))
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(r.result, { ok: true, result: 'synced', via: 'owner' })
      assert.equal(git(f.repo, ['rev-parse', 'refs/heads/feat/2-x']), f.fixSha)
      assert.equal(git(f.implWt, ['rev-parse', 'HEAD']), f.fixSha)
      assert.equal(git(f.implWt, ['status', '--porcelain']), '', 'ff なので checkout している worktree に差分が残らない')
      // fix の worktree は detached のまま（触れない）
      assert.equal(spawnSync('git', ['-C', f.fixWt, 'symbolic-ref', '-q', 'HEAD'], { env: GIT_ENV }).status, 1)
      // 次の Review（git checkout --detach feat/2-x）は直した後を見る
      const reviewWt = join(f.root, 'review')
      git(f.repo, ['worktree', 'add', '-q', '--detach', reviewWt, 'feat/2-x'])
      assert.equal(git(reviewWt, ['rev-parse', 'HEAD']), f.fixSha)
      // 結果の行は固定語彙だけ（パス・ブランチ名を出さない）
      assert.ok(!r.stdout.includes(f.root) && !r.stdout.includes('feat/2-x'), r.stdout)
    } finally {
      f.done()
    }
  })

  test(`${tag} branch-ff.sh: checkout している worktree が無ければ、fix の worktree でブランチを checkout して ff する（update-ref を使わない）`, () => {
    const f = buildFixture()
    try {
      git(f.repo, ['worktree', 'remove', f.implWt])
      const r = runFf(bash, f.repo, ffArgs(f))
      assert.deepEqual(r.result, { ok: true, result: 'synced', via: 'fix-worktree' }, r.stderr)
      assert.equal(git(f.repo, ['rev-parse', 'refs/heads/feat/2-x']), f.fixSha)
      assert.equal(git(f.fixWt, ['symbolic-ref', 'HEAD']), 'refs/heads/feat/2-x', '以後は fix の worktree がブランチを持つ')
      assert.equal(git(f.fixWt, ['status', '--porcelain']), '')
      // 次の巡: 直前の fix の worktree を許可リストに入れれば、そこで ff できる
      const fix2 = join(f.root, 'fix2')
      git(f.repo, ['worktree', 'add', '-q', '--detach', fix2, 'feat/2-x'])
      writeFileSync(join(fix2, 'fix2.txt'), 'fix2\n')
      git(fix2, ['add', 'fix2.txt'])
      git(fix2, ['commit', '-q', '-m', 'fix: 2 巡目'])
      const sha2 = git(fix2, ['rev-parse', 'HEAD'])
      const r2 = runFf(bash, f.repo, ffArgs(f, { sha: sha2, fixWt: fix2, allow: [f.implWt, f.fixWt] }))
      assert.deepEqual(r2.result, { ok: true, result: 'synced', via: 'owner' }, r2.stderr)
      assert.equal(git(f.fixWt, ['rev-parse', 'HEAD']), sha2)
    } finally {
      f.done()
    }
  })

  test(`${tag} branch-ff.sh: fix の worktree が分からなくても、checkout している worktree（許可リスト）の側でなら ff する`, () => {
    const f = buildFixture()
    try {
      for (const fixWt of [null, join(f.root, 'gone')]) {
        const r = runFf(bash, f.repo, ffArgs(f, { fixWt }))
        assert.deepEqual(r.result, { ok: true, result: fixWt === null ? 'synced' : 'already-synced', via: fixWt === null ? 'owner' : 'none' }, r.stderr)
        assert.equal(git(f.implWt, ['rev-parse', 'HEAD']), f.fixSha)
      }
    } finally {
      f.done()
    }
  })

  test(`${tag} branch-ff.sh: 先端が既に sha なら何もしない（fix の worktree が無くてもよい）`, () => {
    const f = buildFixture()
    try {
      const r = runFf(bash, f.repo, ffArgs(f, { sha: f.oldTip, fixWt: join(f.root, 'gone'), allow: [] }))
      assert.deepEqual(r.result, { ok: true, result: 'already-synced', via: 'none' }, r.stderr)
      assert.equal(git(f.repo, ['rev-parse', 'refs/heads/feat/2-x']), f.oldTip)
    } finally {
      f.done()
    }
  })

  // 失敗の各語: ブランチ・各 worktree を一切動かさない
  const failures = [
    ['許可リストに無い worktree が checkout している', 'owner-not-allowed', (f) => ffArgs(f, { allow: [join(f.root, 'other')] })],
    ['許可リストが空', 'owner-not-allowed', (f) => ffArgs(f, { allow: [] })],
    ['checkout している worktree に追跡ファイルの変更がある', 'owner-dirty', (f) => {
      writeFileSync(join(f.implWt, 'impl.txt'), 'dirty\n')
      return ffArgs(f)
    }],
    ['ブランチが fix の後に別の操作で動いた（fast-forward にならない）', 'not-fast-forward', (f) => {
      writeFileSync(join(f.implWt, 'other.txt'), 'x\n')
      git(f.implWt, ['add', 'other.txt'])
      git(f.implWt, ['commit', '-q', '-m', 'chore: 別の操作'])
      return ffArgs(f)
    }],
    ['申告された sha が fix の worktree の HEAD と違う', 'fix-head-mismatch', (f) => {
      writeFileSync(join(f.fixWt, 'fix.txt'), 'fix again\n')
      git(f.fixWt, ['commit', '-q', '-am', 'fix: もう 1 つ'])
      return ffArgs(f)
    }],
    ['fix の worktree にコミットし忘れた変更がある', 'fix-worktree-dirty', (f) => {
      writeFileSync(join(f.fixWt, 'fix.txt'), 'uncommitted\n')
      return ffArgs(f)
    }],
    ['fix のコミットがリポジトリに無い', 'fix-commit-missing', (f) => ffArgs(f, { sha: '0123456789abcdef0123456789abcdef01234567' })],
    ['checkout している worktree が無く、fix の worktree も登録されていない', 'fix-worktree-missing', (f) => {
      git(f.repo, ['worktree', 'remove', f.implWt])
      return ffArgs(f, { fixWt: join(f.root, 'gone') })
    }],
    ['checkout している worktree が無く、fix の worktree のパスも渡されない', 'fix-worktree-missing', (f) => {
      git(f.repo, ['worktree', 'remove', f.implWt])
      return ffArgs(f, { fixWt: null })
    }],
  ]
  for (const [name, word, setup] of failures) {
    test(`${tag} branch-ff.sh: ${name} → ok: false・${word}。ブランチを動かさない`, () => {
      const f = buildFixture()
      try {
        const args = setup(f)
        const before = git(f.repo, ['rev-parse', 'refs/heads/feat/2-x'])
        const fixHead = git(f.fixWt, ['rev-parse', 'HEAD'])
        const r = runFf(bash, f.repo, args)
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.result?.ok, false, r.stdout)
        assert.equal(r.result?.result, word, r.stderr)
        assert.equal(git(f.repo, ['rev-parse', 'refs/heads/feat/2-x']), before)
        assert.equal(git(f.fixWt, ['rev-parse', 'HEAD']), fixHead, 'fix のコミットを動かさない')
      } finally {
        f.done()
      }
    })
  }

  test(`${tag} branch-ff.sh: メイン worktree がブランチを checkout していれば触れない（owner-main）`, () => {
    const f = buildFixture()
    try {
      git(f.repo, ['worktree', 'remove', f.implWt])
      git(f.repo, ['checkout', '-q', 'feat/2-x'])
      const r = runFf(bash, f.repo, ffArgs(f, { allow: [f.repo] }))
      assert.deepEqual(r.result, { ok: false, result: 'owner-main', via: 'owner' })
      assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.oldTip)
    } finally {
      f.done()
    }
  })

  test(`${tag} branch-ff.sh: 使い方の誤りは exit 2 で結果の行を出さない（何もしない）`, () => {
    const f = buildFixture()
    try {
      for (const args of [
        [],
        ['--branch', 'feat/2-x'],
        ['--sha', f.fixSha, '--fix-worktree', f.fixWt],
        ['--branch', 'feat/2-x', '--sha', f.fixSha, '--fix-worktree'],
        ['--branch', 'feat/2-x;x', '--sha', f.fixSha, '--fix-worktree', f.fixWt],
        ['--branch', 'feat/2-x', '--sha', f.fixSha.slice(0, 7), '--fix-worktree', f.fixWt],
        ['--branch', 'feat/2-x', '--sha', f.fixSha, '--fix-worktree', 'relative/path'],
        ['--branch', 'feat/2-x', '--sha', f.fixSha, '--fix-worktree', f.fixWt, '--allow', '/a/../b'],
        ['--branch', 'feat/2-x', '--sha', f.fixSha, '--fix-worktree', f.fixWt, '--unknown', 'x'],
      ]) {
        const r = runFf(bash, f.repo, args)
        assert.equal(r.status, 2, JSON.stringify(args))
        assert.equal(r.result, null)
      }
      assert.equal(git(f.repo, ['rev-parse', 'refs/heads/feat/2-x']), f.oldTip)
    } finally {
      f.done()
    }
  })
}

test('branch-ff.sh: ブランチを書き換える git は merge --ff-only と checkout だけ（update-ref・branch -f・reset・push・fetch を持たない）', () => {
  const code = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  // 変数展開（${branch} 等）は語として数えない
  const words = code.replace(/\$\{[^}]*\}/g, '')
  assert.doesNotMatch(words, /\bgit\b[^\n|;&]*\b(update-ref|reset|push|fetch|rebase|stash|clean|switch)\b/)
  assert.doesNotMatch(words, /\bgit\b[^\n|;&]*\bbranch\b/)
  assert.doesNotMatch(code, /\brm\b/)
  const merges = code.split('\n').filter((l) => /\bgit\b[^\n|;&]*\bmerge\b/.test(l) && !/merge-base/.test(l)).map((l) => l.trim())
  assert.deepEqual(merges, [
    'git -C "${owner}" merge --ff-only -q "${sha}" </dev/null >&2 || mrc=$?',
    'git -C "${fix_wt}" merge --ff-only -q "${sha}" </dev/null >&2 || mrc=$?',
  ])
  const checkouts = code.split('\n').filter((l) => /\bgit\b[^\n|;&]*\bcheckout\b/.test(l)).map((l) => l.trim())
  assert.deepEqual(checkouts, [
    'git -C "${fix_wt}" checkout -q "${branch}" -- </dev/null >&2 || crc=$?',
    'git -C "${fix_wt}" checkout -q --detach "${sha}" </dev/null >&2 || true',
  ])
})

// ---------------------------------------------------------------------------
// ホスト（Review ループ）
// ---------------------------------------------------------------------------

const labels = (calls, prefix) => calls.filter((c) => c.opts.label.startsWith(prefix))
const needsFix = (summary) => ({ state: 'needs-fix', highestSeverity: 'high', summary, worktreePath: '/repo/wt/r2' })

function scripted({ reviews, fixes, ffs = [] }) {
  let r = 0
  let f = 0
  let s = 0
  return (label) => {
    if (label.startsWith('review:#')) return reviews[r++]
    if (label.startsWith('fix:#')) return fixes[f++]
    if (label.startsWith('branch-ff:#')) return s < ffs.length ? ffs[s++] : undefined
    return undefined
  }
}

const fixed = (path, sha = 'd'.repeat(40)) => ({ pushed: false, summary: 'fixed', worktreePath: path, fixHeadSha: sha })

for (const [name, fixResult, ffs, word, ffCalled] of [
  ['branch-ff.sh が not-fast-forward を返した', fixed('/repo/wt/f2'), [{ ok: false, result: 'not-fast-forward' }], 'not-fast-forward', true],
  ['branch-ff.sh が owner-not-allowed を返した', fixed('/repo/wt/f2'), [{ ok: false, result: 'owner-not-allowed' }], 'owner-not-allowed', true],
  ['ok: true でも result が成功の語でない', fixed('/repo/wt/f2'), [{ ok: true, result: 'ff-failed' }], 'ff-failed', true],
  ['branch-ff の結果が全モデルで返らない', fixed('/repo/wt/f2'), [null, null, null], 'no-result', true],
  ['fixHeadSha が無い（申告漏れ）', { pushed: false, summary: 'fixed', worktreePath: '/repo/wt/f2' }, [], 'fix-sha-invalid', false],
  ['fixHeadSha が短縮形', fixed('/repo/wt/f2', 'd'.repeat(7)), [], 'fix-sha-invalid', false],
  ['worktreePath が無く、branch-ff.sh が fix-worktree-missing を返した', { pushed: false, summary: 'fixed', fixHeadSha: 'd'.repeat(40) }, [{ ok: false, result: 'fix-worktree-missing' }], 'fix-worktree-missing', true],
]) {
  test(`ホスト: ${name}なら次の Review に進まず blocked で止め、fix のコミットと worktree を記録する`, async () => {
    const { calls, result, logs } = await runScript({
      args: BASE_ARGS,
      override: scripted({ reviews: [needsFix('HIGH-1 認可の欠落')], fixes: [fixResult], ffs }),
    })
    assert.equal(labels(calls, 'review:#').length, 1, '直す前のブランチを再レビューしない')
    assert.equal(labels(calls, 'fix:#').length, 1)
    assert.equal(labels(calls, 'branch-ff:#').length > 0, ffCalled)
    assert.equal(labels(calls, 'pr-create:#').length, 0, 'push・PR 作成へ進まない')
    const failure = result.failures.find((x) => x.issue === 2)
    assert.equal(failure?.status, 'blocked')
    assert.match(failure.reason, /ブランチ feat\/2-x に反映できなかった/)
    assert.ok(failure.reason.includes(`理由: ${word}`), failure.reason)
    if (fixResult.worktreePath) {
      assert.match(failure.reason, /\/repo\/wt\/f2/)
      assert.equal(failure.worktree, '/repo/wt/f2', 'fix のコミットがある worktree を記録する')
    }
    if (fixResult.fixHeadSha) assert.ok(failure.reason.includes(fixResult.fixHeadSha), failure.reason)
    assert.ok(logs.some((l) => l.includes('反映できなかった')))
    // 状態ファイルには blocked を書き、fix worktree を削除しない（cleanupWorktree を指示しない）
    const stateWrites = labels(calls, 'state:').map((c) => c.prompt).filter((p) => p.includes('/repo/wt/f2'))
    assert.ok(stateWrites.every((p) => !/cleanupWorktree[^\n]*\/repo\/wt\/f2/.test(p)), 'fix worktree を削除しない')
  })
}

test('ホスト: branch-ff.sh が synced を返せば次の巡に進み、各巡で実装 worktree と直前の fix worktree を許可リストとして渡す', async () => {
  const { calls, result } = await runScript({
    args: BASE_ARGS,
    override: scripted({
      reviews: [needsFix('A'), needsFix('B'), undefined],
      fixes: [fixed('/repo/wt/f2-1', 'e'.repeat(40)), fixed('/repo/wt/f2-2', 'f'.repeat(40))],
      ffs: [{ ok: true, result: 'synced' }, { ok: true, result: 'already-synced' }],
    }),
  })
  assert.equal(labels(calls, 'review:#').length, 3)
  assert.equal(labels(calls, 'pr-create:#').length, 1)
  assert.ok(!result.failures.some((x) => x.issue === 2 && x.status === 'blocked' && /反映できなかった/.test(x.reason)))
  const ffCalls = labels(calls, 'branch-ff:#')
  assert.equal(ffCalls.length, 2)
  // 隔離しない（別の worktree を git -C で指す操作が拒否されないよう、メイン worktree で実行する）
  for (const c of ffCalls) assert.equal(c.opts.isolation, undefined)
  const cmd = (p) => p.split('\n').find((l) => l.includes('branch-ff.sh --branch'))
  const c1 = cmd(ffCalls[0].prompt)
  assert.ok(c1.startsWith(`bash '${STUB_SKILL_DIR}/scripts/run-verified.sh' `), c1)
  assert.ok(c1.endsWith(`--branch 'feat/2-x' --sha ${'e'.repeat(40)} --fix-worktree '/repo/wt/f2-1' --allow '/repo/wt/2'`), c1)
  const c2 = cmd(ffCalls[1].prompt)
  assert.ok(c2.includes(`--sha ${'f'.repeat(40)} --fix-worktree '/repo/wt/f2-2'`), c2)
  assert.ok(c2.includes("--allow '/repo/wt/2'"), '実装 worktree の削除が失敗していても ff できるよう残す')
  assert.ok(c2.includes("--allow '/repo/wt/f2-1'"), '2 巡目は直前の fix worktree も（前の巡でブランチを持った可能性がある）')
  // fix のプロンプトには許可リストも ff の手順も載せない
  for (const c of labels(calls, 'fix:#')) assert.doesNotMatch(c.prompt, /許可リストのいずれかと完全一致|merge --ff-only <fixHeadSha>/)
})
