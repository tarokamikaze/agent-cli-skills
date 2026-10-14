// Workflow の agent に実行させるコマンドが、利用側の PreToolUse の hook が拒否しうる 4 つの形（tests/lib/command-shape.mjs の
// (a)〜(d)）に当たらないことの回帰テスト（Issue #11）。
//
// コマンドの集め方は 2 通りを併用する:
//   1. 目印: 開発ファイルの cmd('...') が組み立てたコマンドを記録する（CMD_RECORDER）。プロンプトを組み立てる関数を引数の
//      マトリクスで呼び、Workflow 全体も stub の agent で流して記録を集める。目印を付けたコマンドは例外なしで 0 件であること
//   2. 静的な走査: 同じ呼び出しで得たプロンプト全文から、git・gh・jq などで始まる断片を拾って検査する。目印を付け忘れた
//      コマンドの取りこぼしを拾う保険。検出したものは、まだ直していない範囲の「既知の例外」か、コマンドではない文
//      （やってはいけない例の説明など）の「許可リスト」のどちらかに理由付きで載っていなければ失敗にする
// 既知の例外・許可リストの項目が何にも当たらなくなったら（直した・文が消えた）、その項目を消すよう失敗にする。
// 生成物（implement-issue-tree.js）は開発ファイルからコメントと空白を除いただけで、文字列はトークン照合（build-workflow.mjs）で
// 同じであることが保証されているので、開発ファイルの関数を呼んで得たプロンプトは生成物のプロンプトと同じ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkCommand, extractCommandBlocks, extractCommandCandidates } from './lib/command-shape.mjs'
import { BASE_ARGS, definitionPart, runScript, STUB_SKILL_DIR } from './lib/stub-run.mjs'

const SHA = 'a'.repeat(40)

// 定義部（駆動部のマーカーより上）を、引数と記録用の agent を与えて読み込む
const DEF_EXPORTS = [
  'CMD_RECORDER', 'ensureBoundaryNonceSeed', 'loadState', 'updateStateDetailed', 'persistPerWorktreeByteReserveHighWater',
  'setPerWorktreeByteReserveHighWater', 'scanOrphanWorktrees', 'countWorktreeRecords', 'measureResidualWorktreeBytes',
  'measureFreeDiskKib', 'scanMainWorktreeUntracked', 'scanMainWorktreeHead', 'sweepClosedWorktrees', 'initAllPending',
  'writeBlockedStateChunk', 'verifyDiscardSafety', 'declaredDepsPrompt', 'outOfTreeStatePrompt', 'rootAncestorsPrompt',
  'prereqProbePrompt', 'planPrompt', 'reviewPrompt', 'lowFindingsCommentPrompt', 'implementPrompt', 'monitorPrompt',
  'mergeExecutePrompt', 'mergeVerifyPrompt', 'optinRecordVerifyPrompt', 'prCreatePrompt', 'fixPrompt', 'baseMergePrompt',
  'closePrompt', 'recoverPrompt', 'recoverImplementPrompt',
]

async function loadDefinitions(args, tag) {
  const dir = mkdtempSync(join(tmpdir(), `implement-issue-tree-shapes-${tag}-`))
  const path = join(dir, 'defs.mjs')
  writeFileSync(path, `const args = ${JSON.stringify(args)}\n${definitionPart}\nexport { ${DEF_EXPORTS.join(', ')} }\n`)
  return import(pathToFileURL(path).href)
}

// 記録用の agent。nonce:seed だけ値を返し（境界トークンを使う関数のため）、ほかは null（呼び出し側の失敗経路に入る）
const prompts = []
globalThis.agent = async (prompt, opts) => {
  prompts.push(String(prompt))
  return opts?.label === 'nonce:seed' ? { seedHex: 'c'.repeat(64) } : null
}
globalThis.log = () => {}
globalThis.phase = () => {}

const item = { number: 5, title: 'issue 5', optinTests: ['make e2e'] }
const plainItem = { number: 6, title: 'issue 6' }
const impl = { prNumber: 1005, branch: 'feat/5-x', worktreePath: '/repo/wt/5' }
const finding = { summary: 's', unresolvedComments: [{ threadId: 'T1', text: 'fix', url: 'https://example.invalid/1', path: 'a.go' }] }
const CHECK_ENTRIES = [
  [],
  [{ app: 'cursor', contexts: ['Cursor Bugbot'] }],
  [{ app: 'sonarcloud', contexts: ['SonarCloud Code Analysis'] }],
  [{ app: 'cursor', contexts: ['Cursor Bugbot'] }, { app: 'sonarcloud', contexts: ['SonarCloud Code Analysis'] }],
]

// 引数のマトリクスでプロンプトを組み立て、プロンプト全文と目印の記録を集める
async function collect() {
  const recorded = []
  const texts = []
  const variants = [
    { ...BASE_ARGS, branch: 'main' },
    { ...BASE_ARGS, branch: 'release/v1.2', autoMerge: true, externalChecks: [{ app: 'cursor', context: 'Cursor Bugbot' }] },
  ]
  for (const [vi, args] of variants.entries()) {
    const d = await loadDefinitions(args, String(vi))
    d.CMD_RECORDER.list = recorded
    const call = async (fn) => {
      try {
        const v = await fn()
        if (typeof v === 'string') texts.push(v)
      } catch {
        // stub の agent が null を返すため失敗経路で例外になる関数がある。プロンプトは agent に渡った時点で集めている
      }
    }
    await call(() => d.ensureBoundaryNonceSeed())
    await call(() => d.loadState())
    await call(() => d.updateStateDetailed(5, { status: 'merged', note: 'x' }))
    await call(() => d.updateStateDetailed(5, { status: 'merged' }, { cleanupWorktree: '/repo/wt/5', cleanupBranch: 'feat/5-x' }))
    await call(() => d.persistPerWorktreeByteReserveHighWater(1024))
    await call(() => d.setPerWorktreeByteReserveHighWater(1024))
    await call(() => d.scanOrphanWorktrees())
    await call(() => d.countWorktreeRecords())
    await call(() => d.measureResidualWorktreeBytes(['/repo/wt/5']))
    await call(() => d.measureFreeDiskKib('/repo'))
    await call(() => d.scanMainWorktreeUntracked('worktree:untracked-scan'))
    await call(() => d.scanMainWorktreeHead('worktree:head-scan'))
    await call(() => d.sweepClosedWorktrees(['/repo/wt/9']))
    await call(() => d.initAllPending([{ number: 5, kind: 'implement' }, { number: 6, kind: 'verify-close' }]))
    await call(() => d.writeBlockedStateChunk([{ number: 5, patch: { status: 'blocked' } }], 'state:update-batch:1'))
    await call(() => d.verifyDiscardSafety(5, '/repo/wt/5', 'feat/5-x'))
    await call(() => d.declaredDepsPrompt([5, 6]))
    await call(() => d.outOfTreeStatePrompt([7]))
    await call(() => d.rootAncestorsPrompt(5))
    await call(() => d.prereqProbePrompt([7], { 7: 70 }))
    for (const it of [item, plainItem]) {
      await call(() => d.planPrompt(it))
      await call(() => d.reviewPrompt(it, impl, false))
      await call(() => d.reviewPrompt(it, impl, true))
      await call(() => d.lowFindingsCommentPrompt(it, impl.prNumber, ['low finding']))
      await call(() => d.implementPrompt(it, 'plan'))
      await call(() => d.mergeVerifyPrompt(it, impl))
      await call(() => d.optinRecordVerifyPrompt(it, impl, ['make e2e']))
      await call(() => d.prCreatePrompt(it, impl, ['out of scope']))
      for (const push of [true, false]) {
        await call(() => d.fixPrompt(it, impl, finding, push, ['T1'], ['/repo/wt/5']))
      }
      await call(() => d.baseMergePrompt(it, impl, 'owner/repo', 'fix(x): base ブランチの変更を取り込む'))
      await call(() => d.closePrompt(it))
      await call(() => d.recoverPrompt(it, 'feat/5-x', '/repo/wt/5'))
      await call(() => d.recoverPrompt(it, 'feat/5-x', ''))
      await call(() => d.recoverImplementPrompt(it, { done: 'd', remaining: 'r', broken: 'b' }, 'feat/5-x'))
      for (const entries of CHECK_ENTRIES) {
        const apps = entries.map((e) => e.app)
        for (const confirmed of [true, false]) {
          for (const clientMerge of [true, false]) {
            for (const rescan of [true, false]) {
              await call(() => d.monitorPrompt(it, impl, apps, confirmed, clientMerge, rescan, rescan ? SHA : ''))
            }
          }
        }
        for (const allowMerge of [true, false]) {
          await call(() => d.mergeExecutePrompt(it, impl, allowMerge, entries, allowMerge ? SHA : ''))
        }
      }
    }
    d.CMD_RECORDER.list = null
  }
  // Workflow 全体（Restore → Tree → 1 件の plan〜monitor）も stub の agent で流す（駆動部にあるプロンプトを集める）
  for (const args of [BASE_ARGS, { ...BASE_ARGS, autoMerge: true, externalChecks: [] }]) {
    const { calls } = await runScript({ args })
    texts.push(...calls.map((c) => c.prompt))
  }
  texts.push(...prompts)
  return { recorded, texts }
}

const collected = await collect()

test('目印 cmd() を付けたコマンドは (a)〜(d) のどれにも当たらない', () => {
  assert.ok(collected.recorded.length > 0, '目印の記録が無い（CMD_RECORDER が働いていない）')
  const bad = [...new Set(collected.recorded)].flatMap((c) => checkCommand(c).map((v) => `(${v.rule}) ${c}`))
  assert.deepEqual(bad, [])
})

test('範囲 A で同梱スクリプト・単独のコマンドへ移した箇所が、マトリクスで実際に組み立てられている', () => {
  const all = collected.recorded.join('\n')
  for (const name of [
    'nonce-seed.sh', 'checks-total.sh', 'compare-files.sh', 'external-check-runs.sh', 'required-context-missing.sh',
    'unresolved-threads.sh', 'checks-state-counts.sh', 'review-state-counts.sh',
  ]) {
    assert.ok(all.includes(` ${name}`), `${name} を起動するコマンドが組み立てられていない`)
  }
  assert.ok(all.includes(`bash '${STUB_SKILL_DIR}/scripts/run-verified.sh' `))
  assert.ok(collected.recorded.includes('git rev-parse --verify "refs/remotes/origin/feat/5-x"'), 'PR 作成 1b の rev-parse')
  assert.ok(collected.recorded.includes('git fetch origin'), 'Implement・recover-implement・fix の fetch を単独にした')
  assert.ok(all.includes('required-context-missing.sh release%2Fv1.2 <HEAD sha>'), 'ベースブランチは URL エンコードして渡す')
})

test('範囲 B（merge-exec の G0 とマージの実行）を g0-check.sh と単独の gh pr merge へ移したコマンドが組み立てられている', () => {
  const all = collected.recorded.join('\n')
  assert.ok(collected.recorded.some((c) => c.endsWith(' g0-check.sh main <HEAD sha>')), '外部チェックなし確定は slug:context の引数なし')
  assert.ok(all.includes(' g0-check.sh release%2Fv1.2 <HEAD sha> cursor:Cursor%20Bugbot'), 'ベースブランチは URL エンコード、context は %XX エンコード')
  assert.ok(all.includes(' g0-check.sh main <HEAD sha> cursor:Cursor%20Bugbot sonarcloud:SonarCloud%20Code%20Analysis'), '複数 App は宣言の順に App ごと')
  assert.ok(collected.recorded.includes('gh pr merge 1005 --squash --delete-branch --match-head-commit <HEAD sha>'), '手順 5 は sha を値で埋め込む単独のコマンド')
  // マージは変数の代入・連結なしの 1 本だけ
  for (const c of collected.recorded.filter((x) => x.includes('gh pr merge'))) {
    assert.match(c, /^gh pr merge \d+ --squash --delete-branch --match-head-commit <HEAD sha>$/)
  }
})

// --- 静的な走査 ---

// まだ直していない範囲（Issue #11 の範囲 C・D。範囲 B〔merge-exec の G0 とマージの実行〕は g0-check.sh と単独の gh pr merge に
// 移して一覧から消した）。直した PR で項目を消し、最後の PR で一覧を空にする。
// match は検出した断片（extractCommandCandidates の 1 行の切り出し、または extractCommandBlocks の複数行の塊）に当てる正規表現
const KNOWN_EXCEPTIONS = [
  {
    range: 'C',
    where: 'prCreatePrompt 手順 1c（既存 PR の本文への Closes 行の追記）',
    rules: ['c'],
    match: /^grep -qF "Closes #\d+" "\$f" \|\| \{ echo; echo; echo "Closes #\d+"; \} >> "\$f"$/,
    reason: 'PR 本文（未信頼の自由文）の書き込み。Write ツールでファイルに書き、スクリプトが SHA-256 を照合してから使う形へ移す（範囲 C の PR）',
  },
  {
    range: 'C',
    where: 'optinRecordRewriteLines（opt-in テスト記録の節の書き直し）',
    rules: ['c'],
    match: /^rc=\$\?; \[ "\$rc" -eq 0 \] && \[ -s "\$g" \] && mv "\$g" "\$f"$/,
    reason: 'PR 本文の書き込み（opt-in 記録のゲート）。範囲 C の PR で書き込みごとスクリプトへ移す',
  },
  {
    range: 'C',
    where: 'optinRecordVerifyPrompt（opt-in テスト記録の件数の確認）',
    rules: ['c'],
    match: /^pass=\$\(grep -cxF -- "PLACEHOLDER" "\$g"\); rc=\$\?\nfail=/,
    reason: 'opt-in 記録のゲート（PR 本文の読み取りと正規化）。書き込み側と同じ範囲 C の PR で移す',
  },
  {
    range: 'D',
    where: 'updateStateDetailed の worktree の削除（state:cleanup）・sweepClosedWorktrees の削除前の確認',
    rules: ['a'],
    match: /^(?:target=\$\(cd "\$p"|main_wt_real=\$\(cd "\$main_wt") 2>\/dev\/null && pwd -P\)$/,
    reason: 'rm -rf の前の実パスの安全確認。削除の安全判定ごとスクリプトへ移す（範囲 D の PR。script-trust-model.md の方針）',
  },
  {
    range: 'D',
    where: 'sweepClosedWorktrees（ラン終了時の worktree のスイープ）',
    rules: ['a', 'c'],
    match: /^(?:CANDIDATES_EOF\njq -r '\.\[\]' "\$candidates_file" \| while IFS= read -r p; do\n|esac\nrm -rf -- "\$p"\n)/,
    reason: '削除を含む複数行の手順。削除の安全判定ごとスクリプトへ移す（範囲 D の PR）',
  },
  {
    range: 'D',
    where: 'verifyDiscardSafety（worktree 破棄前の安全確認）の手順 3',
    rules: ['c'],
    match: /^b="[^"]+"\nbase="[^"]+"\ngit rev-list --count "origin\/\$base"\.\."refs\/heads\/\$b"$/,
    reason: '破棄（削除）の安全判定の観測。範囲 D の PR で削除の判定と一緒にスクリプトへ移す',
  },
]

// コマンドではない文、または agent に実行させない例（やってはいけない例の説明など）
const ALLOWED_TEXT = [
  {
    where: 'prCreatePrompt 手順 1b・postPushChecksInstruction などの説明文',
    rules: ['b'],
    match: /^head (?:branch|sha)$/,
    reason: '英語の「head branch」「head sha」という語で、head コマンドではない',
  },
]

const violations = []
for (const text of new Set(collected.texts)) {
  for (const snippet of [...extractCommandCandidates(text), ...extractCommandBlocks(text)]) {
    for (const v of checkCommand(snippet)) violations.push({ rule: v.rule, snippet })
  }
}
const uniqueViolations = [...new Map(violations.map((v) => [`${v.rule} ${v.snippet}`, v])).values()]

if (process.env.SHAPES_DEBUG) {
  for (const v of uniqueViolations) console.log(`\n=====\n(${v.rule}) ${v.snippet}`)
}

test('静的な走査: 検出したコマンドは、既知の例外（範囲 C・D）か許可リストに理由付きで載っている', () => {
  const entries = [...KNOWN_EXCEPTIONS, ...ALLOWED_TEXT]
  const unexplained = uniqueViolations.filter((v) => !entries.some((e) => e.rules.includes(v.rule) && e.match.test(v.snippet)))
  assert.deepEqual(unexplained.map((v) => `(${v.rule}) ${v.snippet}`), [])
})

test('静的な走査: 既知の例外・許可リストの項目はすべて何かに当たる（直した・消えた項目は一覧から消す）', () => {
  const stale = [...KNOWN_EXCEPTIONS, ...ALLOWED_TEXT].filter((e) => !uniqueViolations.some((v) => e.rules.includes(v.rule) && e.match.test(v.snippet)))
  assert.deepEqual(stale.map((e) => `${e.where}: ${e.match}`), [])
})

test('既知の例外は範囲 C・D だけで、理由を持つ（直した範囲 A・B は例外にしない）', () => {
  for (const e of KNOWN_EXCEPTIONS) {
    assert.ok(['C', 'D'].includes(e.range), `${e.where}: 範囲 ${e.range}`)
    assert.ok(e.reason && e.where, `${e.match}: 理由と箇所が要る`)
  }
  for (const e of ALLOWED_TEXT) assert.ok(e.reason && e.where, `${e.match}: 理由と箇所が要る`)
})
