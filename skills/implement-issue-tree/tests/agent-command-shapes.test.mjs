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
  'writeBlockedStateChunk', 'precheckScriptHashes', 'declaredDepsPrompt', 'outOfTreeStatePrompt', 'rootAncestorsPrompt',
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
    // Recover の破棄（worktree とブランチの削除）。preserveWorktreeField の有無で手順 2 の文面が変わる
    await call(() => d.updateStateDetailed(5, { status: 'pending', branch: 'feat/5-x' }, { cleanupWorktree: '/repo/wt 5', deleteBranch: true }))
    await call(() => d.updateStateDetailed(5, { status: 'pending', branch: 'feat/5-x' }, { cleanupWorktree: '/repo/wt/r5', preserveWorktreeField: true }))
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
    await call(() => d.precheckScriptHashes())
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

test('同梱スクリプト・単独のコマンドへ移した箇所が、マトリクスで実際に組み立てられている', () => {
  const all = collected.recorded.join('\n')
  for (const name of [
    // fork で同梱スクリプトにしたもの（状態ファイル・GitHub の読み取り）
    // state-verify.sh は loadState の 2 段目で、記録用の agent が 1 段目に null を返すため組み立てまで進まない（state-scripts.test.mjs が見る）
    'nonce-seed.sh', 'compare-files.sh', 'state-read.sh', 'fetch-tree.sh', 'fetch-root-ancestors.sh',
    'probe-declared-deps.sh', 'probe-prereqs.sh',
    // upstream の同梱スクリプト（状態ファイルの書き込み・CI の観測・マージ直前の検証・push・掃除・測定）
    'state.sh', 'observe-pr.sh', 'merge-gate.sh', 'pr-push.sh', 'worktree-remove.sh', 'measure-residual-bytes.sh',
    // PR 本文・コメントの書き込みと opt-in 記録の確認（自由文は Write ツールのファイルで渡す）
    'pr-body-edit.sh', 'pr-comment.sh', 'optin-record-count.sh',
  ]) {
    assert.ok(all.includes(` ${name}`), `${name} を起動するコマンドが組み立てられていない`)
  }
  assert.ok(all.includes(`bash '${STUB_SKILL_DIR}/scripts/run-verified.sh' `))
  assert.ok(collected.recorded.includes('git fetch origin'), 'Implement・recover-implement・fix の fetch を単独にした')
  // 状態ファイルへの書き込みは JSON をコマンド行に載せず、Write ツールの入力ファイルを照合値付きで読ませる
  assert.ok(collected.recorded.some((c) => / state\.sh --file _\/issue-trees\/1\.json merge --input-nonce [0-9a-z]+ --input-sha [0-9a-f]{64}$/.test(c)))
  assert.ok(collected.recorded.some((c) => / state\.sh --file _\/issue-trees\/1\.json init --input-nonce [0-9a-z]+ --input-sha [0-9a-f]{64}$/.test(c)))
  assert.ok(all.includes(' state.sh --file _/issue-trees/1.json clear-worktree --issue 5'), '掃除後の .worktree のクリア')
  // closePrompt の子孫の再帰取得と、コメント・クローズの単独のコマンド
  assert.ok(all.includes(' fetch-tree.sh 5'))
  for (const c of ['gh issue comment 5 --body-file <そのファイルの絶対パス>', 'gh issue close 5']) {
    assert.ok(collected.recorded.includes(c), `単独のコマンドにした ${c}`)
  }
  assert.ok(collected.recorded.some((c) => /^rm -f -- \.implement-issue-tree-[0-9a-f]{32}\.md$/.test(c)), '完了サマリーの一時ファイルの削除も単独のコマンド')
})

test('再利用 PR の本文の補正は、ブランチ名・ベース名を URL エンコードして渡す。コミットの前に一時ファイルの除外設定を起動させる（Issue #18・#21）', () => {
  const all = collected.recorded.join('\n')
  // スクリプトが PR の head・base・isCrossRepository と照合する
  assert.match(all, / pr-body-edit\.sh (--repo \S+ )?ensure <番号> 5 feat%2F5-x main --oos /, 'PR 作成の手順 1c（対象外節あり）')
  assert.match(all, / pr-body-edit\.sh (--repo \S+ )?ensure <番号> 6 feat%2F5-x release%2Fv1\.2/, 'PR 作成の手順 1c（ベースブランチに / を含む）')
  assert.ok(collected.recorded.some((c) => / worktree-exclude\.sh$/.test(c)), 'コミットの前の一時ファイルの除外設定（引数なし）')
  // 起動時のハッシュ予検査（--verify-only のヒアドキュメントに全スクリプト名が並ぶ）は除き、起動するコマンドだけを見る
  for (const c of collected.recorded.filter((x) => / pr-body-edit\.sh | worktree-exclude\.sh$/.test(x) && !x.includes('--verify-only'))) {
    assert.doesNotMatch(c.replace(/^bash '[^']+'/, ''), /["'{}]/, `引数に引用符・{} を含めない: ${c}`)
  }
})

test('merge-exec のマージは変数の代入・引用符・連結なしの単独の gh pr merge 1 本', () => {
  assert.ok(collected.recorded.includes('gh pr merge 1005 --squash --delete-branch --match-head-commit <HEAD sha>'), 'sha を値で埋め込む単独のコマンド')
  for (const c of collected.recorded.filter((x) => x.includes('gh pr merge'))) {
    assert.match(c, /^gh pr merge \d+ --squash --delete-branch --match-head-commit <HEAD sha>$/)
  }
})

// 利用側の Claude Code は、brace（{}・${}）と引用符が同じコマンド文字列に同居すると「展開による難読化」として
// 毎回確認を出す（Workflow の agent は答えられず止まる）。ヒアドキュメントの本文もコマンド文字列の一部として数える。
// 目印を付けたコマンドの全文（ヒアドキュメントの本文を含む）にこの同居が無いことを確かめる。
// 例外は、外部チェックの宣言（JSON）を merge-gate.sh へ単一引用符で渡す形だけ（外部チェックを宣言したランに限る）。
const BRACE_QUOTE_EXCEPTIONS = [
  {
    where: 'mergeGateCommand（外部チェックを宣言したランの --external）',
    match: / merge-gate\.sh --nonce \S+ --pr \d+ --base \S+(?: --expect-sha [0-9a-f]{40})? --external '\[\{"app":/,
    reason: 'upstream の merge-gate.sh は宣言を JSON 1 つで受け、封筒の inputSha256 がその文字列を束縛する。externalChecks: [] のランでは付かない',
  },
]
function hasBraceAndQuote(c) {
  return /[{}]/.test(c) && /['"]/.test(c)
}

test('目印を付けたコマンドは、brace と引用符を同じコマンド文字列に含まない（ヒアドキュメントの本文を含む）', () => {
  const bad = [...new Set(collected.recorded)].filter((c) => hasBraceAndQuote(c) && !BRACE_QUOTE_EXCEPTIONS.some((e) => e.match.test(c)))
  assert.deepEqual(bad, [])
  for (const e of BRACE_QUOTE_EXCEPTIONS) {
    assert.ok(collected.recorded.some((c) => hasBraceAndQuote(c) && e.match.test(c)), `${e.where}: 例外がもう当たらない（一覧から消す）`)
  }
})

// ヒアドキュメントで標準入力に渡しているコマンド。本文に brace を含まない（上のテストが見る）ものだけが残る。
// 一覧に無いヒアドキュメントが増えたら失敗にし、増やす PR で理由を書く。
const HEREDOC_ALLOWED = [
  { where: 'precheckScriptHashes（--verify-only の表）', match: /run-verified\.sh' --verify-only --nonce \S+ <<'HASHESEOF_/, reason: '表は「sha256 スクリプト名」の行だけ（brace・引用符を含まない）' },
  { where: 'measureResidualBytesOnce（測るパスの一覧）', match: / measure-residual-bytes\.sh --nonce \S+ <<'PATHSEOF_/, reason: 'パスは sanitizeWorktreePath を通した英数字・/・-・_・.・空白だけ' },
  { where: 'sweepClosedWorktrees（削除候補のパスの JSON 配列）', match: / worktree-remove\.sh sweep --file \S+ <<'SWEEP_EOF_/, reason: '文字列の配列で brace を含まない（パスは sanitizeWorktreePath を通した値）' },
]

test('目印を付けたコマンドのヒアドキュメントは、許可した 3 箇所（本文に brace を含まない）だけ', () => {
  const heredocs = [...new Set(collected.recorded)].filter((c) => /<<-?'/.test(c))
  const unexplained = heredocs.filter((c) => !HEREDOC_ALLOWED.some((e) => e.match.test(c)))
  assert.deepEqual(unexplained, [])
  for (const e of HEREDOC_ALLOWED) {
    assert.ok(heredocs.some((c) => e.match.test(c)), `${e.where}: 例外がもう当たらない（一覧から消す）`)
  }
})

// --- 静的な走査 ---

// 既知の例外（Issue #11）。merge-exec の G0 は merge-gate.sh、マージは単独の gh pr merge、PR 本文・コメントの書き込みは
// pr-body-edit.sh・optin-record-count.sh・pr-comment.sh、削除と終了時の処理は worktree-remove.sh に移したので、一覧は空。
// resolve の mutation は gh api graphql の 1 コマンドのまま（scripts/ の静的ガードが mutation のスクリプト化を禁じる。
// (a)〜(d) のどれにも当たらない）。新しい例外は足さない
// （足すときは range・where・rules・match・reason を持たせる。match は検出した断片〔extractCommandCandidates の 1 行の
// 切り出し、または extractCommandBlocks の複数行の塊〕に当てる正規表現）
const KNOWN_EXCEPTIONS = []

// コマンドではない文、または agent に実行させない例（やってはいけない例の説明など）
// （upstream で PR 作成・push 後の確認が pr-push.sh・observe-pr.sh に移り、「head branch」「head sha」の説明文は消えた）
const ALLOWED_TEXT = []

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

test('静的な走査: 検出したコマンドは、既知の例外（範囲 C）か許可リストに理由付きで載っている', () => {
  const entries = [...KNOWN_EXCEPTIONS, ...ALLOWED_TEXT]
  const unexplained = uniqueViolations.filter((v) => !entries.some((e) => e.rules.includes(v.rule) && e.match.test(v.snippet)))
  assert.deepEqual(unexplained.map((v) => `(${v.rule}) ${v.snippet}`), [])
})

test('静的な走査: 既知の例外・許可リストの項目はすべて何かに当たる（直した・消えた項目は一覧から消す）', () => {
  const stale = [...KNOWN_EXCEPTIONS, ...ALLOWED_TEXT].filter((e) => !uniqueViolations.some((v) => e.rules.includes(v.rule) && e.match.test(v.snippet)))
  assert.deepEqual(stale.map((e) => `${e.where}: ${e.match}`), [])
})

test('既知の例外は範囲 C だけで、理由を持つ（直した範囲 A・B・D は例外にしない）', () => {
  for (const e of KNOWN_EXCEPTIONS) {
    assert.ok(['C'].includes(e.range), `${e.where}: 範囲 ${e.range}`)
    assert.ok(e.reason && e.where, `${e.match}: 理由と箇所が要る`)
  }
  for (const e of ALLOWED_TEXT) assert.ok(e.reason && e.where, `${e.match}: 理由と箇所が要る`)
})
