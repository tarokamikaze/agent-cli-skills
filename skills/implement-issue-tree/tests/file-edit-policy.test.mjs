// Workflow の agent がシェルでファイルを編集・コミットして権限の確認で止まる事象（Issue #27）の回帰テスト。
//
// 契約: (A) ファイルを編集・コミットする agent（Implement・recover-implement・fix・PR 作成）のプロンプトに、
// 編集は Edit / Write ツールに限ること・シェルでの編集の禁止形・作業ディレクトリ外のファイルを < で渡さないこと・
// git commit は -m か -F <作業ディレクトリ内のファイル> で行うことを入れる、
// (B) 以前の「git commit に </dev/null を付ける」指示は消す（作業ディレクトリ外のファイルを入力に渡す形で確認が出るため）、
// (C) 取り込み側の hook の設定例（references/automerge-design.md）に、その形を拒否する PreToolUse hook の例を載せる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { BASE_ARGS, definitionPart } from './lib/stub-run.mjs'

const EXPORTS = ['ensureBoundaryNonceSeed', 'FILE_EDIT_POLICY', 'COMMON', 'COMMON_LINES', 'implementPrompt', 'prCreatePrompt', 'fixPrompt', 'recoverImplementPrompt']
const dir = trackTmp(mkdtempSync(join(tmpdir(), 'implement-issue-tree-file-edit-')))
const path = join(dir, 'defs.mjs')
writeFileSync(path, `const args = ${JSON.stringify(BASE_ARGS)}\n${definitionPart}\nexport { ${EXPORTS.join(', ')} }\n`)
const m = await import(pathToFileURL(path).href)

// 境界トークンを使うプロンプトのため、nonce:seed だけ値を返す
globalThis.agent = async (_prompt, opts) => (opts?.label === 'nonce:seed' ? { seedHex: 'c'.repeat(64) } : null)
globalThis.log = () => {}
globalThis.phase = () => {}
await m.ensureBoundaryNonceSeed()

const item = { number: 5, title: 'issue 5' }
const impl = { prNumber: 1005, branch: 'feat/5-x', worktreePath: '/repo/wt/5' }
const finding = { summary: 's', unresolvedComments: [{ threadId: 'T1', text: 'fix', url: 'https://example.invalid/1', path: 'a.go' }] }

// プロンプトに入っていてほしい語句。禁止形の一覧は、エージェントが読んで避けられるように原文のまま載せる
const REQUIRED = [
  'Edit / Write ツール',
  'python -c',
  'python3 -',
  'ヒアドキュメント',
  'sed -i',
  'perl -i',
  'printf',
  '作業ディレクトリの外',
  '<',
  'git commit',
  '-m',
  '-F <作業ディレクトリ内のファイル>',
]

const prompts = {
  implement: () => m.implementPrompt(item, 'plan'),
  recoverImplement: () => m.recoverImplementPrompt(item, { done: 'd', remaining: 'r', broken: 'b' }, 'feat/5-x'),
  fix: () => m.fixPrompt(item, impl, finding, true, ['T1'], ['/repo/wt/5']),
  fixNoPush: () => m.fixPrompt(item, impl, finding, false, [], []),
  prCreate: () => m.prCreatePrompt(item, impl, []),
}

for (const [name, build] of Object.entries(prompts)) {
  test(`A: ${name} のプロンプトにファイル編集とコミットの形の規則が入っている`, async () => {
    const text = String(await build())
    assert.ok(text.includes(m.FILE_EDIT_POLICY), 'FILE_EDIT_POLICY がプロンプトに入っていない')
    for (const word of REQUIRED) assert.ok(text.includes(word), `${word} が無い`)
  })

  test(`B: ${name} のプロンプトは git commit に </dev/null を付ける指示を持たない`, async () => {
    const text = String(await build())
    assert.ok(!text.includes('git commit に </dev/null'), '旧指示が残っている')
    assert.ok(!text.includes('</dev/null を付ける'), '旧指示が残っている')
  })
}

test('A: FILE_EDIT_POLICY は COMMON の一部で、COMMON_LINES の末尾（長時間コマンドの規則）の位置は動かさない', () => {
  assert.ok(m.COMMON.includes(m.FILE_EDIT_POLICY))
  assert.ok(!m.COMMON_LINES.includes(m.FILE_EDIT_POLICY))
})

test('C: automerge-design.md に、シェルでの編集とコミットの形を拒否する PreToolUse hook の例がある', () => {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'automerge-design.md'), 'utf8')
  const section = doc.slice(doc.indexOf('シェルでの編集'))
  assert.ok(doc.includes('シェルでの編集'), '節が無い')
  for (const word of ['PreToolUse', '"permissionDecision":"deny"','sed -i', 'perl -i', 'python3 -', '</dev/null', 'Edit']) {
    assert.ok(section.includes(word), `${word} が例に無い`)
  }
})
