// 状態ファイルを扱う同梱スクリプト（scripts/state-verify.sh・state-read.sh・state-write.sh）を実際に実行する回帰テスト
// （利用側のリポジトリで観測した権限確認によるランの停止への対応: agent のプロンプトにシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる）。
//
// 検証する契約（ホストの照合は変えていないので、スクリプトは旧プロンプトのシェルと同じ出力・同じ書き込みをする）:
//   - state-verify.sh の出力は、2 行目（高水位。HIGHWATER bytes=<n> version=<n> のラベル付きにした）を除いて
//     旧プロンプトの 1 行のシェル（下の LEGACY_VERIFY）とバイト単位で同じ。行範囲の分割実行も同じ
//   - その先頭 2 行をそのまま返すと、ホストの分解（parseStateVerifyHeader）と照合（keysSha256・keysCount・高水位・
//     項目ごとの hashes）が成立する
//   - state-read.sh summary は OK count=<件数> bytes=<高水位> version=<版>（ラベル付き）を出し、create の出力と合わせてホストが分解する
//   - state-read.sh keys の出力は旧プロンプトの jq -c --argjson k ... と同じ値
//   - state-write.sh の各サブコマンドは、旧プロンプトの jq の式と同じ結果を書く（.updatedAt を除いて一致）
//   - 書き込みは一時ファイル + mv の原子的な置き換えで、失敗時は状態ファイルを変えず一時ファイルを残さない
//   - patch はホストが渡した SHA-256 と一致するときだけ書き、patch ファイルは成否に関わらず消す
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
const { sha256Hex, canonicalJson, verifyLoadedItems, statePatchSha256, parseStateVerifyHeader, isValidStateVerifyResult, parseStateLoadSummary } = await importDefinitions(
  ['sha256Hex', 'canonicalJson', 'verifyLoadedItems', 'statePatchSha256', 'parseStateVerifyHeader', 'isValidStateVerifyResult', 'parseStateLoadSummary'],
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

  test(`${tag} 新規のツリー: state-write.sh create が作った状態ファイルの state-verify.sh の出力は、ホストが高水位 0・版 2 に分解する（Issue #23 の再現）`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/23.json'
      assert.equal(run(bash, 'state-write.sh', ['create', rel, '23', 'main', '3', '2'], { cwd: work }).status, 0)
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

  test(`${tag} 新規のツリー: state-read.sh summary（NOFILE）・state-write.sh create（OK）・作成後の summary の出力をそのまま返すと、ホストが版 2 に分解する`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/23.json'
      const before = run(bash, 'state-read.sh', ['summary', rel], { cwd: work }).stdout
      const created = run(bash, 'state-write.sh', ['create', rel, '23', 'main', '3', '2'], { cwd: work }).stdout
      assert.deepEqual(parseStateLoadSummary(before, created, false), { ok: true, fileExisted: false, count: 0, highWaterBytes: 0, highWaterVersion: 2 })
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

  test(`${tag} state-write.sh create: ディレクトリと初期 JSON（旧プロンプトと同じ内容）を作り、既にあれば失敗して上書きしない`, () => {
    withWork((work) => {
      const rel = '_/issue-trees/860.json'
      const r = run(bash, 'state-write.sh', ['create', rel, '860', 'main', '3', '2'], { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'OK\n')
      const legacy = { parent: 860, baseBranch: 'main', parallel: 3, updatedAt: '', perWorktreeByteReserveHighWater: 0, perWorktreeByteReserveHighWaterVersion: 2, items: {} }
      assert.deepEqual(JSON.parse(readFileSync(join(work, rel), 'utf8')), legacy)
      writeFileSync(join(work, rel), '{"keep":true}')
      const again = run(bash, 'state-write.sh', ['create', rel, '860', 'main', '3', '2'], { cwd: work })
      assert.equal(again.status, 1)
      assert.equal(again.stdout, '')
      assert.match(again.stderr, /^FAILED: /)
      assert.equal(readFileSync(join(work, rel), 'utf8'), '{"keep":true}')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['860.json'], '一時ファイルを残さない')
    })
  })

  test(`${tag} state-write.sh merge-item: 旧プロンプトの jq と同じ結果を書き、patch ファイルを消す`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const patch = JSON.stringify({ status: 'blocked', note: "it's \"quoted\" $(touch x) `y` 日本語", pr: 0, lastUnresolvedComments: [{ a: 1 }] })
      const nonce = 'k3x9a0b1c2d4e5f6g7h8i9j0k1l2'
      writeFileSync(join(work, `${rel}.patch-${nonce}.json`), `${patch}\n`) // Write ツールが末尾に改行を足しても同じ
      const legacyFile = join(work, 'legacy.json')
      writeFileSync(legacyFile, SAMPLE)
      writeFileSync(join(work, 'p.json'), patch)
      const legacy = legacyJq(legacyFile, ['--slurpfile', 'patch', join(work, 'p.json'), '.items["44"] = ((.items["44"] // {}) + $patch[0]) | .updatedAt = $ts', '--arg', 'ts', TS])
      const r = run(bash, 'state-write.sh', ['merge-item', rel, '44', nonce, statePatchSha256(nonce, 44, patch)], { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'OK\n')
      const now = JSON.parse(readFileSync(join(work, rel), 'utf8'))
      assert.deepEqual(stripTs(now), stripTs(legacy))
      assert.match(now.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      assert.equal(existsSync(join(work, 'x')), false, 'patch の中身をシェルで評価しない')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'], 'patch ファイル・一時ファイルを残さない')
      // 存在しない項目へのマージは項目を作る（旧式の // {} と同じ）
      writeFileSync(join(work, `${rel}.patch-${nonce}.json`), patch)
      assert.equal(run(bash, 'state-write.sh', ['merge-item', rel, '99', nonce, statePatchSha256(nonce, 99, patch)], { cwd: work }).status, 0)
      assert.equal(JSON.parse(readFileSync(join(work, rel), 'utf8')).items['99'].status, 'blocked')
    })
  })

  test(`${tag} state-write.sh merge-item: patch の内容がホストの SHA-256 と違う・patch ファイルが無いときは書かずに失敗し、patch ファイルを消す`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const before = readFileSync(join(work, rel), 'utf8')
      const patch = JSON.stringify({ status: 'blocked' })
      const nonce = 'abc123'
      writeFileSync(join(work, `${rel}.patch-${nonce}.json`), JSON.stringify({ status: 'merged' })) // 写し間違い
      const r = run(bash, 'state-write.sh', ['merge-item', rel, '44', nonce, statePatchSha256(nonce, 44, patch)], { cwd: work })
      assert.equal(r.status, 1)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /FAILED: patch の内容がホストの渡したものと一致しない/)
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
      const missing = run(bash, 'state-write.sh', ['merge-item', rel, '44', nonce, statePatchSha256(nonce, 44, patch)], { cwd: work })
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /patch ファイルが無い/)
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
    })
  })

  test(`${tag} state-write.sh: patch の照合値は nonce と issue 番号に束縛され、別の issue・別の nonce・groups への流用は書かない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const before = readFileSync(join(work, rel), 'utf8')
      const patch = JSON.stringify({ status: 'blocked' })
      const pf = (n) => join(work, `${rel}.patch-${n}.json`)
      // ホストの照合値はスクリプトと同じ定義（nonce + 改行 + 束縛先 + 改行 + patch）
      assert.equal(statePatchSha256('n1', 44, patch), sha256Hex(`n1\n44\n${patch}`))
      const attempts = [
        ['merge-item', '45', 'n1', statePatchSha256('n1', 44, patch)], // 別の issue 向け
        ['merge-item', '44', 'n2', statePatchSha256('n1', 44, patch)], // 別の呼び出し（nonce）向け
        ['merge-item', '44', 'n1', sha256Hex(patch)], // 束縛しない旧来の値
      ]
      for (const [cmd, issue, nonce, sha] of attempts) {
        writeFileSync(pf(nonce), patch)
        const r = run(bash, 'state-write.sh', [cmd, rel, issue, nonce, sha], { cwd: work })
        assert.equal(r.status, 1, `${issue} ${nonce}`)
        assert.match(r.stderr, /一致しない/)
      }
      writeFileSync(pf('n1'), JSON.stringify([{ numbers: [44], patch: { status: 'x' } }]))
      assert.equal(run(bash, 'state-write.sh', ['merge-groups', rel, 'n1', statePatchSha256('n1', 44, JSON.stringify([{ numbers: [44], patch: { status: 'x' } }]))], { cwd: work }).status, 1)
      assert.equal(readFileSync(join(work, rel), 'utf8'), before)
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
    })
  })

  test(`${tag} state-write.sh: patch を扱うサブコマンドは引数の誤り（exit 2）でも patch ファイルを消す。nonce が不正なら何も消さない`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const pf = (n) => join(work, `${rel}.patch-${n}.json`)
      const cases = [
        ['merge-item', rel, '0', 'abc', 'a'.repeat(64)],
        ['merge-item', rel, '44', 'abc', 'short'],
        ['merge-item', rel, '44', 'abc'],
        ['merge-groups', rel, 'abc', 'short'],
        ['merge-groups', rel, 'abc'],
      ]
      for (const args of cases) {
        writeFileSync(pf('abc'), '{}')
        const r = run(bash, 'state-write.sh', args, { cwd: work })
        assert.equal(r.status, 2, args.join(' '))
        assert.equal(existsSync(pf('abc')), false, `patch ファイルが残る: ${args.join(' ')}`)
      }
      // nonce が不正（パスを組み立てられない）なら消さない
      writeFileSync(pf('ABC'), '{}')
      assert.equal(run(bash, 'state-write.sh', ['merge-item', rel, '44', 'ABC', 'a'.repeat(64)], { cwd: work }).status, 2)
      assert.equal(existsSync(pf('ABC')), true)
      assert.equal(readFileSync(join(work, rel), 'utf8'), SAMPLE)
    })
  })

  test(`${tag} state-write.sh: patch の照合と読み込みは同じ写しに対して行う（元ファイルを直接 --slurpfile で読まない）`, () => {
    const src = readFileSync(join(SCRIPTS, 'state-write.sh'), 'utf8')
    assert.match(src, /patch_file=\$\(mktemp\)/)
    assert.match(src, /cp -- "\$\{patch_src\}" "\$\{patch_file\}"/)
    assert.match(src, /--slurpfile patch "\$\{patch_file\}"/)
    assert.match(src, /--slurpfile groups "\$\{patch_file\}"/)
    assert.doesNotMatch(src, /--slurpfile \w+ "\$\{patch_src\}"/)
  })

  test(`${tag} state-write.sh create: 置き先は ln で作り、[ -e ] の検査のあとに現れたものも上書きしない`, () => {
    withWork((work) => {
      // [ -e ] では「無い」と見えるが名前は使われている状態（壊れたシンボリックリンク）で、ln の失敗に倒れることを確かめる
      mkdirSync(join(work, '_', 'issue-trees'), { recursive: true })
      const rel = '_/issue-trees/5.json'
      symlinkSync('nowhere.json', join(work, rel))
      const r = run(bash, 'state-write.sh', ['create', rel, '5', 'main', '1', '2'], { cwd: work })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^FAILED: /)
      assert.equal(readlinkSync(join(work, rel)), 'nowhere.json', '既存の名前を置き換えない')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['5.json'], '一時ファイルを残さない')
    })
  })

  test(`${tag} state-write.sh merge-groups: 旧プロンプトの reduce と同じ結果を書く`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const groups = JSON.stringify([{ numbers: [43, 45, 300], patch: { status: 'blocked', note: 'n' } }, { numbers: [42], patch: { note: 'x' } }])
      const nonce = 'g1'
      writeFileSync(join(work, `${rel}.patch-${nonce}.json`), groups)
      const legacyFile = join(work, 'legacy.json')
      writeFileSync(legacyFile, SAMPLE)
      writeFileSync(join(work, 'g.json'), groups)
      const legacy = legacyJq(legacyFile, ['--slurpfile', 'groups', join(work, 'g.json'), '--arg', 'ts', TS, 'reduce $groups[0][] as $g (.; reduce $g.numbers[] as $n (.; .items[($n|tostring)] = ((.items[($n|tostring)] // {}) + $g.patch))) | .updatedAt = $ts'])
      const r = run(bash, 'state-write.sh', ['merge-groups', rel, nonce, statePatchSha256(nonce, 'groups', groups)], { cwd: work })
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(stripTs(JSON.parse(readFileSync(join(work, rel), 'utf8'))), stripTs(legacy))
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
    })
  })

  test(`${tag} state-write.sh clear-worktree / init-pending / high-water-max / high-water-set: 旧プロンプトの jq と同じ結果を書く`, () => {
    withWork((work) => {
      const legacyFile = join(work, 'legacy.json')
      const check = (args, legacyArgs, body = SAMPLE) => {
        const rel = seed(work, body)
        writeFileSync(legacyFile, body)
        const r = run(bash, 'state-write.sh', [args[0], rel, ...args.slice(1)], { cwd: work })
        assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
        assert.equal(r.stdout, 'OK\n')
        assert.deepEqual(stripTs(JSON.parse(readFileSync(join(work, rel), 'utf8'))), stripTs(legacyJq(legacyFile, legacyArgs)), args.join(' '))
      }
      check(['clear-worktree', '44'], ['--argjson', 'patch', '{"worktree":""}', '.items["44"] = ((.items["44"] // {}) + $patch) | .updatedAt = $ts', '--arg', 'ts', TS])
      const entries = [{ number: 42, type: 'verify-close' }, { number: 46, type: 'implement' }, { number: 47, type: 'verify-close' }]
      check(['init-pending', '42:verify-close', '46:implement', '47:verify-close'], ['--argjson', 'entries', JSON.stringify(entries), 'reduce $entries[] as $e (.; if .items[($e.number|tostring)] == null then .items[($e.number|tostring)] = {"type":$e.type,"status":"pending","pr":0,"branch":"","worktree":"","fixCount":0,"note":""} else . end) | .updatedAt = $ts', '--arg', 'ts', TS])
      // 0 件は .updatedAt だけを更新する
      check(['init-pending'], ['--argjson', 'entries', '[]', 'reduce $entries[] as $e (.; .) | .updatedAt = $ts', '--arg', 'ts', TS])
      const hwMax = 'if ((.perWorktreeByteReserveHighWaterVersion // 0) != $v) or ((.perWorktreeByteReserveHighWater // 0) < $hw) then .perWorktreeByteReserveHighWater = $hw | .perWorktreeByteReserveHighWaterVersion = $v else . end | .updatedAt = $ts'
      for (const [cur, ver, bytes] of [[0, 0, 100], [500, 2, 100], [500, 2, 900], [500, 1, 100]]) {
        const body = JSON.stringify({ perWorktreeByteReserveHighWater: cur, perWorktreeByteReserveHighWaterVersion: ver, items: { 1: {} } })
        check(['high-water-max', String(bytes), '2'], ['--argjson', 'hw', String(bytes), '--argjson', 'v', '2', '--arg', 'ts', TS, hwMax], body)
      }
      for (const bytes of [0, 12345]) {
        check(['high-water-set', String(bytes), '2'], ['--argjson', 'hw', String(bytes), '--argjson', 'v', '2', '--arg', 'ts', TS, '.perWorktreeByteReserveHighWater = $hw | .perWorktreeByteReserveHighWaterVersion = $v | .updatedAt = $ts'], JSON.stringify({ perWorktreeByteReserveHighWater: 999, items: {} }))
      }
    })
  })

  test(`${tag} state-write.sh: 状態ファイルが壊れている・無いときは失敗し、ファイルを変えず一時ファイルを残さない`, () => {
    withWork((work) => {
      const rel = seed(work, '{ broken')
      const r = run(bash, 'state-write.sh', ['high-water-set', rel, '1', '2'], { cwd: work })
      assert.equal(r.status, 1)
      assert.equal(r.stdout, '')
      assert.equal(readFileSync(join(work, rel), 'utf8'), '{ broken')
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
      assert.equal(run(bash, 'state-write.sh', ['clear-worktree', '_/issue-trees/8.json', '1'], { cwd: work }).status, 1)
      assert.deepEqual(readdirSync(join(work, '_', 'issue-trees')), ['7.json'])
    })
  })

  test(`${tag} 不正な引数は exit 2 で何も書かない（パスの ..・番号 0・大文字の nonce・短いハッシュ・未知のサブコマンド・種別）`, () => {
    withWork((work) => {
      const rel = seed(work, SAMPLE)
      const sha = 'a'.repeat(64)
      const bad = [
        ['state-write.sh', ['merge-item', '_/../x.json', '1', 'abc', sha]],
        ['state-write.sh', ['merge-item', rel, '0', 'abc', sha]],
        ['state-write.sh', ['merge-item', rel, '1', 'ABC', sha]],
        ['state-write.sh', ['merge-item', rel, '1', 'abc', 'abc']],
        ['state-write.sh', ['clear-worktree', rel, '1;rm']],
        ['state-write.sh', ['init-pending', rel, '5:other']],
        ['state-write.sh', ['high-water-max', rel, '0', '2']],
        ['state-write.sh', ['create', rel, '1', 'main branch', '1', '2']],
        ['state-write.sh', ['nope', rel]],
        ['state-write.sh', ['clear-worktree', 'x.txt', '1']],
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

test('state-write.sh は run-verified.sh 経由でも同じに動く（ハッシュ照合を通る）', async () => {
  const { bundleSha256 } = await import('../scripts/build-workflow.mjs')
  withWork((work) => {
    const rel = seed(work, SAMPLE)
    const r = spawnSync(BASHES[0], [join(SCRIPTS, 'run-verified.sh'), bundleSha256(SCRIPTS, 'state-write.sh'), 'state-write.sh', 'clear-worktree', rel, '44'], { encoding: 'utf8', cwd: work })
    assert.equal(r.status, 0, r.stderr)
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
