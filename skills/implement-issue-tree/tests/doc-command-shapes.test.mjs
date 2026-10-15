// SKILL.md と references（起動するセッションが読んでそのとおりに実行する手順）のコマンドが、利用側の PreToolUse の hook が
// 拒否しうる形のうち (b)〔cat <file> などでファイルを読む〕と (d)〔gh の --jq・-q の式に { [ | を含む〕に当たらないことの
// 回帰テスト（Issue #22）。Workflow の agent のプロンプトは agent-command-shapes.test.mjs が見る。
//
// 対象と読み方:
//   - SKILL.md と references/*.md。references/script-trust-model.md は、旧コマンドと hook が拒否する形を説明する文書
//     （表・本文の `cat <file>` などは実行させる手順ではない）なので対象外
//   - コードフェンス（bash・sh・shell・言語指定なし）の各行。行末の \ でつないだ行は 1 本にする。# で始まる行は読まない
//   - 直前の行に <!-- command-shape: script-file --> を置いたフェンスは対象外。複数文の診断用のブロックで、ファイルに
//     書いて bash <file> で実行する前提のもの（本文にその旨を書く）
//   - フェンスの外のインラインコード（`...`）
//   - (a)・(c) は見ない（Issue #22 の範囲外。文中の JS の式 a && b なども (c) に当たるため）
//
// あわせて、--jq の式を移した同梱の .jq ファイル（scripts/jq/）が、元の式と同じ出力を返すことを確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCommand } from './lib/command-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = join(HERE, '..')
const RULES = new Set(['b', 'd'])
const SCRIPT_FILE_MARKER = '<!-- command-shape: script-file -->'
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'console'])
const EXCLUDED_FILES = new Map([
  ['references/script-trust-model.md', '旧コマンドと hook が拒否する形の説明（表・本文の例は実行させる手順ではない）'],
])

/** Markdown からコマンドの候補を { line, text, where } で取り出す */
function extractDocCommands(markdown) {
  const out = []
  const lines = markdown.split('\n')
  let fence = null // { marker, lang, skip }
  let pending = null // 行末の \ でつないでいる途中の { line, text }
  let prevNonEmpty = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/)
    if (fence) {
      if (open && open[1][0] === fence.marker[0] && open[1].length >= fence.marker.length && !open[2]) {
        if (pending && !fence.skip) out.push({ ...pending, where: 'fence' })
        pending = null
        fence = null
        prevNonEmpty = line
        continue
      }
      if (fence.skip) continue
      const t = line.trim()
      if (!pending && (t === '' || t.startsWith('#'))) continue
      const cont = /\\$/.test(t)
      const body = cont ? t.slice(0, -1) : t
      pending = pending ? { line: pending.line, text: `${pending.text} ${body}` } : { line: i + 1, text: body }
      if (!cont) {
        out.push({ ...pending, where: 'fence' })
        pending = null
      }
      continue
    }
    if (open) {
      const lang = open[2].toLowerCase()
      fence = { marker: open[1], lang, skip: !SHELL_LANGS.has(lang) || prevNonEmpty.trim() === SCRIPT_FILE_MARKER }
      prevNonEmpty = line
      continue
    }
    for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) out.push({ line: i + 1, text: m[2].trim(), where: 'inline' })
    if (line.trim() !== '') prevNonEmpty = line
  }
  return out
}

function violationsOf(markdown) {
  return extractDocCommands(markdown).flatMap((c) =>
    checkCommand(c.text).filter((v) => RULES.has(v.rule)).map((v) => ({ ...c, rule: v.rule })),
  )
}

const DOCS = ['SKILL.md', ...readdirSync(join(SKILL, 'references')).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`)]

test('SKILL.md と references の手順のコマンドは (b)・(d) に当たらない（cat でファイルを読まない・gh の --jq に { [ | を書かない）', () => {
  const found = []
  for (const f of DOCS) {
    if (EXCLUDED_FILES.has(f)) continue
    for (const v of violationsOf(readFileSync(join(SKILL, f), 'utf8'))) found.push(`${f}:${v.line} (${v.rule}) ${v.text}`)
  }
  assert.deepEqual(found, [])
})

test('対象外の文書は存在し、理由を持つ（消えた・改名したら一覧から外す）', () => {
  for (const [f, reason] of EXCLUDED_FILES) {
    assert.ok(DOCS.includes(f), f)
    assert.ok(reason, f)
  }
})

test('検査器: 形が戻ったら検出する（フェンス・行末の \\ でつないだ行・インラインコード）。script-file の目印のフェンスと別言語のフェンスは見ない', () => {
  const md = [
    '状態ファイルは `cat _/issue-trees/42.json` で読む。',
    '```bash',
    '# コメントの cat _/x.json は読まない',
    'gh api --paginate "repos/{owner}/{repo}/issues/1/sub_issues" \\',
    "  --jq '.[] | {number, state}'",
    "cat _/issue-trees/42.json | jq '.items'",
    'gh pr view 1 --json headRefOid -q .headRefOid',
    '```',
    '',
    SCRIPT_FILE_MARKER,
    '```bash',
    "rows=$(gh api x --jq '.check_runs[] | .name')",
    '```',
    '```json',
    '{ "cat": "x" }',
    '```',
  ].join('\n')
  const got = violationsOf(md).map((v) => `${v.line} ${v.rule}`)
  assert.deepEqual(got, ['1 b', '4 d', '6 b'])
})

// --- 同梱の .jq ファイル ---

const JQ_DIR = join(SKILL, 'scripts', 'jq')
const hasJq = spawnSync('jq', ['--version']).status === 0
const jq = (args, input) => spawnSync('jq', args, { input, encoding: 'utf8' })

// [ファイル名, 元の --jq の式, 入力（gh の --paginate はページを続けて出す）, 追加の引数]
const JQ_CASES = [
  ['sub-issues-summary.jq', '.[] | {number, state, total: .sub_issues_summary.total}',
    '[{"number":2,"state":"open","sub_issues_summary":{"total":3},"title":"x"}][{"number":5,"state":"closed","sub_issues_summary":{"total":0}}]', []],
  ['cancelled-run-ids.jq', '.workflow_runs[] | select(.conclusion == "cancelled") | .id',
    '{"workflow_runs":[{"id":1,"conclusion":"cancelled"},{"id":2,"conclusion":"success"}]}{"workflow_runs":[{"id":3,"conclusion":"cancelled"}]}', []],
  ['job-names.jq', '.jobs[].name', '{"jobs":[{"name":"build"},{"name":"test / unit"}]}', []],
  ['job-conclusion.jq', '.jobs[] | select(.name == $job) | .conclusion',
    '{"jobs":[{"name":"build","conclusion":"success"},{"name":"test","conclusion":"failure"}]}', ['--arg', 'job', 'test']],
  ['first-run-id.jq', '.[0].databaseId', '[{"databaseId":42,"conclusion":"success"}]', []],
  ['state-worktrees.jq', '.items | to_entries[] | {issue: .key, worktree: .value.worktree}',
    '{"items":{"5":{"status":"failed","worktree":"/w/5"},"6":{"status":"merged"}}}', []],
  ['state-failed-worktrees.jq', '.items | to_entries[] | select(.value.status == "failed") | {issue: .key, worktree: .value.worktree}',
    '{"items":{"5":{"status":"failed","worktree":"/w/5"},"6":{"status":"merged","worktree":"/w/6"}}}', []],
]

test('scripts/jq/ の .jq ファイルは、移す前の --jq の式と同じ出力を返す（文書が参照するものだけを置く）', { skip: !hasJq && 'jq が無い' }, () => {
  const docs = DOCS.map((f) => readFileSync(join(SKILL, f), 'utf8')).join('\n')
  const files = readdirSync(JQ_DIR).filter((f) => f.endsWith('.jq')).sort()
  assert.deepEqual(files, JQ_CASES.map((c) => c[0]).sort(), 'ケースの無い .jq ファイル・ファイルの無いケースがない')
  for (const [file, expr, input, extra] of JQ_CASES) {
    assert.ok(existsSync(join(JQ_DIR, file)), file)
    assert.ok(docs.includes(`scripts/jq/${file}`), `${file} を文書が参照している`)
    const old = jq(['-r', ...extra, expr], input)
    const now = jq(['-r', ...extra, '-f', join(JQ_DIR, file)], input)
    assert.equal(old.status, 0, old.stderr)
    assert.equal(now.status, 0, now.stderr)
    assert.equal(now.stdout, old.stdout, file)
    assert.notEqual(now.stdout, '', `${file}: 入力に当たる行がある`)
  }
})
