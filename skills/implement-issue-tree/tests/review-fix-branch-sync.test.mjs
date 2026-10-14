// Review ループの fix（push しない）が、fix のコミットを refs/heads/<branch> に載せる契約の回帰テスト（Issue #4）。
//
// 事象: fix は隔離 worktree で `git checkout --detach <branch>` して直し、コミット後に `git branch -f <branch> HEAD`
// でブランチを更新していた。ブランチを Implement の worktree が checkout したままだと `git branch -f` は拒否され、
// fix のコミットは detached HEAD にだけ残る。ホストはそれでも次の巡に進み、次の Review は直す前のブランチを見て
// 同じ指摘を「再発」として挙げていた。
//
// 契約:
//   1. Review ループの fix のプロンプトは `git branch -f` を使わず、ブランチを checkout している worktree があれば
//      その側で fast-forward（ホストが渡した許可リストの worktree に限る）、無ければ update-ref（元の先端を条件に）で
//      更新し、refs/heads/<branch> が fix の HEAD と一致したことを branchSynced で申告させる。
//   2. ホストは branchSynced が true 以外なら次の巡に進まず、Issue を blocked にして fix のコミットの sha と
//      fix worktree を記録する。
//   3. 別の worktree が同じブランチを checkout している状態で、プロンプトの手順どおりのコマンドがブランチを
//      fix のコミットへ進める（実際の git で確かめる）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runScript, BASE_ARGS, definitionPart } from './lib/stub-run.mjs'

// fixPrompt は境界 nonce の seed を要するため、テスト専用の setter を付けたスライスで読む（fix-no-discussion-comment と同じ方法）。
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-review-fix-branch-sync-'))
const slicePath = join(sliceDir, 'defs.mjs')
writeFileSync(slicePath, `${definitionPart}\nexport { fixPrompt, FIX_SCHEMA }\nexport function __setBoundaryNonceSeedForTest(v) { boundaryNonceSeed = v }\n`)
const defs = await import(pathToFileURL(slicePath).href)
defs.__setBoundaryNonceSeedForTest('a'.repeat(64))
const { fixPrompt, FIX_SCHEMA } = defs

const item = { number: 2, title: 'issue 2' }
const impl = { branch: 'feat/2-x', prNumber: 0 }

// ---------------------------------------------------------------------------
// プロンプト
// ---------------------------------------------------------------------------

test('fixPrompt（Review ループ）: git branch -f を使わず、checkout 中の worktree の側で ff するか update-ref で更新する', () => {
  const p = fixPrompt(item, impl, { summary: 'High: x' }, false, [], ['/repo/wt/2', '/repo/wt/2', '/repo/wt/f2'])
  assert.doesNotMatch(p, /git branch -f feat\/2-x HEAD/, '別 worktree が checkout 中だと拒否される git branch -f に頼らない')
  assert.match(p, /^4c\. ブランチへの反映（必須/m)
  assert.match(p, /git worktree list --porcelain/)
  assert.match(p, /"branch refs\/heads\/feat\/2-x"/)
  assert.match(p, /git update-ref refs\/heads\/feat\/2-x <fixHeadSha> <元の先端>/, '元の先端を条件にした update-ref')
  assert.match(p, /git -C <その worktree> merge --ff-only <fixHeadSha>/)
  assert.match(p, /git -C <その worktree> status --porcelain --untracked-files=no/)
  assert.match(p, /git merge-base --is-ancestor <元の先端> <fixHeadSha>/)
  // 許可リストは重複を除いて JSON 文字列で埋め込む
  const allowLine = p.split('\n').find((l) => l.includes('許可リストのいずれかと完全一致'))
  assert.ok(allowLine, '許可リストの行が無い')
  assert.equal(allowLine.split('"/repo/wt/2"').length - 1, 1, '重複したパスは 1 回だけ')
  assert.ok(allowLine.includes('"/repo/wt/f2"'))
  // 失敗の形と返却
  assert.match(p, /branchSynced: false と fixHeadSha を返し/)
  assert.match(p, /この worktree の HEAD（fix のコミット）は消さない/)
  const ret = p.split('\n').find((l) => l.startsWith('返却:'))
  assert.match(ret, /branchSynced（/)
  assert.match(ret, /fixHeadSha（/)
})

test('fixPrompt（Review ループ）: 許可リストが空・不正なパスだけなら worktree の側での更新を許さない', () => {
  for (const owners of [[], undefined, ['', '../x', 'relative/path', '/a/../b', '/ok;rm']]) {
    const p = fixPrompt(item, impl, { summary: 's' }, false, [], owners)
    assert.match(p, /\(空。worktree の側での更新は行わない\)/, JSON.stringify(owners))
    assert.doesNotMatch(p, /"\.\.\/x"|"relative\/path"/)
  }
  // 既定引数（呼び出し元が渡さない）でも同じ
  assert.match(fixPrompt(item, impl, { summary: 's' }, false), /\(空。worktree の側での更新は行わない\)/)
})

test('fixPrompt（Merge ループ）: push する fix にはブランチ反映の手順と branchSynced を出さない（リモートを直接更新するため）', () => {
  const p = fixPrompt({ ...item }, { branch: 'feat/2-x', prNumber: 1002 }, { summary: 's' }, true, [], ['/repo/wt/2'])
  assert.doesNotMatch(p, /^4c\. /m)
  assert.doesNotMatch(p, /branchSynced/)
})

test('FIX_SCHEMA: branchSynced は任意の boolean、fixHeadSha は任意の string', () => {
  assert.equal(FIX_SCHEMA.properties.branchSynced?.type, 'boolean')
  assert.equal(FIX_SCHEMA.properties.fixHeadSha?.type, 'string')
  assert.ok(!FIX_SCHEMA.required.includes('branchSynced'), 'Merge ループの fix は返さないため required にしない')
  assert.ok(!FIX_SCHEMA.required.includes('fixHeadSha'))
})

// ---------------------------------------------------------------------------
// 実際の git: 別の worktree が同じブランチを checkout している状態
// ---------------------------------------------------------------------------

// コミット identity・署名・既定ブランチ名は実行環境のユーザー設定に依存させない。作業は temp 配下だけ。
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim()
}

// main リポジトリ・Implement の worktree（feat/2-x を checkout し実装をコミット済み）・fix の worktree
// （feat/2-x を detach で取得し fix をコミット済み）を作る。
function buildFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'implement-issue-tree-fixsync-')))
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
  return { root, repo, implWt, fixWt }
}

// `git worktree list --porcelain` から、指定ブランチを checkout している worktree のパスを返す（プロンプトの手順 c）。
function ownerOf(cwd, branch) {
  let current = null
  for (const line of git(cwd, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    if (line === `branch refs/heads/${branch}`) return current
  }
  return null
}

test('git: 別の worktree が checkout 中だと git branch -f は拒否される（不具合の再現）', () => {
  const { root, fixWt } = buildFixture()
  try {
    assert.throws(() => git(fixWt, ['branch', '-f', 'feat/2-x', 'HEAD']), 'git branch -f が通ってしまう（前提が崩れた）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('git: 手順どおり、checkout している worktree の側で ff するとブランチが fix のコミットへ進み、その worktree は clean のまま', () => {
  const { root, implWt, fixWt } = buildFixture()
  try {
    const fixHeadSha = git(fixWt, ['rev-parse', 'HEAD'])
    const oldTip = git(fixWt, ['rev-parse', 'refs/heads/feat/2-x'])
    assert.notEqual(fixHeadSha, oldTip)
    // b. 元の先端が fix の HEAD の祖先
    git(fixWt, ['merge-base', '--is-ancestor', oldTip, fixHeadSha])
    // c. checkout している worktree はホストが渡した許可リスト（実装 worktree）と一致する
    const owner = ownerOf(fixWt, 'feat/2-x')
    assert.equal(owner, implWt)
    const allow = new Set([implWt])
    assert.ok(allow.has(owner))
    assert.equal(git(fixWt, ['-C', owner, 'status', '--porcelain', '--untracked-files=no']), '')
    git(fixWt, ['-C', owner, 'merge', '--ff-only', fixHeadSha])
    // d. ブランチが fix の HEAD と一致し、次の Review（git checkout --detach feat/2-x）は直した後を見る
    assert.equal(git(fixWt, ['rev-parse', 'refs/heads/feat/2-x']), fixHeadSha)
    assert.equal(git(implWt, ['rev-parse', 'HEAD']), fixHeadSha)
    assert.equal(git(implWt, ['status', '--porcelain']), '', 'ff なので checkout している worktree に差分が残らない')
    const reviewWt = join(root, 'review')
    git(implWt, ['worktree', 'add', '-q', '--detach', reviewWt, 'feat/2-x'])
    assert.equal(git(reviewWt, ['rev-parse', 'HEAD']), fixHeadSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('git: checkout している worktree が無ければ update-ref（元の先端を条件に）で更新し、途中でブランチが動いていたら更新しない', () => {
  const { root, repo, implWt, fixWt } = buildFixture()
  try {
    const fixHeadSha = git(fixWt, ['rev-parse', 'HEAD'])
    const oldTip = git(fixWt, ['rev-parse', 'refs/heads/feat/2-x'])
    git(repo, ['worktree', 'remove', implWt])
    assert.equal(ownerOf(fixWt, 'feat/2-x'), null)
    // 元の先端が違えば（途中で動いた）拒否される
    assert.throws(() => git(fixWt, ['update-ref', 'refs/heads/feat/2-x', fixHeadSha, fixHeadSha]))
    assert.equal(git(fixWt, ['rev-parse', 'refs/heads/feat/2-x']), oldTip)
    git(fixWt, ['update-ref', 'refs/heads/feat/2-x', fixHeadSha, oldTip])
    assert.equal(git(fixWt, ['rev-parse', 'refs/heads/feat/2-x']), fixHeadSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ホスト（Review ループ）
// ---------------------------------------------------------------------------

const labels = (calls, prefix) => calls.filter((c) => c.opts.label.startsWith(prefix))
const needsFix = (summary) => ({ state: 'needs-fix', highestSeverity: 'high', summary, worktreePath: '/repo/wt/r2' })

function scripted({ reviews, fixes }) {
  let r = 0
  let f = 0
  return (label) => {
    if (label.startsWith('review:#')) return reviews[r++]
    if (label.startsWith('fix:#')) return fixes[f++]
    return undefined
  }
}

for (const [name, fixResult] of [
  ['branchSynced: false', { pushed: false, summary: 'git branch -f が拒否された', worktreePath: '/repo/wt/f2', branchSynced: false, fixHeadSha: 'd'.repeat(40) }],
  ['branchSynced が無い（申告漏れ）', { pushed: false, summary: 'fixed', worktreePath: '/repo/wt/f2' }],
]) {
  test(`ホスト: Review fix が ${name} なら次の Review に進まず blocked で止め、fix のコミットと worktree を記録する`, async () => {
    const { calls, result, logs } = await runScript({
      args: BASE_ARGS,
      override: scripted({ reviews: [needsFix('HIGH-1 認可の欠落')], fixes: [fixResult] }),
    })
    assert.equal(labels(calls, 'review:#').length, 1, '直す前のブランチを再レビューしない')
    assert.equal(labels(calls, 'fix:#').length, 1)
    assert.equal(labels(calls, 'pr-create:#').length, 0, 'push・PR 作成へ進まない')
    const failure = result.failures.find((x) => x.issue === 2)
    assert.equal(failure?.status, 'blocked')
    assert.match(failure.reason, /ブランチ feat\/2-x に反映できなかった/)
    assert.match(failure.reason, /\/repo\/wt\/f2/)
    assert.equal(failure.worktree, '/repo/wt/f2', 'fix のコミットがある worktree を記録する')
    if (fixResult.fixHeadSha) assert.match(failure.reason, new RegExp(fixResult.fixHeadSha))
    assert.ok(logs.some((l) => l.includes('反映できなかった')))
    // 状態ファイルには blocked を書き、fix worktree を削除しない（cleanupWorktree を指示しない）
    const stateWrites = labels(calls, 'state:').map((c) => c.prompt).filter((p) => p.includes('/repo/wt/f2'))
    assert.ok(stateWrites.every((p) => !/cleanupWorktree[^\n]*\/repo\/wt\/f2/.test(p)), 'fix worktree を削除しない')
  })
}

test('ホスト: branchSynced: true なら次の巡に進み、各 fix へ実装 worktree と直前の fix worktree を許可リストとして渡す', async () => {
  const synced = (n) => ({ pushed: false, summary: 'fixed', worktreePath: `/repo/wt/f2-${n}`, branchSynced: true, fixHeadSha: 'e'.repeat(40) })
  const { calls, result } = await runScript({
    args: BASE_ARGS,
    override: scripted({ reviews: [needsFix('A'), needsFix('B'), undefined], fixes: [synced(1), synced(2)] }),
  })
  assert.equal(labels(calls, 'review:#').length, 3)
  assert.equal(labels(calls, 'pr-create:#').length, 1)
  assert.ok(!result.failures.some((x) => x.issue === 2 && x.status === 'blocked' && /反映できなかった/.test(x.reason)))
  const fixes = labels(calls, 'fix:#')
  const allowLine = (p) => p.split('\n').find((l) => l.includes('許可リストのいずれかと完全一致'))
  assert.ok(allowLine(fixes[0].prompt).includes('"/repo/wt/2"'), '1 巡目は実装 worktree')
  assert.ok(allowLine(fixes[1].prompt).includes('"/repo/wt/2"'), '実装 worktree の削除が失敗していても ff できるよう残す')
  assert.ok(allowLine(fixes[1].prompt).includes('"/repo/wt/f2-1"'), '2 巡目は直前の fix worktree も')
})
