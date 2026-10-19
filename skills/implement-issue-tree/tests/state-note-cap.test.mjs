// Issue #28: 状態ファイルの項目の note に fix の agent の summary（約 1,500 文字・複数行・引用符入り）がそのまま入ると、
// 次のランの state:load / state:load-fill の agent が note を一字一句は写せず（要約・改行を空白に変える）、ホストが
// 再計算したハッシュが state:load-verify と合わずに state-unverified で止まり、依存する後続もすべて止まった。
// 是正後の契約を固定する:
//   1. 状態ファイルへ書く note は、書く前にホストが 1 行・上限文字数（STATE_NOTE_MAX_CHARS）へ畳む（capStateNote）。
//      改行・タブ・制御文字は空白に畳み、連続する空白は 1 つにする。JSON のエスケープが要る " と \ は ' と / へ置き換える
//      （転記で誤りやすい形を状態ファイルに残さない）。全文は journal と結果（results）に残るので、状態ファイルには要点だけ残す。
//   2. 畳むのは状態ファイルへの書き込みの 2 経路（updateStateDetailed の JSON マージと、blocked の一括記録
//      writeBlockedStateBatch）の手前の 1 か所ずつ。note を持たない patch・note 以外のキーは変えない。
//   3. 既存の状態ファイルに長い note が残っていて照合できないときは、ログに note の長さ・複数行かを出し、
//      references/recovery.md の手順（退避してから短くし、同じ引数で再実行する）へ案内する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { trackTmp } from './lib/tmp-track.mjs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, '..', 'scripts', 'implement-issue-tree.src.js')
const RECOVERY_PATH = join(HERE, '..', 'references', 'recovery.md')
const DRIVER_MARKER = ['__IMPLEMENT', 'ISSUE', 'TREE', 'DRIVER', 'START__'].join('_')

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない`)
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)

globalThis.args = { parent: 1, skillDir: '/opt/skills/implement-issue-tree' }
const sliceDir = trackTmp(mkdtempSync(join(tmpdir(), 'implement-issue-tree-state-note-')))
const slicePath = join(sliceDir, 'implement-issue-tree-state-note-defs.mjs')
const SLICE_EXPORTS = [
  'capStateNote',
  'STATE_NOTE_MAX_CHARS',
  'updateState',
  'writeBlockedStateBatch',
  'ensureBoundaryNonceSeed',
  'loadState',
  'sha256Hex',
  'canonicalJson',
]
// typeof で包んで書き出す: 修正前の実装を指しても import 自体は成功させ、各テストの失敗で示す。
const optionalExports = SLICE_EXPORTS.map((n) => `const __opt_${n} = typeof ${n} === 'undefined' ? undefined : ${n}`).join('\n')
writeFileSync(slicePath, `${definitionPart}\n${optionalExports}\nexport { ${SLICE_EXPORTS.map((n) => `__opt_${n} as ${n}`).join(', ')} }\n`)
const {
  capStateNote, STATE_NOTE_MAX_CHARS, updateState, writeBlockedStateBatch, ensureBoundaryNonceSeed, loadState, sha256Hex, canonicalJson,
} = await import(pathToFileURL(slicePath).href)

globalThis.agent = async (_p, opts) => (opts.label === 'nonce:seed' ? { seedHex: 'b'.repeat(64) } : null)
globalThis.log = () => {}
await ensureBoundaryNonceSeed()

function installAgentStub(behavior) {
  const calls = []
  globalThis.agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    return behavior(opts, prompt)
  }
  const logs = []
  globalThis.log = (m) => { logs.push(m) }
  return { calls, logs }
}

// fix の agent の summary を模した長い note（複数行・箇条書き・引用符・バックスラッシュ・タブを含む約 1,500 文字）
const LONG_SUMMARY = [
  '自己レビューの結果: P0 0 件・P1 2 件を直した。',
  '- "internal/foo/bar.go" の nil 判定を追加した',
  '- テーブル駆動のテストに "空文字" のケースを足した\t（パスは C:\\tmp ではない）',
  ...Array.from({ length: 40 }, (_, i) => `- 指摘 ${i + 1}: 「状態ファイルの note」に関する説明をここに長く書く。`),
].join('\n')

// 状態ファイルへ書く JSON（UNTRUSTED 境界の内側の 1 行）をプロンプトから取り出す
const writtenGroups = (prompt) => JSON.parse(prompt.split('\n').find((l) => l.startsWith('[{"numbers"')))
const stateWriteCalls = (calls) => calls.filter((c) => /^state:update(-batch)?:/.test(c.opts.label))

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

test('capStateNote: 上限は数百文字（1 行に収まる長さ）', () => {
  assert.equal(typeof STATE_NOTE_MAX_CHARS, 'number')
  assert.ok(STATE_NOTE_MAX_CHARS >= 100 && STATE_NOTE_MAX_CHARS <= 500, String(STATE_NOTE_MAX_CHARS))
})

test('capStateNote: 入力の形ごとの出力（表）', () => {
  const cases = [
    ['短い 1 行はそのまま', 'すでに closed', 'すでに closed'],
    ['空文字は空文字', '', ''],
    ['改行（LF・CRLF）は空白 1 つに畳む', 'a\nb\r\nc', 'a b c'],
    ['タブ・連続する空白・前後の空白を畳む', '  a\t\t b   c  ', 'a b c'],
    ['制御文字・DEL は空白に畳む', 'a\x01b\x7fc\x1fd', 'a b c d'],
    ['" は \' へ、\\ は / へ置き換える（JSON のエスケープを残さない）', 'path "C:\\x"', "path 'C:/x'"],
    ['文字列でない値は文字列にする', 42, '42'],
    ['null・undefined は空文字', null, ''],
  ]
  for (const [name, input, expected] of cases) assert.equal(capStateNote(input), expected, name)
  assert.equal(capStateNote(undefined), '')
})

test('capStateNote: 長い summary は 1 行・上限文字数以内に畳み、切ったことを末尾で示す', () => {
  const out = capStateNote(LONG_SUMMARY)
  assert.ok(LONG_SUMMARY.length > 1000)
  assert.doesNotMatch(out, /[\r\n\t\x00-\x1f\x7f"\\]/)
  assert.ok([...out].length <= STATE_NOTE_MAX_CHARS, `${[...out].length}`)
  assert.ok(out.startsWith('自己レビューの結果: P0 0 件・P1 2 件を直した。 - \'internal/foo/bar.go\' の nil 判定'), out.slice(0, 80))
  assert.match(out, /（省略）$/)
  // ちょうど上限の長さは切らない（省略の印を付けない）
  const exact = 'あ'.repeat(STATE_NOTE_MAX_CHARS)
  assert.equal(capStateNote(exact), exact)
  assert.match(capStateNote(`${exact}い`), /（省略）$/)
  // 冪等: 畳んだ結果をもう一度畳んでも変わらない（保存済みとの比較で余計な書き込みをしない）
  assert.equal(capStateNote(out), out)
})

test('capStateNote: サロゲートペア（絵文字）を途中で切らない', () => {
  const out = capStateNote('😀'.repeat(STATE_NOTE_MAX_CHARS + 10))
  assert.ok(!/[\ud800-\udbff]$/.test(out.replace(/（省略）$/, '')), '上位サロゲートだけが残っている')
  assert.ok([...out].length <= STATE_NOTE_MAX_CHARS)
  // 畳んだ note は jq の正規形と同じ直列化で往復できる（照合のハッシュが安定する）
  assert.equal(sha256Hex(canonicalJson({ note: out })), sha256Hex(canonicalJson(JSON.parse(JSON.stringify({ note: out })))))
})

// ---------------------------------------------------------------------------
// 書き込みの 2 経路
// ---------------------------------------------------------------------------

test('updateState: 長い note は 1 行・上限以内に畳んで状態ファイルへ書く（ほかのキーは変えない）', async () => {
  const { calls } = installAgentStub(() => ({ ok: true }))
  const ok = await updateState(7, { status: 'blocked', pr: 0, fixCount: 3, note: LONG_SUMMARY })
  assert.equal(ok, true)
  const [w] = stateWriteCalls(calls)
  assert.ok(w, 'JSON マージのエージェントを起動していない')
  const [group] = writtenGroups(w.prompt)
  assert.deepEqual(group.numbers, [7])
  assert.equal(group.patch.note, capStateNote(LONG_SUMMARY))
  assert.doesNotMatch(group.patch.note, /\n/)
  assert.deepEqual({ ...group.patch, note: undefined }, { status: 'blocked', pr: 0, fixCount: 3, note: undefined })
  // 状態ファイルへ書く JSON の行に、元の summary の改行（\n のエスケープ）が残らない
  assert.ok(!w.prompt.split('\n').find((l) => l.startsWith('[{"numbers"')).includes('\\n'))
})

test('updateState: note を持たない patch には note を足さない', async () => {
  const { calls } = installAgentStub(() => ({ ok: true }))
  await updateState(8, { status: 'reviewing', worktree: '' })
  const [group] = writtenGroups(stateWriteCalls(calls)[0].prompt)
  assert.equal('note' in group.patch, false)
})

test('writeBlockedStateBatch: 長い note は畳んで書き、畳んだ note が保存済みと同じ項目は書かない', async () => {
  const { calls } = installAgentStub(() => ({ ok: true }))
  const patch = { status: 'blocked', note: LONG_SUMMARY, pr: 0 }
  const r = await writeBlockedStateBatch([{ number: 1, patch }, { number: 2, patch }], {
    2: { status: 'blocked', note: capStateNote(LONG_SUMMARY), pr: 0 },
  })
  assert.equal(r.unchanged, 1, '保存済みの note は畳んだ形なので、畳んでから比べる')
  assert.equal(r.written, 1)
  const groups = writtenGroups(stateWriteCalls(calls)[0].prompt)
  assert.deepEqual(groups, [{ numbers: [1], patch: { status: 'blocked', note: capStateNote(LONG_SUMMARY), pr: 0 } }])
})

// ---------------------------------------------------------------------------
// 既存の状態ファイルに長い note が残っている場合（読込の案内）
// ---------------------------------------------------------------------------

test('loadState: 長い note の項目が照合できないときは、note の長さ・複数行をログに出し、退避して短くする手順へ案内する', async () => {
  const saved = { 44: { status: 'blocked', pr: 0, branch: 'fix/44-x', note: LONG_SUMMARY }, 45: { status: 'merged', pr: 9, branch: 'fix/45-y', note: 'ok' } }
  const hashes = Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, sha256Hex(canonicalJson(v))]))
  const keysSha256 = sha256Hex(canonicalJson(Object.keys(hashes).sort()))
  // 読込・再取得の agent は長い note を要約して返す（改行を空白に変える）。短い note の項目は正しく写す
  const mangled = { ...saved, 44: { ...saved[44], note: LONG_SUMMARY.replace(/\n/g, ' ') } }
  const { logs } = installAgentStub((opts) => {
    if (opts.label === 'state:load') return { summaryLine: 'OK count=2 bytes=0 version=0', createLine: '', items: mangled }
    if (opts.label === 'state:load-verify') return { headerLines: `KEYS ${keysSha256} 2\nHIGHWATER bytes=0 version=0`, hashes }
    return { items: { 44: mangled[44] } }
  })
  const r = await loadState()
  assert.deepEqual(r.unverified, [44])
  assert.deepEqual(Object.keys(r.items), ['45'])
  const line = logs.find((l) => /state-unverified 1 件/.test(l))
  assert.ok(line, logs.join('\n'))
  assert.match(line, /#44/)
  assert.match(line, new RegExp(`note ${LONG_SUMMARY.replace(/\n/g, ' ').length} 文字`))
  assert.match(line, /references\/recovery\.md/)
  assert.match(line, /退避/)
})

test('loadState: 照合できない項目の note が短い 1 行なら note の手がかりは出さない（原因を取り違えさせない）', async () => {
  const saved = { 50: { status: 'monitoring', pr: 3, branch: 'fix/50-z', note: '短い' } }
  const hashes = Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, sha256Hex(canonicalJson(v))]))
  const keysSha256 = sha256Hex(canonicalJson(Object.keys(hashes).sort()))
  const { logs } = installAgentStub((opts) => {
    if (opts.label === 'state:load') return { summaryLine: 'OK count=1 bytes=0 version=0', createLine: '', items: { 50: { ...saved[50], pr: 999 } } }
    if (opts.label === 'state:load-verify') return { headerLines: `KEYS ${keysSha256} 1\nHIGHWATER bytes=0 version=0`, hashes }
    return { items: {} }
  })
  const r = await loadState()
  assert.deepEqual(r.unverified, [50])
  const line = logs.find((l) => /state-unverified 1 件/.test(l))
  assert.ok(line)
  assert.doesNotMatch(line, /文字・|note \d+ 文字/)
})

// ---------------------------------------------------------------------------
// 配線と文書
// ---------------------------------------------------------------------------

test('駆動部: state-unverified で着手しない項目の note は recovery.md の手順を案内する', () => {
  assert.match(driverPart, /state-unverified: 内容照合できないため着手しない。[^'\n]*references\/recovery\.md/)
})

test('recovery.md: note が長くて state-unverified になったときの手順（写しへ退避 → 短い 1 行へ → 同じ引数で再実行）がある', () => {
  const doc = readFileSync(RECOVERY_PATH, 'utf8')
  const start = doc.indexOf('### state-unverified で止まった場合')
  assert.ok(start >= 0, '見出しが無い')
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1))
  assert.match(section, /cp _\/issue-trees\/42\.json _\/issue-trees\/42\.json\.aside/)
  assert.match(section, /1 行/)
  assert.match(section, /同じ引数で再実行/)
})
