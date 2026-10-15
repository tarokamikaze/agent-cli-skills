// worktree・ブランチの削除と破棄前の観測（Issue #11 の範囲 D: scripts/worktree-cleanup.sh・discard-safety.sh）を、実際の git で
// 一時リポジトリと worktree を作って確かめる回帰テスト。
//
// 検証する契約:
//   1. 旧プロンプトが agent に実行させていたシェル（このファイルに固定文字列で持つ。src から消えたので、ここが旧の正本）と
//      同じ状態のリポジトリに対して、スクリプトが同じものを消し、同じものを残すこと（削除の安全判定の結果と順序が変わらないこと）。
//      同じ構成のリポジトリを 2 つ作り、片方で旧シェル、もう片方でスクリプトを流して、残ったファイル・git worktree list・ブランチを比べる。
//      旧プロンプトのうち文章で書かれていた判断（「出力に対象パスが含まれるか確認する」「状態ファイルが読めなければ何も消さない」など）は、
//      その文章どおりのコマンドに置き換えて持つ（コメントで示す）。
//   2. ホストが組み立てたコマンド（引数の引用・候補一覧の照合値）を、そのままスクリプトが受け付けること。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { BASE_ARGS, definitionPart } from './lib/stub-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const BASHES = availableBashes()
const STATE = '_/issue-trees/1.json'
const NONCE = 'n0nce123'

// --- 旧プロンプトのシェル（変える前の src の文面。インデントを外し、プロンプトに埋め込まれていた値を変数で受ける）---

// updateStateDetailed の worktree 削除タスク（state:cleanup）。手順 2 の「出力に対象パスが含まれるか確認する。メインリポ自身
// （先頭エントリの worktree 行）は絶対に削除しない」は、先頭を除いた worktree 行との完全一致に置き換える。
// フォールバックの b の判定（文章）は、書かれた条件をそのまま if にしたもの。
const OLD_CLEANUP = `
p="$1"
if git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print}' | tail -n +2 | grep -qxF -- "$p"; then
  if ! git worktree remove --force -- "$p"; then
    git worktree unlock -- "$p"
    if ! git worktree remove --force -- "$p"; then
      target=$(cd "$p" 2>/dev/null && pwd -P)
      main=$(git rev-parse --show-toplevel 2>/dev/null)
      main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
      main_wt_real=$(cd "$main_wt" 2>/dev/null && pwd -P)
      if [ -z "$target" ]; then :
      elif [ "$target" = "$main" ] || [ "$target" = "$main_wt_real" ]; then :
      else
        case "$target" in
          "$main"/*) : ;;
          *) rm -rf -- "$p" && git worktree prune ;;
        esac
      fi
    fi
  fi
fi
git worktree prune
`

// 同じくブランチ削除タスク（手順 1 の出力が空でなければ手順 2）
const OLD_DELETE_BRANCH = `
if [ -n "$(git branch --list -- "$1")" ]; then
  b="$1"
  git branch -D -- "$b"
fi
`

// sweepClosedWorktrees の手順 1・2・4・5。手順 1 の「状態ファイルが存在しない・パースできない場合は削除を一切行わない」は
// jq の失敗で終えることに置き換える。$1 = 状態ファイル、$2 = 候補一覧の JSON（旧プロンプトはヒアドキュメントに埋め込んでいた）
const OLD_SWEEP = `
retain_file=$(mktemp)
jq -r '.items | to_entries[] | select(.value.status == "failed" or .value.status == "blocked" or .value.status == "monitoring") | .value.worktree | select(. != null and . != "")' "$1" > "$retain_file" || exit 0
registered_file=$(mktemp)
git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print}' | tail -n +2 > "$registered_file"
candidates_file=$(mktemp)
printf '%s\\n' "$2" > "$candidates_file"
jq -r '.[]' "$candidates_file" | while IFS= read -r p; do
  [ -z "$p" ] && continue
  grep -qxF -- "$p" "$retain_file" && continue
  grep -qxF -- "$p" "$registered_file" || continue
  git worktree remove --force -- "$p" && continue
  git worktree unlock -- "$p" 2>/dev/null
  git worktree remove --force -- "$p" 2>/dev/null && continue
  target=$(cd "$p" 2>/dev/null && pwd -P)
  main=$(git rev-parse --show-toplevel 2>/dev/null)
  main_wt=$(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print; exit}')
  main_wt_real=$(cd "$main_wt" 2>/dev/null && pwd -P)
  if [ -z "$target" ]; then continue; fi
  if [ "$target" = "$main" ] || [ "$target" = "$main_wt_real" ]; then continue; fi
  case "$target" in
    "$main"/*) continue ;;
  esac
  rm -rf -- "$p"
done
rm -f "$candidates_file" "$retain_file" "$registered_file"
git worktree prune
`

// verifyDiscardSafety の手順 1〜3。手順 1・2 の判断（文章）は書かれた条件どおりに置き換える
const OLD_DISCARD = `
p="$1"
dirty=false
missing=false
if [ -z "$p" ]; then
  missing=true
elif ! git worktree list --porcelain | grep -qxF -- "worktree $p"; then
  missing=true
else
  if out=$(git -C "$p" status --porcelain); then
    [ -n "$out" ] && dirty=true
  else
    dirty=true
  fi
fi
ahead=-1
if [ -n "$2" ]; then
  b="$2"
  base="$3"
  if n=$(git rev-list --count "origin/$base".."refs/heads/$b"); then
    case "$n" in '' | *[!0-9]*) ;; *) ahead=$n ;; esac
  fi
fi
echo "WORKTREE_MISSING $missing"
echo "DIRTY $dirty"
echo "AHEAD $ahead"
`

// --- 一時リポジトリ ---

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// 同じ構成のリポジトリを作る。kinds の各要素が 1 つの worktree（名前 → 作り方）
function makeRepo(kinds) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'iit-cleanup-')))
  const main = join(root, 'main')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'config', 'user.email', 't@example.invalid')
  git(main, 'config', 'user.name', 't')
  git(main, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(main, 'a.txt'), 'a\n')
  writeFileSync(join(main, '.gitignore'), '_/\nnested*/\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const paths = {}
  for (const [name, kind] of Object.entries(kinds)) {
    const p = kind === 'nested-broken' ? join(main, `nested-${name}`) : join(root, name)
    paths[name] = p
    if (kind === 'plain-dir') {
      mkdirSync(p)
      writeFileSync(join(p, 'x'), 'x')
      continue
    }
    git(main, 'worktree', 'add', '-q', '-b', `feat/${name.replace(/ /g, '-')}`, p)
    if (kind === 'locked') git(main, 'worktree', 'lock', p)
    if (kind === 'dirty') writeFileSync(join(p, 'untracked.txt'), 'u')
    if (kind === 'ahead') {
      writeFileSync(join(p, 'b.txt'), 'b')
      git(p, 'add', '-A')
      git(p, 'commit', '-q', '-m', 'b')
      writeFileSync(join(p, 'c.txt'), 'c')
      git(p, 'add', '-A')
      git(p, 'commit', '-q', '-m', 'c')
    }
    // .git をディレクトリに替えると git worktree remove が検証で失敗し、rm -rf のフォールバックに進む
    if (kind === 'broken' || kind === 'nested-broken') {
      rmSync(join(p, '.git'))
      mkdirSync(join(p, '.git'))
    }
    if (kind === 'missing') rmSync(p, { recursive: true, force: true })
    // 登録後に実体をメイン worktree へのシンボリックリンクに替える（実パスがメイン worktree になる）
    if (kind === 'symlink-main') {
      rmSync(p, { recursive: true, force: true })
      symlinkSync(main, p)
    }
  }
  return { root, main, paths, done: () => rmSync(root, { recursive: true, force: true }) }
}

// 比較用の状態: 各パスの有無・種類、git worktree list の登録、ブランチ、メイン worktree の中身（ルートは <root> に置き換える）
function snapshot(repo) {
  const rel = (s) => s.split(repo.root).join('<root>')
  const kinds = {}
  for (const [name, p] of Object.entries(repo.paths)) {
    let k = 'none'
    try {
      const st = lstatSync(p)
      k = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file'
    } catch {
      k = 'none'
    }
    kinds[name] = k
  }
  const porcelain = git(repo.main, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map(rel)
  const branches = git(repo.main, 'branch', '--list', '--format=%(refname:short)').trim().split('\n')
  const mainFiles = readdirSync(repo.main).sort()
  return { kinds, porcelain, branches, mainFiles }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

function runNew(bash, repo, script, args) {
  return spawnSync(bash, [join(SCRIPTS, script), ...args], { cwd: repo.main, encoding: 'utf8' })
}
function runOld(bash, repo, body, args) {
  return spawnSync(bash, ['-c', body, 'old', ...args], { cwd: repo.main, encoding: 'utf8' })
}

function writeState(repo, items) {
  mkdirSync(join(repo.main, '_', 'issue-trees'), { recursive: true })
  writeFileSync(join(repo.main, STATE), JSON.stringify({ parent: 1, items }))
}

// スイープの候補一覧を Write ツールが書いたものとして置き、照合値を返す
function writeCandidates(repo, json) {
  writeFileSync(join(repo.main, `${STATE}.sweep-${NONCE}.json`), `${json}\n`)
  return sha256(`${NONCE}\nsweep\n${json}`)
}

const SWEEP_KINDS = {
  a: 'clean', // 候補・保持対象でない → 消す
  b: 'clean', // 候補だが状態ファイルで failed → 残す
  m: 'clean', // 候補だが monitoring → 残す
  c: 'locked', // remove --force が失敗 → unlock して消す
  d: 'broken', // remove が失敗 → 実パスを確かめて rm -rf
  e: 'plain-dir', // 登録されていない → 残す
  f: 'nested-broken', // メイン worktree の配下 → rm -rf しない
  g: 'symlink-main', // 実パスがメイン worktree → rm -rf しない
  h: 'clean', // 候補にない → 残す
  i: 'dirty', // 未コミットの変更があっても --force で消す（merge 済みの掃除のため）
  'j k': 'clean', // 半角スペースを含むパス
  n: 'missing', // 登録されているが実体が無い → git worktree remove --force が登録を消す（旧シェルでも remove の成功として扱われる）
}

function sweepSetup(repo) {
  writeState(repo, {
    2: { status: 'failed', worktree: repo.paths.b },
    3: { status: 'monitoring', worktree: repo.paths.m },
    4: { status: 'merged', worktree: repo.paths.a },
    5: { status: 'blocked', worktree: '' },
  })
  const cands = ['a', 'b', 'm', 'c', 'd', 'e', 'f', 'g', 'i', 'j k', 'n'].map((k) => repo.paths[k])
  return JSON.stringify([...cands, '', `${repo.root}/never-existed`])
}

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} worktree-cleanup.sh sweep: 旧シェルと同じものを消し、同じものを残す`, () => {
    const oldRepo = makeRepo(SWEEP_KINDS)
    const newRepo = makeRepo(SWEEP_KINDS)
    try {
      const oldRun = runOld(bash, oldRepo, OLD_SWEEP, [STATE, sweepSetup(oldRepo)])
      assert.equal(oldRun.status, 0, oldRun.stderr)
      const json = sweepSetup(newRepo)
      const r = runNew(bash, newRepo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, writeCandidates(newRepo, json)])
      assert.equal(r.status, 0, r.stderr)
      const a = snapshot(oldRepo)
      const b = snapshot(newRepo)
      assert.deepEqual(b, a)
      // 期待値そのもの（旧シェルの結果を固定する）
      assert.deepEqual(a.kinds, {
        a: 'none', b: 'dir', m: 'dir', c: 'none', d: 'none', e: 'dir', f: 'dir', g: 'symlink', h: 'dir', i: 'none', 'j k': 'none', n: 'none',
      })
      assert.ok(a.mainFiles.includes('a.txt'), 'メイン worktree は消えない')
      // 出力: REMOVED は実際に消したもの、RETAINED は状態ファイルの保持対象、最後に DONE <件数>
      const lines = r.stdout.trimEnd().split('\n')
      const removed = lines.filter((l) => l.startsWith('REMOVED ')).map((l) => l.slice('REMOVED '.length))
      assert.deepEqual(removed.sort(), ['a', 'c', 'd', 'i', 'j k', 'n'].map((k) => newRepo.paths[k]).sort())
      const retained = lines.filter((l) => l.startsWith('RETAINED ')).map((l) => l.slice('RETAINED '.length))
      assert.deepEqual(retained.sort(), [newRepo.paths.b, newRepo.paths.m].sort())
      assert.equal(lines.at(-1), 'DONE 6')
      for (const [reason, k] of [['retained', 'b'], ['unregistered', 'e'], ['refused', 'f'], ['refused', 'g']]) {
        assert.ok(lines.includes(`SKIPPED ${reason} ${newRepo.paths[k]}`), `${k}: SKIPPED ${reason}`)
      }
      assert.ok(!existsSync(join(newRepo.main, `${STATE}.sweep-${NONCE}.json`)), '候補ファイルは消す')
    } finally {
      oldRepo.done()
      newRepo.done()
    }
  })

  test(`${tag} worktree-cleanup.sh sweep: 照合の不一致・状態ファイルが読めないときは何も消さず非 0。候補ファイルは消す`, () => {
    const repo = makeRepo({ a: 'clean' })
    try {
      const json = JSON.stringify([repo.paths.a])
      writeState(repo, {})
      const before = snapshot(repo)
      // 内容の書き違い（照合値は正しい一覧のもの）
      const want = sha256(`${NONCE}\nsweep\n${json}`)
      writeFileSync(join(repo.main, `${STATE}.sweep-${NONCE}.json`), JSON.stringify([repo.paths.a, '/x']))
      let r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, want])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /一致しない/)
      assert.equal(r.stdout, '')
      assert.ok(!existsSync(join(repo.main, `${STATE}.sweep-${NONCE}.json`)))
      // 別の nonce 向けの照合値
      r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, sha256(`other\nsweep\n${json}`)])
      assert.equal(r.status, 1)
      writeCandidates(repo, json)
      r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, sha256(`${NONCE}\npatch\n${json}`)])
      assert.equal(r.status, 1, '束縛先が sweep でない照合値は通らない')
      // 状態ファイルが読めない（旧手順: 削除を一切行わない）
      writeFileSync(join(repo.main, STATE), '{not json')
      r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, writeCandidates(repo, json)])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /状態ファイルを読めない/)
      rmSync(join(repo.main, STATE))
      r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, writeCandidates(repo, json)])
      assert.equal(r.status, 1)
      assert.deepEqual(snapshot(repo), before)
      // 引数の誤り（exit 2）でも、状態ファイルと nonce の形式が正しければ候補ファイルを消す
      writeCandidates(repo, json)
      r = runNew(bash, repo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, 'XYZ'])
      assert.equal(r.status, 2)
      assert.ok(!existsSync(join(repo.main, `${STATE}.sweep-${NONCE}.json`)))
      for (const bad of [['sweep', '../x.json', NONCE, want], ['sweep', STATE, 'NONCE', want], ['sweep', STATE, NONCE], ['nope']]) {
        assert.equal(runNew(bash, repo, 'worktree-cleanup.sh', bad).status, 2, bad.join(' '))
      }
      assert.deepEqual(snapshot(repo), before)
    } finally {
      repo.done()
    }
  })

  test(`${tag} worktree-cleanup.sh remove: 旧シェルと同じものを消し、同じものを残す（1 件ずつ）`, () => {
    const cases = [
      ['clean', 'REMOVED', 0],
      ['locked', 'REMOVED', 0],
      ['broken', 'REMOVED', 0],
      ['dirty', 'REMOVED', 0],
      ['plain-dir', 'ABSENT', 0],
      ['missing', 'REMOVED', 0],
      ['nested-broken', 'REFUSED', 1],
      ['symlink-main', 'REFUSED', 1],
    ]
    for (const [kind, word, code] of cases) {
      const oldRepo = makeRepo({ w: kind, other: 'clean' })
      const newRepo = makeRepo({ w: kind, other: 'clean' })
      try {
        const o = runOld(bash, oldRepo, OLD_CLEANUP, [oldRepo.paths.w])
        assert.equal(o.status, 0, `${kind}: ${o.stderr}`)
        const r = runNew(bash, newRepo, 'worktree-cleanup.sh', ['remove', newRepo.paths.w])
        assert.equal(r.status, code, `${kind}: ${r.stderr}`)
        assert.equal(r.stdout, `${word} ${newRepo.paths.w}\n`, kind)
        assert.deepEqual(snapshot(newRepo), snapshot(oldRepo), kind)
        assert.equal(snapshot(newRepo).kinds.other, 'dir', `${kind}: 対象以外は消さない`)
      } finally {
        oldRepo.done()
        newRepo.done()
      }
    }
  })

  // cwd の git rev-parse --show-toplevel はリンク worktree を指すので、メイン worktree の配下の判定は porcelain の先頭の実パスでも行う。
  // 旧シェルは toplevel だけで判定していたため、リンク worktree の中から起動されるとメイン worktree の配下を消していた（強化した点）
  test(`${tag} worktree-cleanup.sh: リンク worktree の中から起動されても、メイン worktree の配下は消さない（remove・sweep）`, () => {
    const kinds = { l: 'clean', f: 'nested-broken', d: 'broken' }
    const oldRepo = makeRepo(kinds)
    const newRepo = makeRepo(kinds)
    const inLinked = (repo, script, args) => spawnSync(bash, [join(SCRIPTS, script), ...args], { cwd: repo.paths.l, encoding: 'utf8' })
    try {
      // 旧シェルは同じ条件でメイン worktree の配下を消す（この差を閉じたことの確認）
      const o = spawnSync(bash, ['-c', OLD_CLEANUP, 'old', oldRepo.paths.f], { cwd: oldRepo.paths.l, encoding: 'utf8' })
      assert.equal(o.status, 0, o.stderr)
      assert.equal(snapshot(oldRepo).kinds.f, 'none')

      let r = inLinked(newRepo, 'worktree-cleanup.sh', ['remove', newRepo.paths.f])
      assert.equal(r.status, 1, r.stderr)
      assert.equal(r.stdout, `REFUSED ${newRepo.paths.f}\n`)
      assert.equal(snapshot(newRepo).kinds.f, 'dir')

      // sweep: 状態ファイルと候補ファイルはリンク worktree の cwd からの相対パスで置く
      mkdirSync(join(newRepo.paths.l, '_', 'issue-trees'), { recursive: true })
      writeFileSync(join(newRepo.paths.l, STATE), JSON.stringify({ parent: 1, items: {} }))
      const json = JSON.stringify([newRepo.paths.f, newRepo.paths.d])
      writeFileSync(join(newRepo.paths.l, `${STATE}.sweep-${NONCE}.json`), `${json}\n`)
      r = inLinked(newRepo, 'worktree-cleanup.sh', ['sweep', STATE, NONCE, sha256(`${NONCE}\nsweep\n${json}`)])
      assert.equal(r.status, 0, r.stderr)
      const lines = r.stdout.trimEnd().split('\n')
      assert.ok(lines.includes(`SKIPPED refused ${newRepo.paths.f}`), r.stdout)
      assert.ok(lines.includes(`REMOVED ${newRepo.paths.d}`), 'メイン worktree の配下でないものは従来どおり消す')
      const after = snapshot(newRepo)
      assert.equal(after.kinds.f, 'dir')
      assert.equal(after.kinds.d, 'none')
      assert.ok(after.mainFiles.includes('a.txt'))
    } finally {
      oldRepo.done()
      newRepo.done()
    }
  })

  test(`${tag} worktree-cleanup.sh remove: メイン worktree 自身は消さない。半角スペースを含むパスを扱える。形式の誤りは exit 2`, () => {
    const repo = makeRepo({ 'w x': 'clean' })
    try {
      const before = snapshot(repo)
      const r = runNew(bash, repo, 'worktree-cleanup.sh', ['remove', repo.main])
      assert.equal(r.status, 1)
      assert.equal(r.stdout, `REFUSED ${repo.main}\n`)
      assert.deepEqual(snapshot(repo), before)
      for (const bad of [['remove'], ['remove', 'relative/x'], ['remove', `${repo.root}/../x`], ['remove', `${repo.root}/x;rm`], ['remove', `${repo.root}/$(id)`], ['remove', '/a', '/b']]) {
        assert.equal(runNew(bash, repo, 'worktree-cleanup.sh', bad).status, 2, bad.join(' '))
      }
      assert.deepEqual(snapshot(repo), before)
      const s = runNew(bash, repo, 'worktree-cleanup.sh', ['remove', repo.paths['w x']])
      assert.equal(s.status, 0, s.stderr)
      assert.equal(snapshot(repo).kinds['w x'], 'none')
    } finally {
      repo.done()
    }
  })

  test(`${tag} worktree-cleanup.sh delete-branch: 旧シェルと同じ結果（あれば消す・無ければ何もしない・checkout 中なら失敗）`, () => {
    for (const [branch, word, code] of [['feat/x', 'DELETED', 0], ['feat/none', 'ABSENT', 0], ['feat/w', 'FAILED', 1]]) {
      const oldRepo = makeRepo({ w: 'clean' })
      const newRepo = makeRepo({ w: 'clean' })
      try {
        for (const repo of [oldRepo, newRepo]) git(repo.main, 'branch', 'feat/x')
        runOld(bash, oldRepo, OLD_DELETE_BRANCH, [branch])
        const r = runNew(bash, newRepo, 'worktree-cleanup.sh', ['delete-branch', branch])
        assert.equal(r.status, code, `${branch}: ${r.stderr}`)
        assert.equal(r.stdout, `${word} ${branch}\n`)
        assert.deepEqual(snapshot(newRepo), snapshot(oldRepo), branch)
      } finally {
        oldRepo.done()
        newRepo.done()
      }
    }
    const repo = makeRepo({})
    try {
      for (const bad of [['delete-branch'], ['delete-branch', '-D'], ['delete-branch', 'a..b'], ['delete-branch', 'a b'], ['delete-branch', 'feat/*']]) {
        assert.equal(runNew(bash, repo, 'worktree-cleanup.sh', bad).status, 2, bad.join(' '))
      }
    } finally {
      repo.done()
    }
  })

  test(`${tag} discard-safety.sh: 旧シェルと同じ worktreeMissing・dirty・aheadCount を出す`, () => {
    const repo = makeRepo({ clean: 'clean', dirty: 'dirty', ahead: 'ahead', plain: 'plain-dir', gone: 'missing' })
    try {
      const cases = [
        ['', ''],
        [repo.paths.clean, 'feat/clean'],
        [repo.paths.dirty, 'feat/dirty'],
        [repo.paths.ahead, 'feat/ahead'],
        [repo.paths.plain, 'feat/none'],
        [repo.paths.gone, ''],
        ['', 'feat/ahead'],
      ]
      for (const [p, b] of cases) {
        const o = runOld(bash, repo, OLD_DISCARD, [p, b, 'main'])
        assert.equal(o.status, 0, o.stderr)
        const r = runNew(bash, repo, 'discard-safety.sh', [p || '-', b || '-', 'main'])
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.stdout, o.stdout, `${p} ${b}`)
      }
      // 値そのもの（旧シェルの結果を固定する）
      assert.equal(runNew(bash, repo, 'discard-safety.sh', [repo.paths.dirty, '-', 'main']).stdout, 'WORKTREE_MISSING false\nDIRTY true\nAHEAD -1\n')
      assert.equal(runNew(bash, repo, 'discard-safety.sh', [repo.paths.ahead, 'feat/ahead', 'main']).stdout, 'WORKTREE_MISSING false\nDIRTY false\nAHEAD 2\n')
      assert.equal(runNew(bash, repo, 'discard-safety.sh', [repo.paths.plain, '-', 'main']).stdout, 'WORKTREE_MISSING true\nDIRTY false\nAHEAD -1\n')
      // 読み取りだけ: 観測の前後で何も変わらない
      const before = snapshot(repo)
      runNew(bash, repo, 'discard-safety.sh', [repo.paths.dirty, 'feat/dirty', 'main'])
      assert.deepEqual(snapshot(repo), before)
      for (const bad of [[], ['-', '-'], ['relative', '-', 'main'], ['-', 'a..b', 'main'], ['-', '-', '-main'], ['-', '-', 'ma in']]) {
        assert.equal(runNew(bash, repo, 'discard-safety.sh', bad).status, 2, bad.join(' '))
      }
    } finally {
      repo.done()
    }
  })

  test(`${tag} discard-safety.sh: git worktree list が失敗したら確認できなかったものとして dirty: true（安全側）`, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iit-noreop-')))
    try {
      const r = spawnSync(bash, [join(SCRIPTS, 'discard-safety.sh'), `${dir}/wt`, '-', 'main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'WORKTREE_MISSING false\nDIRTY true\nAHEAD -1\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// --- ホストが組み立てたコマンドをそのまま流す ---

// 定義部を読み込み、agent を記録用の stub にする（状態の書き込みは成功、nonce の seed は固定値を返す）
const hostPrompts = new Map()
globalThis.agent = async (prompt, opts) => {
  const label = String(opts?.label ?? '')
  hostPrompts.set(label.replace(/:#\d+$/, ''), String(prompt))
  if (label === 'nonce:seed') return { seedHex: 'c'.repeat(64) }
  if (label === 'worktree:sweep') return { removed: [] }
  if (label.startsWith('discard-safety')) return { dirty: true }
  return { ok: true }
}
globalThis.log = () => {}
globalThis.phase = () => {}
const defsDir = mkdtempSync(join(tmpdir(), 'iit-cleanup-defs-'))
writeFileSync(
  join(defsDir, 'defs.mjs'),
  `const args = ${JSON.stringify(BASE_ARGS)}\n${definitionPart}\nexport { ensureBoundaryNonceSeed, updateStateDetailed, verifyDiscardSafety, sweepClosedWorktrees }\n`,
)
const host = await import(pathToFileURL(join(defsDir, 'defs.mjs')).href)
await host.ensureBoundaryNonceSeed()

// プロンプト中の「run-verified.sh 経由の 1 コマンド」を、同じ引数でスクリプトを直接起動するコマンドに置き換えて流す
// （開発ファイルの期待ハッシュは置換前の目印なので launcher は通らない。引数の引用はプロンプトの文字列のまま bash が解釈する）
function runHostCommand(repo, prompt, script) {
  const line = prompt.split('\n').find((l) => l.includes(` ${script} `))
  assert.ok(line, `${script} のコマンドがプロンプトに無い`)
  const m = new RegExp(`run-verified\\.sh' \\S+ ${script.replace('.', '\\.')}(.*)$`).exec(line)
  assert.ok(m, line)
  return spawnSync('/bin/bash', ['-c', `bash '${join(SCRIPTS, script)}'${m[1]}`], { cwd: repo.main, encoding: 'utf8' })
}

test('ホストのコマンド: 掃除（半角スペースを含むパス・ブランチ削除）・破棄前の観測・スイープを、組み立てたとおりに流せる', async () => {
  const repo = makeRepo({ 'w x': 'clean', dirty: 'dirty', a: 'clean' })
  try {
    // state:cleanup（Recover の破棄: worktree を消してからブランチを消す）
    await host.updateStateDetailed(5, { status: 'pending', branch: 'feat/w-x' }, { cleanupWorktree: repo.paths['w x'], deleteBranch: true })
    const cleanup = hostPrompts.get('state:cleanup')
    assert.ok(cleanup, '掃除のプロンプトが組み立てられていない')
    assert.ok(cleanup.indexOf(' remove ') < cleanup.indexOf(' delete-branch '), 'worktree の削除がブランチの削除より先')
    const removeLine = cleanup.split('\n').find((l) => l.includes('worktree-cleanup.sh remove'))
    let r = spawnSync('/bin/bash', ['-c', `bash '${join(SCRIPTS, 'worktree-cleanup.sh')}'${/worktree-cleanup\.sh( remove .*)$/.exec(removeLine)[1]}`], { cwd: repo.main, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `REMOVED ${repo.paths['w x']}\n`)
    r = spawnSync('/bin/bash', ['-c', `bash '${join(SCRIPTS, 'worktree-cleanup.sh')}'${/worktree-cleanup\.sh( delete-branch .*)$/.exec(cleanup.split('\n').find((l) => l.includes('delete-branch')))[1]}`], { cwd: repo.main, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'DELETED feat/w-x\n')

    // discard-safety
    await host.verifyDiscardSafety(5, repo.paths.dirty, 'feat/dirty')
    r = runHostCommand(repo, hostPrompts.get('discard-safety'), 'discard-safety.sh')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'WORKTREE_MISSING false\nDIRTY true\nAHEAD 0\n')

    // worktree:sweep（候補一覧は agent が Write ツールで書く。ここではプロンプトの JSON 行をそのまま書く）
    writeState(repo, { 9: { status: 'blocked', worktree: repo.paths.dirty } })
    await host.sweepClosedWorktrees([repo.paths.a, repo.paths.dirty])
    const sweep = hostPrompts.get('worktree:sweep')
    const json = sweep.split('\n').find((l) => l.startsWith('["'))
    const file = /の (_\/issue-trees\/1\.json\.sweep-[0-9a-z]+\.json) に/.exec(sweep)[1]
    writeFileSync(join(repo.main, file), `${json}\n`)
    r = runHostCommand(repo, sweep, 'worktree-cleanup.sh')
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.trimEnd().split('\n')
    assert.ok(lines.includes(`REMOVED ${repo.paths.a}`), r.stdout)
    assert.ok(lines.includes(`SKIPPED retained ${repo.paths.dirty}`), r.stdout)
    assert.ok(lines.includes(`RETAINED ${repo.paths.dirty}`), r.stdout)
    assert.ok(!existsSync(join(repo.main, file)), '候補ファイルは消す')
    assert.deepEqual(Object.fromEntries(Object.entries(snapshot(repo).kinds)), { 'w x': 'none', dirty: 'dir', a: 'none' })
  } finally {
    repo.done()
    rmSync(defsDir, { recursive: true, force: true })
  }
})
