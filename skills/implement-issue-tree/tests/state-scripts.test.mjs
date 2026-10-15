// 状態ファイルを扱う同梱スクリプト（scripts/state-verify.sh・state-read.sh と、state.sh のうち入力ファイル・create・
// clear-worktree の経路）を実際に実行する回帰テスト（利用側のリポジトリで観測した権限確認によるランの停止への対応:
// agent のプロンプトにシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる。JSON はコマンド行に載せない）。
// state.sh の標準入力の経路・hw-max / hw-set・並行書き込みの検知は upstream の state-script.test.mjs が見る。
//
// 検証する契約（ホストの照合は変えていないので、スクリプトは旧プロンプトのシェルと同じ出力・同じ書き込みをする）:
//   - state-verify.sh の出力は、2 行目（高水位。HIGHWATER bytes=<n> version=<n> のラベル付きにした）を除いて
//     旧プロンプトの 1 行のシェル（下の LEGACY_VERIFY）とバイト単位で同じ。行範囲の分割実行も同じ
//   - その先頭 2 行をそのまま返すと、ホストの分解（parseStateVerifyHeader）と照合（keysSha256・keysCount・高水位・
//     項目ごとの hashes）が成立する
//   - state-read.sh summary は OK count=<件数> bytes=<高水位> version=<版>（ラベル付き）を出し、create の出力と合わせてホストが分解する
//   - state-read.sh keys の出力は旧プロンプトの jq -c --argjson k ... と同じ値
//   - state.sh の入力ファイルの経路は、ホストが渡した SHA-256（nonce とモードを束縛）と一致するときだけ書き、入力ファイルは成否に関わらず消す
//   - state.sh create / clear-worktree は旧プロンプトと同じ内容を書く。create は既存のファイルを上書きしない
//   - 不正な引数（.. を含むパス・0 の番号・大文字の nonce・短いハッシュ）は exit 2 で何も書かない
//
// CI は Linux（GNU）、手元は macOS（BSD userland・/bin/bash は 3.2）。利用できる bash をすべて回す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { importDefinitions } from './lib/stub-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const SAMPLE = readFileSync(join(HERE, '..', 'sample', 'state-example.json'), 'utf8')
const BASHES = availableBashes()
const { sha256Hex, canonicalJson, verifyLoadedItems, stateInputSha256, parseStateVerifyHeader, isValidStateVerifyResult, parseStateLoadSummary } = await importDefinitions(
  ['sha256Hex', 'canonicalJson', 'verifyLoadedItems', 'stateInputSha256', 'parseStateVerifyHeader', 'isValidStateVerifyResult', 'parseStateLoadSummary'],
  'state-scripts',
)

// 旧プロンプト（state:load-verify）がエージェントに実行させていたシェル。f= の値だけを位置引数に置き換えた。
const LEGACY_VERIFY = String.raw`f=$1; h() { sha256sum 2>/dev/null || shasum -a 256; }; if [ -f "$f" ]; then K='[.items // {} | keys[] | select(test("^[1-9][0-9]*$"))]'; echo "KEYS $(jq -jc "$K" "$f" | h | cut -c1-64) $(jq "$K | length" "$f")"; jq -c '[.perWorktreeByteReserveHighWater // 0, .perWorktreeByteReserveHighWaterVersion // 0]' "$f"; jq -r "$K | .[]" "$f" | sed -n "@R@p" | while IFS= read -r k; do printf '%s %s\n' "$k" "$(jq -jcS --arg k "$k" '.items[$k]' "$f" | h | cut -c1-64)"; done; else echo NOFILE; fi`
  // テンプレートの ${...} と衝突するため、旧コマンドの "${R:-1,\$}" は後から差し込む
  .replace('@R@', '${R:-1,\\$}')
// 旧コマンドとの違いは 2 行目だけ: 旧 [<高水位>,<版>] を HIGHWATER bytes=<高水位> version=<版> にした
// （ラベルの無い配列を、小さいモデルが位置を取り違えて転記したため。Issue #23）。
const labelHighWater = (out) => {
  const lines = out.split('\n')
  if (lines[0].startsWith('KEYS ')) {
    const [b, v] = JSON.parse(lines[1])
    lines[1] = `HIGHWATER bytes=${b} version=${v}`
  }
  return lines.join('\n')
}

// 旧プロンプトの書き込み（jq の式）。updatedAt は呼び出しごとに変わるので固定値を渡し、比較では除く。
const TS = '2026-01-01T00:00:00Z'
const legacyJq = (file, args) => {
  const r = spawnSync('jq', [...args, file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

function run(bash, script, args, { cwd } = {}) {
  return spawnSync(bash, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd })
}

function withWork(fn) {
  const work = mkdtempSync(join(tmpdir(), 'iit-state-'))
  try {
    return fn(work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const stripTs = (o) => {
  const { updatedAt: _ts, ...rest } = o
  return rest
}

// 状態ファイルのある作業ディレクトリ。cwd 相対の _/issue-trees/<parent>.json（ホストが渡す形）で置く。
function seed(work, body, parent = 7) {
  mkdirSync(join(work, '_', 'issue-trees'), { recursive: true })
  const rel = `_/issue-trees/${parent}.json`
  writeFileSync(join(work, rel), body)
  return rel
}

const OK = 'STATE_RESULT {"ok":true}\n'
const ng = (reason) => `STATE_RESULT {"ok":false,"reason":"${reason}"}\n`
// state.sh の入力ファイルの経路の引数
const inputArgs = (rel, mode, nonce, sha) => ['--file', rel, mode, '--input-nonce', nonce, '--input-sha', sha]

const MIXED = JSON.stringify({
  parent: 7,
  perWorktreeByteReserveHighWater: 5489787,
  perWorktreeByteReserveHighWaterVersion: 2,
  items: {
    1000: { status: 'blocked', note: 'DEL\u007f と 日本語 と 絵文字 😀', pr: 0 },
    42: { status: 'monitoring', pr: 7, z: 1, a: [3, 2] },
    abc: { status: 'x' },
    '0': { status: 'zero' },
    9: {},
  },
}, null, 2)

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} state-verify.sh の出力は、高水位の行（HIGHWATER bytes=<n> version=<n>）を除いて旧プロンプトのシェルとバイト単位で同じ（ファイルなし・サンプル・混在キー・空 items・行範囲）`, () => {
    withWork((work) => {
      const cases = [
        ['nofile', null],
        ['sample', SAMPLE],
        ['mixed', MIXED],
        ['empty', JSON.stringify({ items: {} })],
        ['noitems', JSON.stringify({ parent: 1 })],
      ]
      for (const [i, [name, body]] of cases.entries()) {
        const rel = `_/issue-trees/${i + 1}.json`
        mkdirSync(join(work, '_', 'issue-trees'), { recursive: true })
        if (body !== null) writeFileSync(join(work, rel), body)
        const legacy = spawnSync(bash, ['-c', LEGACY_VERIFY, '_', rel], { encoding: 'utf8', cwd: work })
        const now = run(bash, 'state-verify.sh', [rel], { cwd: work })
        assert.equal(now.status, 0, now.stderr)
        assert.equal(now.stdout, labelHighWater(legacy.stdout), name)
        // 行範囲（キー行だけを分割）。旧コマンドの R=2,3 と新しい引数 2 3 が同じ
        const legacyR = spawnSync(bash, ['-c', LEGACY_VERIFY, '_', rel], { encoding: 'utf8', cwd: work, env: { ...process.env, R: '2,3' } })
        const nowR = run(bash, 'state-verify.sh', [rel, '2', '3'], { cwd: work })
        assert.equal(nowR.stdout, labelHighWater(legacyR.stdout), `${name} 範囲`)
      }
    })
  })

  test(`${tag} state-verify.sh の先頭 2 行をそのまま返すと、ホストの分解と照合（keysSha256・keysCount・高水位・hashes）が成立する`, () => {
    withWork((work) => {
      const rel = seed(work, MIXED)
      const out = run(bash, 'state-verify.sh', [rel], { cwd: work }).stdout.trimEnd().split('\n')
      const head = parseStateVerifyHeader(out.slice(0, 2).join('\n'))
      assert.ok(head, out.slice(0, 2).join('\n'))
      const hashes = Object.fromEntries(out.slice(2).map((l) => l.split(' ')))
      assert.equal(sha256Hex(canonicalJson(Object.keys(hashes).sort())), head.keysSha256)
      assert.equal(Object.keys(hashes).length, head.keysCount)
      assert.deepEqual([head.highWaterBytes, head.highWaterVersion], [5489787, 2])
      assert.equal(isValidStateVerifyResult({ headerLines: out.slice(0, 2).join('\n'), hashes }), true)
      const items = JSON.parse(MIXED).items
      const numeric = Object.fromEntries(Object.entries(items).filter(([k]) => /^[1-9]\d*$/.test(k)))
      const v = verifyLoadedItems(numeric, { fileExists: true, hashes })
      assert.equal(v.verified, true)
      assert.deepEqual(Object.keys(v.adopted).sort(), ['1000', '42', '9'])
    })
  })

  test(`${tag} 新規のツリー: state.sh create が作った状態ファイルの state-verify.sh の出力は、ホストが高水位 0・版 2 に分解する（Issue #23 の再現）`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/23.json'
      assert.equal(run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '3', '--version', '2'], { cwd: work }).stdout, OK)
      const r = run(bash, 'state-verify.sh', [rel], { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'KEYS 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945 0\nHIGHWATER bytes=0 version=2\n')
      assert.deepEqual(parseStateVerifyHeader(r.stdout), {
        fileExists: true,
        keysSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        keysCount: 0,
        highWaterBytes: 0,
        highWaterVersion: 2,
      })
      // ファイルなしは NOFILE の 1 行で、ホストは fileExists: false に分解する
      const none = run(bash, 'state-verify.sh', ['_/issue-trees/24.json'], { cwd: work })
      assert.equal(parseStateVerifyHeader(none.stdout).fileExists, false)
    })
  })

  test(`${tag} 新規のツリー: state-read.sh summary（NOFILE）・state.sh create（STATE_RESULT ok）・作成後の summary の出力をそのまま返すと、ホストが版 2 に分解する`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/23.json'
      const before = run(bash, 'state-read.sh', ['summary', rel], { cwd: work }).stdout
      const created = run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '3', '--version', '2'], { cwd: work }).stdout
      assert.deepEqual(parseStateLoadSummary(before, created, false), { ok: true, fileExisted: false, count: 0, highWaterBytes: 0, highWaterVersion: 2 })
      // 既にある（already-exists）など ok: false の結果の行は初期化の失敗に分解する
      const again = run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '3', '--version', '2'], { cwd: work }).stdout
      assert.equal(again, ng('already-exists'))
      assert.deepEqual(parseStateLoadSummary(before, again, false), { ok: false, fileExisted: false, count: 0, highWaterBytes: 0, highWaterVersion: 0 })
      const after = run(bash, 'state-read.sh', ['summary', rel], { cwd: work }).stdout
      assert.equal(after, 'OK count=0 bytes=0 version=2\n')
      assert.deepEqual(parseStateLoadSummary(after, '', false), { ok: true, fileExisted: true, count: 0, highWaterBytes: 0, highWaterVersion: 2 })
    })
  })

  test(`${tag} state-read.sh: summary は NOFILE / PARSE_ERROR / OK count=<件数> bytes=<高水位> version=<版>、range はキー順の範囲、keys は旧コマンドと同じ値`, () => {
    withWork((work) => {
      assert.equal(run(bash, 'state-read.sh', ['summary', '_/issue-trees/1.json'], { cwd: work }).stdout, 'NOFILE\n')
      const bad = seed(work, '{ not json', 2)
      assert.equal(run(bash, 'state-read.sh', ['summary', bad], { cwd: work }).stdout, 'PARSE_ERROR\n')
      const rel = seed(work, MIXED)
      // 旧形式 OK <件数> <高水位> <版> をラベル付きにした（読込エージェントに位置で数値を分解させないため。Issue #23 と同じ方式）
      assert.equal(run(bash, 'state-read.sh', ['summary', rel], { cwd: work }).stdout, 'OK count=5 bytes=5489787 version=2\n')
      const keysOrder = Object.keys(JSON.parse(spawnSync('jq', ['-c', '.items', join(work, rel)], { encoding: 'utf8' }).stdout)).sort()
      const r = JSON.parse(run(bash, 'state-read.sh', ['range', rel, '2', '3'], { cwd: work }).stdout)
      assert.deepEqual(Object.keys(r).sort(), keysOrder.slice(1, 3).sort())
      assert.deepEqual(JSON.parse(run(bash, 'state-read.sh', ['range', rel, '9', '12'], { cwd: work }).stdout), {})
      const legacy = legacyJq(join(work, rel), ['-c', '--argjson', 'k', '["42","1000","77"]', '.items | with_entries(select(.key as $x | $k | index($x)))'])
      const now = JSON.parse(run(bash, 'state-read.sh', ['keys', rel, '42', '1000', '77'], { cwd: work }).stdout)
      assert.deepEqual(now, legacy)
      // 数値以外のキー・コマンド片は受理しない
      for (const k of ['abc', '0', '1;rm', '__proto__']) assert.equal(run(bash, 'state-read.sh', ['keys', rel, k], { cwd: work }).status, 2, k)
    })
  })

  test(`${tag} state.sh create: ディレクトリと初期 JSON（旧プロンプトと同じ内容）を作り、既にあれば already-exists で上書きしない`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/860.json'
      const r = run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '3', '--version', '2'], { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, OK)
      const legacy = { parent: 860, baseBranch: 'main', parallel: 3, updatedAt: '', perWorktreeByteReserveHighWater: 0, perWorktreeByteReserveHighWaterVersion: 2, items: {} }
      assert.deepEqual(JSON.parse(readFileSync(join(work, rel), 'utf8')), legacy)
      writeFileSync(join(work, rel), '{"keep":true}')
      const again = run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '3', '--version', '2'], { cwd: work })
      assert.equal(again.status, 0)
      assert.equal(again.stdout, ng('already-exists'))
      assert.equal(readFileSync(join(work, rel), 'utf8'), '{"keep":true}')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['860.json'], '一時ファイルを残さない')
    })
  })

  test(`${tag} state.sh create: 置き先は ln で作り、[ -e ] の検査のあとに現れたものも上書きしない`, () => {
    withWork((work) => {
      // [ -e ] では「無い」と見えるが名前は使われている状態（壊れたシンボリックリンク）で、ln の失敗に倒れることを確かめる
      mkdirSync(join(work, '_', 'issue-trees'), { recursive: true })
      const rel = '_/issue-trees/5.json'
      symlinkSync('nowhere.json', join(work, rel))
      const r = run(bash, 'state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '1', '--version', '2'], { cwd: work })
      assert.equal(r.stdout, ng('already-exists'))
      assert.equal(readlinkSync(join(work, rel)), 'nowhere.json', '既存の名前を置き換えない')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['5.json'], '一時ファイルを残さない')
    })
  })

  test(`${tag} state.sh merge（入力ファイル）: 標準入力の経路と同じ結果を書き、入力ファイルを消す。中身をシェルで評価しない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const groups = JSON.stringify([{ numbers: [44], patch: { status: 'blocked', note: "it's \"quoted\" $(touch x) `y` 日本語", pr: 0, lastUnresolvedComments: [{ a: 1 }] } }, { numbers: [43, 300], patch: { note: 'n' } }])
      const nonce = 'k3x9a0b1c2d4e5f6g7h8i9j0k1l2'
      writeFileSync(join(work, `${rel}.input-${nonce}.json`), `${groups}\n`) // Write ツールが末尾に改行を足しても同じ
      const legacyFile = join(work, 'legacy.json')
      writeFileSync(legacyFile, SAMPLE)
      writeFileSync(join(work, 'g.json'), groups)
      const legacy = legacyJq(legacyFile, ['--slurpfile', 'groups', join(work, 'g.json'), '--arg', 'ts', TS, 'reduce $groups[0][] as $g (.; reduce $g.numbers[] as $n (.; .items[($n|tostring)] = ((.items[($n|tostring)] // {}) + $g.patch))) | .updatedAt = $ts'])
      const r = run(bash, 'state.sh', inputArgs(rel, 'merge', nonce, stateInputSha256(nonce, 'merge', groups)), { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, OK)
      const now = JSON.parse(readFileSync(join(work, rel), 'utf8'))
      assert.deepEqual(stripTs(now), stripTs(legacy))
      assert.match(now.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      assert.equal(existsSync(join(work, 'x')), false, '入力の中身をシェルで評価しない')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'], '入力ファイル・一時ファイルを残さない')
    })
  })

  test(`${tag} state.sh init（入力ファイル）: 無い項目だけを pending で足す`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const entries = JSON.stringify([{ number: 42, type: 'verify-close' }, { number: 46, type: 'implement' }])
      const nonce = 'i1'
      writeFileSync(join(work, `${rel}.input-${nonce}.json`), entries)
      const legacyFile = join(work, 'legacy.json')
      writeFileSync(legacyFile, SAMPLE)
      const legacy = legacyJq(legacyFile, ['--argjson', 'entries', entries, 'reduce $entries[] as $e (.; if .items[($e.number|tostring)] == null then .items[($e.number|tostring)] = {"type":$e.type,"status":"pending","pr":0,"branch":"","worktree":"","fixCount":0,"note":""} else . end) | .updatedAt = $ts', '--arg', 'ts', TS])
      const r = run(bash, 'state.sh', inputArgs(rel, 'init', nonce, stateInputSha256(nonce, 'init', entries)), { cwd: work })
      assert.equal(r.stdout, OK, r.stderr)
      assert.deepEqual(stripTs(JSON.parse(readFileSync(join(work, rel), 'utf8'))), stripTs(legacy))
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
    })
  })

  test(`${tag} state.sh（入力ファイル）: 内容がホストの SHA-256 と違う・入力ファイルが無いときは書かずに失敗し、入力ファイルを消す`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const before = readFileSync(join(work, rel), 'utf8')
      const groups = JSON.stringify([{ numbers: [44], patch: { status: 'blocked' } }])
      const nonce = 'abc123'
      writeFileSync(join(work, `${rel}.input-${nonce}.json`), JSON.stringify([{ numbers: [44], patch: { status: 'merged' } }])) // 写し間違い
      const r = run(bash, 'state.sh', inputArgs(rel, 'merge', nonce, stateInputSha256(nonce, 'merge', groups)), { cwd: work })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, ng('input-mismatch'))
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
      const missing = run(bash, 'state.sh', inputArgs(rel, 'merge', nonce, stateInputSha256(nonce, 'merge', groups)), { cwd: work })
      assert.equal(missing.stdout, ng('input-missing'))
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
    })
  })

  test(`${tag} state.sh（入力ファイル）: 照合値は nonce とモードに束縛され、別の nonce・別のモード・束縛しない値への流用は書かない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const before = readFileSync(join(work, rel), 'utf8')
      const groups = JSON.stringify([{ numbers: [44], patch: { status: 'blocked' } }])
      // ホストの照合値はスクリプトと同じ定義（nonce + 改行 + モード + 改行 + JSON）
      assert.equal(stateInputSha256('n1', 'merge', groups), sha256Hex(`n1\nmerge\n${groups}`))
      const attempts = [
        ['merge', 'n2', stateInputSha256('n1', 'merge', groups)], // 別の呼び出し（nonce）向け
        ['init', 'n1', stateInputSha256('n1', 'merge', groups)], // 別のモード向け
        ['merge', 'n1', sha256Hex(groups)], // 束縛しない値
      ]
      for (const [mode, nonce, sha] of attempts) {
        writeFileSync(join(work, `${rel}.input-${nonce}.json`), groups)
        const r = run(bash, 'state.sh', inputArgs(rel, mode, nonce, sha), { cwd: work })
        assert.equal(r.stdout, ng('input-mismatch'), `${mode} ${nonce}`)
      }
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
    })
  })

  test(`${tag} state.sh（入力ファイル）: 引数の誤り（exit 2）でも入力ファイルを消す。nonce が不正なら何も消さない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const pf = (n) => join(work, `${rel}.input-${n}.json`)
      const cases = [
        ['--file', rel, 'merge', '--input-nonce', 'abc', '--input-sha', 'short'],
        ['--file', rel, 'merge', '--input-nonce', 'abc'],
        ['--file', rel, 'init', '--input-nonce', 'abc', '--input-sha', 'A'.repeat(64)],
      ]
      for (const args of cases) {
        writeFileSync(pf('abc'), '[]')
        const r = run(bash, 'state.sh', args, { cwd: work })
        assert.equal(r.status, 2, args.join(' '))
        assert.equal(existsSync(pf('abc')), false, `入力ファイルが残る: ${args.join(' ')}`)
      }
      // nonce が不正（パスを組み立てられない）なら消さない
      writeFileSync(pf('ABC'), '[]')
      assert.equal(run(bash, 'state.sh', inputArgs(rel, 'merge', 'ABC', 'a'.repeat(64)), { cwd: work }).status, 2)
      assert.equal(existsSync(pf('ABC')), true)
      // 入力ファイルは merge / init だけ
      assert.equal(run(bash, 'state.sh', ['--file', rel, 'hw-set', '--bytes', '1', '--version', '2', '--input-nonce', 'abc', '--input-sha', 'a'.repeat(64)], { cwd: work }).status, 2)
      assert.equal(readFileSync(join(work, rel), 'utf8'), SAMPLE)
    })
  })

  test(`${tag} state.sh（入力ファイル）: 照合と読み込みは同じ写しに対して行う（元ファイルを直接読まない）`, () => {
    const src = readFileSync(join(SCRIPTS, 'state.sh'), 'utf8')
    assert.match(src, /cp -- "\$\{in_src\}" "\$\{pf\}"/)
    assert.match(src, /body=\$\(cat -- "\$\{pf\}"\)/)
    assert.doesNotMatch(src, /cat -- "\$\{in_src\}"/)
  })

  test(`${tag} state.sh clear-worktree: 旧プロンプトの jq と同じ結果を書く。状態ファイルが無い・壊れているときは書かない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const legacyFile = join(work, 'legacy.json')
      writeFileSync(legacyFile, SAMPLE)
      const legacy = legacyJq(legacyFile, ['--argjson', 'patch', '{"worktree":""}', '.items["44"] = ((.items["44"] // {}) + $patch) | .updatedAt = $ts', '--arg', 'ts', TS])
      const r = run(bash, 'state.sh', ['--file', rel, 'clear-worktree', '--issue', '44'], { cwd: work })
      assert.equal(r.stdout, OK, r.stderr)
      assert.deepEqual(stripTs(JSON.parse(readFileSync(join(work, rel), 'utf8'))), stripTs(legacy))
      assert.equal(run(bash, 'state.sh', ['--file', '_/issue-trees/8.json', 'clear-worktree', '--issue', '1'], { cwd: work }).stdout, ng('no-file'))
      const broken = seed(work, '{ broken', 9)
      assert.equal(run(bash, 'state.sh', ['--file', broken, 'clear-worktree', '--issue', '1'], { cwd: work }).stdout, ng('rewrite-failed'))
      assert.equal(readFileSync(join(work, broken), 'utf8'), '{ broken')
    })
  })

  test(`${tag} 不正な引数は exit 2 で何も書かない（パスの ..・番号 0・大文字の nonce・短いハッシュ・未知のモード）`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const sha = 'a'.repeat(64)
      const bad = [
        ['state.sh', inputArgs('_/../x.json', 'merge', 'abc', sha)],
        ['state.sh', inputArgs(rel, 'merge', 'abc', 'abc')],
        ['state.sh', ['--file', rel, 'clear-worktree', '--issue', '1;rm']],
        ['state.sh', ['--file', rel, 'clear-worktree', '--issue', '0']],
        ['state.sh', ['--file', rel, 'create', '--base', 'main branch', '--parallel', '1', '--version', '2']],
        ['state.sh', ['--file', rel, 'create', '--base', 'main', '--parallel', '0', '--version', '2']],
        ['state.sh', ['--file', rel, 'nope']],
        ['state.sh', ['--file', 'x.json', 'clear-worktree', '--issue', '1']],
        ['state-verify.sh', ['_//a.json']],
        ['state-verify.sh', [rel, '0', '2']],
        ['state-read.sh', ['range', rel, '1']],
      ]
      for (const [script, args] of bad) {
        const r = run(bash, script, args, { cwd: work })
        assert.equal(r.status, 2, `${script} ${args.join(' ')}`)
        assert.equal(r.stdout, '', `${script} ${args.join(' ')}`)
      }
      assert.equal(readFileSync(join(work, rel), 'utf8'), SAMPLE)
    })
  })
}

test('state.sh の入力ファイルの経路は run-verified.sh 経由でも同じに動く（ハッシュ照合を通る）', async () => {
  const { bundleSha256 } = await import('../scripts/build-workflow.mjs')
  withWork((work) => {
    const rel = seed(work, SAMPLE)
    const groups = JSON.stringify([{ numbers: [44], patch: { worktree: '' } }])
    writeFileSync(join(work, `${rel}.input-v1.json`), groups)
    const r = spawnSync(BASHES[0], [join(SCRIPTS, 'run-verified.sh'), bundleSha256(SCRIPTS, 'state.sh'), 'state.sh', ...inputArgs(rel, 'merge', 'v1', stateInputSha256('v1', 'merge', groups))], { encoding: 'utf8', cwd: work })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), OK.trimEnd())
    assert.equal(JSON.parse(readFileSync(join(work, rel), 'utf8')).items['44'].worktree, '')
  })
})

// 実行ビットに依存しないこと（launcher と同じく bash "<path>" で起動する）の確認用に、コピーしたスクリプトでも動く
test('スクリプトは lib/ と一緒に別のディレクトリへ置いても動く（scripts/ の相対位置だけに依存する）', () => {
  withWork((work) => {
    const dir = join(work, 'skill', 'scripts')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    for (const f of ['state-verify.sh']) copyFileSync(join(SCRIPTS, f), join(dir, f))
    for (const f of readdirSync(join(SCRIPTS, 'lib'))) copyFileSync(join(SCRIPTS, 'lib', f), join(dir, 'lib', f))
    const r = spawnSync(BASHES[0], [join(dir, 'state-verify.sh'), '_/issue-trees/1.json'], { encoding: 'utf8', cwd: work })
    assert.equal(r.stdout, 'NOFILE\n')
  })
})
