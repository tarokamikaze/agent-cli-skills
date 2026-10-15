// Write ツールで書く一時ファイル（.implement-issue-tree-<nonce>.md・<状態ファイル>.input-<nonce>.json）を git の除外設定に載せる scripts/worktree-exclude.sh の回帰テスト（Issue #21）。
//
// 一時ファイルは同梱スクリプトが読んで消すが、スクリプトを起動できなかった経路では残る。git add の前に消す手順
// （WRITTEN_FILE_COMMIT_GUARD）は agent が手順に従うことと、カレントディレクトリが作業ツリーのルートであることに
// 依存する。サブディレクトリで git add -A しても stage されないよう、除外設定を機械的に書く。
//
// 検証する契約:
//   - linked worktree で実行すると、git rev-parse --git-path info/exclude が示すファイル（git が読む共有の
//     info/exclude）に全パターンが載り、そのあと worktree のサブディレクトリで git add -A しても一時ファイルは stage
//     されない。同じ除外はメイン worktree と、あとから作った別の worktree にも効く
//   - 2 回実行しても行は増えない。末尾に改行の無い既存の exclude を壊さない
//   - git の作業ツリーの外・引数ありは失敗する
//   - ホストのプロンプト（コミットを作る手順と PR 作成の base 取り込みの解消）が、git add の前にこのスクリプトを起動させる
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { importDefinitions } from './lib/stub-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'worktree-exclude.sh')
const BASHES = availableBashes()
const PATTERNS = ['.implement-issue-tree-*.md', '/_/issue-trees/*.json.input-*.json']
// 作業ツリーのルートからの相対パス。ホストが作る一時ファイル（Write の .md はカレントディレクトリ、state.sh の入力ファイルは
// 状態ファイル _/issue-trees/<parent>.json の隣）
const TEMP_FILES = [
  '.implement-issue-tree-0123abcd.md', 'sub/.implement-issue-tree-0123abcd.md', '_/issue-trees/7.json.input-0123abcd.json',
]
// 利用者のファイル（除外しない）。パターンを広く取ると、ランのあとも黙って無視され続ける
const USER_FILES = [
  '_/issue-trees/7.json', 'release.input-notes.json', 'sub/x.json.input-1.json', 'sub/_/issue-trees/7.json.input-0.json',
  'release.patch-notes.json', 'sub/keep.md',
]
const put = (root, rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), 'x')
}

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function makeRepo() {
  // macOS の tmpdir は symlink（/var → /private/var）。git の返すパスと比べるため実体のパスにする
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'iit-exclude-')))
  const main = join(root, 'main')
  mkdirSync(main)
  git(main, 'init', '-q')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(root, 'wt')
  git(main, 'worktree', 'add', '-q', '-b', 'wt', wt)
  return { root, main, wt, done: () => rmSync(root, { recursive: true, force: true }) }
}

const run = (bash, cwd, args = []) => spawnSync(bash, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
const excludePath = (cwd) => resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/exclude').trim())

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} worktree-exclude.sh: linked worktree で実行すると共有の info/exclude に全パターンが載り、サブディレクトリの git add -A でも一時ファイルを stage しない`, () => {
    const r0 = makeRepo()
    try {
      const sub = join(r0.wt, 'sub')
      mkdirSync(sub)
      const r = run(bash, sub)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'OK\n')
      // git が読むのは --git-path の示す共有の exclude（worktree ごとの $GIT_DIR/info/exclude は読まれない）
      const path = excludePath(r0.wt)
      assert.equal(path, resolve(r0.main, '.git', 'info', 'exclude'))
      const lines = readFileSync(path, 'utf8').split('\n')
      for (const p of PATTERNS) assert.equal(lines.filter((l) => l === p).length, 1, p)
      // 一時ファイルと利用者のファイルを置き、サブディレクトリで git add -A する。一時ファイルだけが stage されない
      for (const f of [...TEMP_FILES, ...USER_FILES]) put(r0.wt, f)
      git(sub, 'add', '-A')
      const staged = git(r0.wt, 'diff', '--cached', '--name-only').trim().split('\n').filter(Boolean).sort()
      assert.deepEqual(staged, [...USER_FILES].sort())
      // メイン worktree と、あとから作った worktree にも効く
      const later = join(r0.root, 'later')
      git(r0.main, 'worktree', 'add', '-q', '-b', 'later', later)
      for (const dir of [r0.main, later]) {
        for (const f of TEMP_FILES) put(dir, f)
        git(dir, 'add', '-A')
        assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '', dir)
      }
    } finally {
      r0.done()
    }
  })

  test(`${tag} worktree-exclude.sh: 2 回実行しても行は増えず、末尾に改行の無い既存の exclude の行を壊さない`, () => {
    const r0 = makeRepo()
    try {
      const path = excludePath(r0.wt)
      writeFileSync(path, '# 既存\nbuild/')
      for (let i = 0; i < 2; i++) assert.equal(run(bash, r0.wt).status, 0)
      const lines = readFileSync(path, 'utf8').split('\n')
      assert.equal(lines[0], '# 既存')
      assert.equal(lines[1], 'build/')
      for (const p of PATTERNS) assert.equal(lines.filter((l) => l === p).length, 1, p)
      // info/ が無い（git init --template= など）ときは作る
      rmSync(dirname(path), { recursive: true, force: true })
      assert.equal(run(bash, r0.wt).status, 0)
      for (const p of PATTERNS) assert.ok(readFileSync(path, 'utf8').split('\n').includes(p), p)
    } finally {
      r0.done()
    }
  })

  test(`${tag} worktree-exclude.sh: git の作業ツリーの外は exit 1、引数ありは exit 2（何も書かない）`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'iit-exclude-nogit-'))
    try {
      const r = spawnSync(bash, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } })
      assert.equal(r.status, 1, r.stderr)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /^FAILED: /m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const r0 = makeRepo()
    try {
      assert.equal(run(bash, r0.wt, ['x']).status, 2)
      assert.ok(!readFileSync(excludePath(r0.wt), 'utf8').includes(PATTERNS[0]))
    } finally {
      r0.done()
    }
  })
}

test('パターンはホストが実際に作る一時ファイルの名前の形に合う（状態ファイルの場所・state.sh の入力ファイル / Write の .md の名前）', () => {
  const src = readFileSync(join(HERE, '..', 'scripts', 'implement-issue-tree.src.js'), 'utf8')
  // state.sh の入力ファイルは作業ツリーのルートからの _/issue-trees/<parent>.json の隣（ルートにアンカーできる）
  assert.ok(src.includes('const STATE_FILE = `_/issue-trees/${parent}.json`'), 'STATE_FILE の場所')
  assert.ok(src.includes('`${STATE_FILE}.input-${nonce}.json`'), '入力ファイルの名前')
  assert.ok(readFileSync(join(HERE, '..', 'scripts', 'state.sh'), 'utf8').includes('in_src="${file}.input-${'), 'state.sh が読む名前')
  // ほかの一時ファイルの名前（旧 patch・sweep）が戻っていないこと。戻ったらパターンを足す
  assert.doesNotMatch(src, /\$\{STATE_FILE\}\.(patch|sweep)-/, '旧 patch・sweep の名前')
  // Write の .md はカレントディレクトリ（ルートの保証が無いのでアンカーしない）
  assert.ok(src.includes('const writtenFileOf = (nonce) => `.implement-issue-tree-${nonce}.md`'), '.md の名前')
  const script = readFileSync(SCRIPT, 'utf8')
  assert.ok(script.includes(`patterns=(${PATTERNS.map((p) => `'${p}'`).join(' ')})`), 'スクリプトのパターンとテストの一覧が同じ')
})

test('ホストのプロンプト: コミットを作る手順と PR 作成の base 取り込みの解消が、git add の前に worktree-exclude.sh を起動させる', async () => {
  const defs = await importDefinitions(['implementPrompt', 'recoverImplementPrompt', 'fixPrompt', 'prCreatePrompt', 'ensureBoundaryNonceSeed', 'WRITTEN_FILE_COMMIT_GUARD'], 'temp-file-exclude')
  globalThis.agent = async () => ({ seedHex: 'c'.repeat(64) })
  await defs.ensureBoundaryNonceSeed()
  const item = { number: 5, title: 't' }
  const impl = { prNumber: 1005, branch: 'feat/5-x', worktreePath: '/repo/wt/5' }
  const finding = { summary: 's', unresolvedComments: [{ threadId: 'T1', text: 'x' }] }
  for (const [name, p] of [
    ['implement', defs.implementPrompt(item, 'plan')],
    ['recover-implement', defs.recoverImplementPrompt(item, { done: '', remaining: '', broken: '' }, 'feat/5-x')],
    ['fix（push する）', defs.fixPrompt(item, impl, finding, true)],
    ['fix（push しない）', defs.fixPrompt(item, impl, finding, false)],
    ['PR 作成', defs.prCreatePrompt(item, impl, [])],
  ]) {
    const at = p.indexOf('/scripts/run-verified.sh\' @@SCRIPT_SHA256:worktree-exclude.sh@@ worktree-exclude.sh')
    assert.ok(at > 0, `${name}: worktree-exclude.sh を起動させる`)
    // 起動は、残った一時ファイルを消す手順（git add の前）より前に置く
    assert.ok(p.indexOf('rm -f -- .implement-issue-tree-*.md', at) > at, `${name}: 消す手順の手前`)
  }
})
