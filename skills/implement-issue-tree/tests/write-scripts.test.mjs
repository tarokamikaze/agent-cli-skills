// PR 本文・コメント・resolve の書き込みと opt-in 記録の確認のスクリプト（Issue #11 の範囲 C: scripts/pr-body-edit.sh・
// optin-record-count.sh・pr-comment.sh・resolve-thread.sh）を、偽の gh（tests/lib/fake-gh.sh。pr edit・pr comment は
// 書き込みを再現する）に対して実行する回帰テスト。
//
// 検証する契約:
//   - 旧プロンプトが agent に実行させていたコマンド（このファイルに固定文字列で持つ。src から消えたのでここが旧の正本）と
//     同じ入力に対して、スクリプトが同じ結果（書き戻した PR 本文・投稿したコメント・数えた件数・送った mutation）になること
//   - agent が Write ツールで書く自由文は、ホストが渡した SHA-256 と一致するときだけ使い、ファイルは成否に関わらず消すこと
//   - 本文の取得の失敗・補正後が空・反映の確認の失敗では書き戻さない / 失敗を返すこと（fail-closed）
// ホストのプロンプトから実際にコマンドと Write する内容を取り出して流す端から端までの確認も行う。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { importDefinitions } from './lib/stub-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const BASHES = availableBashes()
const FAKE_GH = readFileSync(join(HERE, 'lib', 'fake-gh.sh'), 'utf8')
const defs = await importDefinitions([
  'lowFindingsCommentPrompt', 'prCreatePrompt', 'optinRecordMarkerLine', 'renderOptinRecordSection',
  'statePatchSha256', 'fileNonce', 'OPTIN_RECORD_HEADING', 'OPTIN_RECORD_MARKER_PREFIX', 'OPTIN_RECORD_HUMAN_PREFIX',
  'ensureBoundaryNonceSeed', 'implementPrompt', 'recoverImplementPrompt', 'fixPrompt', 'WRITTEN_FILE_COMMIT_GUARD',
], 'write-scripts')
// fixPrompt は境界トークンの seed を要する。seed の agent だけを stub にして入れる
globalThis.agent = async () => ({ seedHex: 'c'.repeat(64) })
await defs.ensureBoundaryNonceSeed()
const { optinRecordMarkerLine, renderOptinRecordSection, OPTIN_RECORD_HEADING, OPTIN_RECORD_MARKER_PREFIX, OPTIN_RECORD_HUMAN_PREFIX } = defs

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const OOS_HEADING = '## 対象外（out-of-scope）'

// --- 旧プロンプトのコマンド（変える前の src の文面そのまま。agent は 1 つの "$f" に対して順に実行していた）---
const OLD = {
  // prCreatePrompt 手順 1c の取得と Closes 行の追記
  fetchForEnsure: (pr) => `gh pr view ${pr} --json body --jq .body > "$f"`,
  closes: (issue) => `grep -qF "Closes #${issue}" "$f" || { echo; echo; echo "Closes #${issue}"; } >> "$f"`,
  // optinRecordUpdateInstructions 手順 b の取得
  fetchForOptin: (pr) => `gh pr view ${pr} --json body --jq '.body // ""' > "$f"`,
  // optinRecordRewriteLines の除去の実行行と追記の HEREDOC（<sha>・<result> は agent が置き換えていた）
  removeRecord: `g=$(mktemp); grep -avE -e '^[[:space:]]*## opt-in テスト実行記録[[:space:]]*$' -e '^[[:space:]]*<!-- optin-test-record: [^ ]+ [^ ]+ .+ -->[[:space:]]*$' -e '^[[:space:]]*- opt-in テスト結果: .+ => [^ ]+[[:space:]]*$' "$f" > "$g"; rc=$?; [ "$rc" -eq 0 ] && [ -s "$g" ] && mv "$g" "$f"`,
  appendRecord: (sha, result, commands) => [
    `cat >> "$f" <<'OPTIN_RECORD_EOF'`,
    '## opt-in テスト実行記録',
    ...commands.flatMap((c) => [`- opt-in テスト結果: ${c} => ${result}`, `<!-- optin-test-record: ${sha} ${result} ${c} -->`]),
    'OPTIN_RECORD_EOF',
  ].join('\n'),
  edit: (pr) => `gh pr edit ${pr} --body-file "$f" && rm -f "$f"`,
  // optinRecordVerifyPrompt 手順 1〜4（コマンドごとの 3 本の grep）
  count: (pr, commands) => [
    `j=$(mktemp); gh pr view ${pr} --json body,headRefOid > "$j"`,
    `H=$(jq -r '.headRefOid // ""' "$j")`,
    `f=$(mktemp); jq -r '.body // ""' "$j" > "$f"`,
    `g=$(mktemp); tr -d '\\r' < "$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$g"`,
    'echo "HEAD $H"',
    ...commands.flatMap((c, i) => [
      `pass=$(grep -cxF -- "<!-- optin-test-record: $H pass ${c} -->" "$g"); rc=$?`,
      `fail=$(grep -cxF -- "<!-- optin-test-record: $H fail ${c} -->" "$g"); rc=$?`,
      `notrun=$(grep -cxF -- "<!-- optin-test-record: $H not-run ${c} -->" "$g"); rc=$?`,
      `echo "COUNT ${i} $pass $((fail + notrun))"`,
    ]),
  ].join('\n'),
  // lowFindingsCommentPrompt（コメント本文は HEREDOC）
  comment: (pr, body) => `gh pr comment ${pr} --body "$(cat <<'LOWEOF'\n${body}\nLOWEOF\n)"`,
  // fixPrompt 手順 5
  resolve: (tid) => `gh api graphql -f query='mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}' -F tid=${tid}`,
}

const enc = (c) => c.replaceAll(' ', '%20')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const bound = (nonce, scope, text) => sha256(`${nonce}\n${scope}\n${text}`)

function setup(fixtures = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-write-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  writeFileSync(join(dir, 'calls.log'), '')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: dir }
  return {
    dir,
    run: (bash, script, args) => spawnSync(bash, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd: dir, env }),
    old: (bash, command) => spawnSync(bash, ['-c', command], { encoding: 'utf8', cwd: dir, env }),
    body: (pr) => JSON.parse(readFileSync(join(dir, `prview-${pr}.json`), 'utf8')).body,
    setBody: (pr, body, extra = {}) => writeFileSync(join(dir, `prview-${pr}.json`), JSON.stringify({ body, ...extra })),
    write: (nonce, text) => writeFileSync(join(dir, `.implement-issue-tree-${nonce}.md`), text),
    written: (nonce) => existsSync(join(dir, `.implement-issue-tree-${nonce}.md`)),
    calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trimEnd().split('\n').filter(Boolean),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const BODIES = [
  '## Summary\n- 要約\n\nCloses #42\n',
  `## Summary\n- 要約\n\nCloses #42${renderOptinRecordSection(['make e2e', 'go test ./...']).replaceAll('<sha>', SHA_A).replaceAll('<result>', 'fail')}\n`,
  `Closes #42\r\n\r\n  ${'## opt-in テスト実行記録'}\r\n  - opt-in テスト結果: make e2e => pass\r\n  ${'<!-- optin-test-record: '}${SHA_A} pass make e2e -->\r\n`,
  '## Summary\n本文に Closes が無い\n',
  '## Summary\n説明: ## opt-in テスト実行記録 という節が付く\n`- opt-in テスト結果: make e2e => pass` の形式\n\nCloses #42\n\n## 対象外（out-of-scope）\n- 既存の対象外\n',
]

test('lib/pr-write.sh の固定文字列はホストの OPTIN_RECORD_* と同じ', () => {
  const lib = readFileSync(join(SCRIPTS, 'lib', 'pr-write.sh'), 'utf8')
  assert.ok(lib.includes(`PW_OPTIN_HEADING='${OPTIN_RECORD_HEADING}'`))
  assert.ok(lib.includes(`PW_OPTIN_MARKER_PREFIX='${OPTIN_RECORD_MARKER_PREFIX}'`))
  assert.ok(lib.includes(`PW_OPTIN_HUMAN_PREFIX='${OPTIN_RECORD_HUMAN_PREFIX}'`))
})

test('ホストの照合値（statePatchSha256）と nonce（fileNonce）はスクリプトの照合の定義と同じ形', () => {
  assert.equal(defs.statePatchSha256('n1', 42, 'x\ny'), bound('n1', 42, 'x\ny'))
  assert.match(defs.fileNonce('a'), /^[0-9a-f]{32}$/)
  assert.notEqual(defs.fileNonce('a'), defs.fileNonce('b'))
})

test('コミットを作る手順（Implement・recover-implement・fix・PR 作成と fix の base 取り込みの解消）は、git add の前に残った .implement-issue-tree-*.md を消させる', () => {
  const guard = defs.WRITTEN_FILE_COMMIT_GUARD
  assert.ok(guard.includes('rm -f -- .implement-issue-tree-*.md') && guard.includes('コミットに含めない'))
  const item = { number: 5, title: 't' }
  const impl = { prNumber: 1005, branch: 'feat/5-x', worktreePath: '/repo/wt/5' }
  const finding = { summary: 's', unresolvedComments: [{ threadId: 'T1', text: 'x' }] }
  for (const [name, p] of [
    ['implement', defs.implementPrompt(item, 'plan')],
    ['recover-implement', defs.recoverImplementPrompt(item, { done: '', remaining: '', broken: '' }, 'feat/5-x')],
    ['fix（push する）', defs.fixPrompt(item, impl, finding, true)],
    ['fix（push しない）', defs.fixPrompt(item, impl, finding, false)],
  ]) {
    assert.ok(p.includes(guard), name)
  }
  // PR 作成は自分でコミットを作るのが base 取り込みの解消だけなので、その git commit の手前で消させる
  const pr = defs.prCreatePrompt(item, impl, [])
  const at = pr.indexOf('rm -f -- .implement-issue-tree-*.md')
  assert.ok(at > 0 && at < pr.indexOf('git commit --no-edit でコミットする', at), 'PR 作成の base 取り込みの解消で、git commit の前にある')
  // 消す形は、Write したファイルだけを消し、ほかのファイルを残す
  const dir = mkdtempSync(join(tmpdir(), 'iit-guard-'))
  try {
    for (const f of ['.implement-issue-tree-abc.md', '.implement-issue-tree-0f.md', 'keep.md', '.implement-issue-tree.md']) writeFileSync(join(dir, f), 'x')
    const r = spawnSync('bash', ['-c', 'rm -f -- .implement-issue-tree-*.md'], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!existsSync(join(dir, '.implement-issue-tree-abc.md')) && !existsSync(join(dir, '.implement-issue-tree-0f.md')))
    assert.ok(existsSync(join(dir, 'keep.md')) && existsSync(join(dir, '.implement-issue-tree.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Low 指摘のコメント: ホストは本文の末尾の改行を除いてから nonce と照合値を計算する（findings が空でもスクリプトの照合と一致する）', () => {
  for (const findings of ['', '指摘 A', ['指摘 B']]) {
    const p = defs.lowFindingsCommentPrompt({ number: 5 }, 21, findings)
    const [, nonce, hash] = p.match(/pr-comment\.sh 21 ([0-9a-z]+) ([0-9a-f]{64})/)
    const text = p.split(`=== UNTRUSTED_${nonce}_BEGIN ===\n`)[1].split(`\n=== UNTRUSTED_${nonce}_END ===`)[0]
    assert.doesNotMatch(text, /\n$/, JSON.stringify(findings))
    assert.equal(hash, bound(nonce, 21, text.replace(/\n+$/, '')), JSON.stringify(findings))
  }
})

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} pr-body-edit.sh oos-append: Issue を閉じる記法（closing keyword）を含む行は書き込まない`, () => {
    const nonce = 'c'.repeat(32)
    const line = (s) => `- [threadId: T1] ${s} — 理由: 範囲外 / 対応案: 別 PR（切り出し先 Issue: TBD）`
    for (const s of [
      'Closes #12', 'closes #12', 'FIXES #3', 'fixed: #7', 'Resolve #1', 'resolved  #99', 'see (fix #4)',
      'Closes other-owner/other-repo#5', 'fixes https://github.com/o/r/issues/8', 'close\t#2',
    ]) {
      const g = setup()
      g.setBody(4, 'Closes #1\n')
      g.write(nonce, line(s))
      const r = g.run(bash, 'pr-body-edit.sh', ['oos-append', '4', nonce, 'T1'])
      assert.equal(r.status, 1, s)
      assert.match(r.stderr, /Issue を閉じる記法/, s)
      assert.equal(g.calls().length, 0, `${s}: gh を呼ばない`)
      assert.ok(!g.written(nonce), `${s}: ファイルを残さない`)
      g.done()
    }
    // closing keyword の形でないものは書ける
    for (const s of ['fix の手順で直す', 'closes the gap (#12 とは別)', 'prefix #3', 'Issue #12 に関連', 'disclose #5 の扱い', 'unresolved #6']) {
      const g = setup()
      g.setBody(4, 'Closes #1\n')
      g.write(nonce, line(s))
      const r = g.run(bash, 'pr-body-edit.sh', ['oos-append', '4', nonce, 'T1'])
      assert.equal(r.status, 0, `${s}: ${r.stderr}`)
      assert.ok(g.body(4).includes(line(s)), s)
      g.done()
    }
  })

  test(`${tag} 端から端まで: findings が空の Low 指摘のコメントも照合を通って投稿できる`, () => {
    const p = defs.lowFindingsCommentPrompt({ number: 5 }, 22, '')
    const [, nonce, hash] = p.match(/pr-comment\.sh 22 ([0-9a-z]+) ([0-9a-f]{64})/)
    const text = p.split(`=== UNTRUSTED_${nonce}_BEGIN ===\n`)[1].split(`\n=== UNTRUSTED_${nonce}_END ===`)[0]
    const g = setup()
    try {
      g.write(nonce, `${text}\n`)
      const r = g.run(bash, 'pr-comment.sh', ['22', nonce, hash])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(join(g.dir, 'comment-22.md'), 'utf8'), text)
    } finally {
      g.done()
    }
  })

  test(`${tag} pr-body-edit.sh ensure: 旧手順 1c（取得・Closes 行の追記・記録節の書き直し・gh pr edit）と同じ本文を書き戻す`, () => {
    const commands = ['make e2e', 'go test ./...']
    for (const initial of BODIES) {
      for (const optin of [false, true]) {
        // 旧手順（agent が順に実行していたコマンドを 1 つの bash で流す）
        const o = setup()
        o.setBody(7, initial)
        const oldScript = [
          'f=$(mktemp)',
          OLD.fetchForEnsure(7),
          OLD.closes(42),
          ...(optin ? [OLD.removeRecord, OLD.appendRecord(SHA_B, 'pass', commands)] : []),
          OLD.edit(7),
        ].join('\n')
        const old = o.old(bash, oldScript)
        // 記録節だけの本文は旧手順でも除去の行が失敗する（ここでは扱わない）
        assert.equal(old.status, 0, old.stderr)
        // 新
        const n = setup()
        n.setBody(7, initial)
        const args = ['ensure', '7', '42', ...(optin ? ['--optin', SHA_B, 'pass,pass', ...commands.map(enc)] : [])]
        const r = n.run(bash, 'pr-body-edit.sh', args)
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.stdout, 'OK\n')
        assert.equal(n.body(7), o.body(7), JSON.stringify({ initial, optin }))
        assert.ok(n.body(7).includes('Closes #42'))
        o.done()
        n.done()
      }
    }
  })

  test(`${tag} pr-body-edit.sh optin: 旧手順 4b（取得・記録節の書き直し・gh pr edit）と同じ本文を書き戻し、2 回目も見出しは 1 個`, () => {
    const commands = ['make e2e', 'go test ./...']
    for (const initial of BODIES) {
      const o = setup()
      o.setBody(9, initial)
      const old = o.old(bash, ['f=$(mktemp)', OLD.fetchForOptin(9), OLD.removeRecord, OLD.appendRecord(SHA_B, 'not-run', commands), OLD.edit(9)].join('\n'))
      assert.equal(old.status, 0, old.stderr)
      const n = setup()
      n.setBody(9, initial)
      const r = n.run(bash, 'pr-body-edit.sh', ['optin', '9', SHA_B, 'not-run,not-run', ...commands.map(enc)])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(n.body(9), o.body(9))
      const r2 = n.run(bash, 'pr-body-edit.sh', ['optin', '9', SHA_A, 'pass,fail', ...commands.map(enc)])
      assert.equal(r2.status, 0, r2.stderr)
      const lines = n.body(9).split('\n')
      assert.equal(lines.filter((l) => l === OPTIN_RECORD_HEADING).length, 1)
      assert.equal(lines.filter((l) => l.includes(SHA_B)).length, 0)
      assert.ok(lines.includes(optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')))
      assert.ok(lines.includes(optinRecordMarkerLine(SHA_A, 'fail', 'go test ./...')))
      o.done()
      n.done()
    }
  })

  test(`${tag} pr-body-edit.sh: 取得の失敗・除去後が空・gh pr edit の失敗・反映されない、では本文を変えず非 0（fail-closed）`, () => {
    const only = `${OPTIN_RECORD_HEADING}\n${OPTIN_RECORD_HUMAN_PREFIX}make e2e => pass\n${optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')}\n`
    const cases = [
      ['取得の失敗', 'Closes #42\n', { 'err-prview-5': 'HTTP 502' }],
      ['記録節だけの本文', only, {}],
      ['gh pr edit の失敗', 'Closes #42\n', { 'err-predit-5': 'HTTP 422' }],
      ['反映されない', 'Closes #42\n', { 'noop-predit-5': '' }],
    ]
    for (const [name, initial, extra] of cases) {
      const g = setup(extra)
      g.setBody(5, initial)
      const r = g.run(bash, 'pr-body-edit.sh', ['optin', '5', SHA_B, 'pass', 'make%20e2e'])
      assert.equal(r.status, 1, name)
      assert.equal(r.stdout, '', name)
      assert.match(r.stderr, /^FAILED: /m, name)
      assert.equal(g.body(5), initial, name)
      if (name !== 'gh pr edit の失敗' && name !== '反映されない') assert.ok(!g.calls().some((c) => c.startsWith('pr edit')), name)
      g.done()
    }
  })

  test(`${tag} pr-body-edit.sh ensure --oos: Write ツールで書いた対象外節を照合してから足し、ファイルを消す。不一致・欠落では PR に触れない`, () => {
    const section = `${OOS_HEADING}\n- 別 Issue にする作業\n- $(rm -rf /) と \`x\` を含む行`
    const nonce = 'f'.repeat(32)
    const sha = bound(nonce, 42, section)
    // 取得した本文は gh の出力どおり末尾に改行が 1 つ付く（旧手順の "$f" と同じ）
    for (const [initial, expected] of [
      ['## Summary\n', `## Summary\n\n\n\nCloses #42\n\n${section}\n`],
      [`Closes #42\n\n${OOS_HEADING}\n- 既存\n`, `Closes #42\n\n${OOS_HEADING}\n- 既存\n\n`],
    ]) {
      const g = setup()
      g.setBody(3, initial)
      g.write(nonce, `${section}\n`)
      const r = g.run(bash, 'pr-body-edit.sh', ['ensure', '3', '42', '--oos', nonce, sha])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(g.body(3), expected)
      assert.ok(!g.written(nonce), 'Write ツールで書いたファイルを消す')
      g.done()
    }
    // 写し間違い・別の issue 向けの照合値・ファイルが無い
    for (const [name, text, hash] of [
      ['写し間違い', `${section} `, sha],
      ['別の issue 向け', section, bound(nonce, 43, section)],
      ['ファイルが無い', null, sha],
    ]) {
      const g = setup()
      g.setBody(3, '## Summary\n')
      if (text !== null) g.write(nonce, text)
      const r = g.run(bash, 'pr-body-edit.sh', ['ensure', '3', '42', '--oos', nonce, hash])
      assert.equal(r.status, 1, name)
      assert.equal(g.calls().length, 0, `${name}: gh を呼ばない`)
      assert.ok(!g.written(nonce), `${name}: ファイルを残さない`)
      g.done()
    }
  })

  test(`${tag} pr-body-edit.sh oos-append: 対象外節の末尾へ足し（無ければ作る）、記載済みの threadId は足さない。形・threadId の誤りは拒否`, () => {
    const nonce = 'e'.repeat(32)
    const line = (t, s = '指摘') => `- [threadId: ${t}] ${s} — 理由: 範囲外 / 対応案: 別 PR（切り出し先 Issue: TBD）`
    const cases = [
      // [初期本文, 書く行, 期待する本文]
      [`Closes #1\n\n${OOS_HEADING}\n- [threadId: T0] 既存\n\n## opt-in テスト実行記録\n- x\n`, [line('T1')],
        `Closes #1\n\n${OOS_HEADING}\n- [threadId: T0] 既存\n${line('T1')}\n\n## opt-in テスト実行記録\n- x\n\n`],
      ['Closes #1\n', [line('T1'), line('T2')], `Closes #1\n\n\n${OOS_HEADING}\n${line('T1')}\n${line('T2')}\n`],
      [`Closes #1\n\n${OOS_HEADING}\n${line('T1', '古い')}\n`, [line('T1'), line('T2')], `Closes #1\n\n${OOS_HEADING}\n${line('T1', '古い')}\n${line('T2')}\n\n`],
    ]
    for (const [initial, lines, expected] of cases) {
      const g = setup()
      g.setBody(4, initial)
      g.write(nonce, `${lines.join('\n')}\n`)
      const r = g.run(bash, 'pr-body-edit.sh', ['oos-append', '4', nonce, 'T0', 'T1', 'T2'])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(g.body(4), expected)
      assert.ok(!g.written(nonce))
      g.done()
    }
    // 足す行が無ければ書き戻さない
    const s = setup()
    s.setBody(4, `${OOS_HEADING}\n${line('T1')}\n`)
    s.write(nonce, line('T1'))
    assert.equal(s.run(bash, 'pr-body-edit.sh', ['oos-append', '4', nonce, 'T1']).stdout, 'OK\n')
    assert.ok(!s.calls().some((c) => c.startsWith('pr edit')))
    s.done()
    for (const [name, text] of [
      ['一覧に無い threadId', line('T9')],
      ['形が違う', '- 指摘だけ'],
      ['見出しを書く', `${OOS_HEADING}\n${line('T1')}`],
      ['空', '\n'],
    ]) {
      const g = setup()
      g.setBody(4, 'Closes #1\n')
      g.write(nonce, text)
      const r = g.run(bash, 'pr-body-edit.sh', ['oos-append', '4', nonce, 'T1'])
      assert.equal(r.status, 1, name)
      assert.equal(g.calls().length, 0, `${name}: gh を呼ばない`)
      assert.ok(!g.written(nonce), `${name}: ファイルを残さない`)
      g.done()
    }
  })

  test(`${tag} pr-body-edit.sh: 引数の形式の誤りは exit 2 で何もしない`, () => {
    const g = setup()
    try {
      for (const bad of [
        [], ['optin'], ['optin', 'x', SHA_A, 'pass', 'make'], ['optin', '1', 'abc', 'pass', 'make'],
        ['optin', '1', SHA_A, 'pass,pass', 'make'], ['optin', '1', SHA_A, 'ok', 'make'], ['optin', '1', SHA_A, 'pass', 'make e2e'],
        ['optin', '1', SHA_A, 'pass', 'make%22x'], ['optin', '1', SHA_A, 'pass', '-make'], ['optin', '1', SHA_A, 'pass', "make'"],
        ['ensure', '1'], ['ensure', '1', '2', '--oos', 'N', 'a'.repeat(64)], ['ensure', '1', '2', '--oos', 'n', 'x'],
        ['ensure', '1', '2', '--other'], ['oos-append', '1', 'n'], ['oos-append', '1', 'n', 'T;1'], ['other', '1'],
      ]) {
        const r = g.run(bash, 'pr-body-edit.sh', bad)
        assert.equal(r.status, 2, bad.join(' '))
      }
      assert.equal(g.calls().length, 0)
    } finally {
      g.done()
    }
  })

  test(`${tag} optin-record-count.sh: 旧手順（本文の正規化と grep -cxF の 3 本）と同じ件数・HEAD を出す。取得失敗・形式不正は何も出さず非 0`, () => {
    const commands = ['make e2e', 'go test ./...', 'cargo test -- --ignored']
    const body = [
      'Closes #1',
      optinRecordMarkerLine(SHA_A, 'pass', 'make e2e'),
      `   ${optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')}\r`,
      optinRecordMarkerLine(SHA_B, 'pass', 'go test ./...'),
      optinRecordMarkerLine(SHA_A, 'fail', 'go test ./...'),
      optinRecordMarkerLine(SHA_A, 'not-run', 'go test ./...'),
      `x ${optinRecordMarkerLine(SHA_A, 'pass', 'cargo test -- --ignored')}`,
    ].join('\n')
    const g = setup({ 'prview-8.json': { body, headRefOid: SHA_A } })
    try {
      const old = g.old(bash, OLD.count(8, commands))
      assert.equal(old.status, 0, old.stderr)
      const r = g.run(bash, 'optin-record-count.sh', ['8', ...commands.map(enc)])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, old.stdout)
      assert.equal(r.stdout, `HEAD ${SHA_A}\nCOUNT 0 2 0\nCOUNT 1 0 2\nCOUNT 2 0 0\n`)
      assert.ok(g.calls().every((c) => c === 'pr view 8 --json body,headRefOid'), '旧手順と同じ 1 回の取得')
      assert.ok(!r.stdout.includes('Closes'), '本文を出さない')
      for (const [name, fixture] of [['headRefOid が不正', { body, headRefOid: 'abc' }], ['headRefOid が無い', { body }]]) {
        writeFileSync(join(g.dir, 'prview-8.json'), JSON.stringify(fixture))
        const f = g.run(bash, 'optin-record-count.sh', ['8', 'make%20e2e'])
        assert.equal(f.status, 1, name)
        assert.equal(f.stdout, '', name)
      }
      writeFileSync(join(g.dir, 'err-prview-8'), 'HTTP 502')
      const e = g.run(bash, 'optin-record-count.sh', ['8', 'make%20e2e'])
      assert.equal(e.status, 1)
      assert.equal(e.stdout, '')
      for (const bad of [[], ['x'], ['8', 'make e2e'], ['8', '%2e']]) assert.equal(g.run(bash, 'optin-record-count.sh', bad).status, 2, bad.join(' '))
    } finally {
      g.done()
    }
  })

  test(`${tag} pr-comment.sh: 旧コマンド（--body の HEREDOC）と同じ本文を投稿する。照合が一致しなければ投稿せず、ファイルを消す`, () => {
    const body = '## 見出し\n\n本文 $HOME `x` \\$y\nLOWEOF\n末尾'
    const nonce = 'd'.repeat(32)
    const g = setup()
    try {
      assert.equal(g.old(bash, OLD.comment(11, body)).status, 0)
      const oldPosted = readFileSync(join(g.dir, 'comment-11.md'), 'utf8')
      rmSync(join(g.dir, 'comment-11.md'))
      // 旧コマンドは HEREDOC の LOWEOF の行で早く閉じる（本文に LOWEOF を含むと壊れていた）。ここでは閉じる前までを比べる
      assert.equal(oldPosted, body.slice(0, body.indexOf('\nLOWEOF')))
      const safe = body.slice(0, body.indexOf('\nLOWEOF'))
      g.write(nonce, `${safe}\n`)
      const r = g.run(bash, 'pr-comment.sh', ['11', nonce, bound(nonce, 11, safe)])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(join(g.dir, 'comment-11.md'), 'utf8'), oldPosted)
      assert.ok(!g.written(nonce))
      // LOWEOF を含む本文もそのまま投稿できる
      g.write(nonce, body)
      assert.equal(g.run(bash, 'pr-comment.sh', ['11', nonce, bound(nonce, 11, body)]).status, 0)
      assert.equal(readFileSync(join(g.dir, 'comment-11.md'), 'utf8'), body)
      rmSync(join(g.dir, 'comment-11.md'))
      for (const [name, text, hash] of [['写し間違い', `${safe}x`, bound(nonce, 11, safe)], ['別の PR 向け', safe, bound(nonce, 12, safe)], ['無い', null, bound(nonce, 11, safe)]]) {
        if (text !== null) g.write(nonce, text)
        const f = g.run(bash, 'pr-comment.sh', ['11', nonce, hash])
        assert.equal(f.status, 1, name)
        assert.ok(!existsSync(join(g.dir, 'comment-11.md')), `${name}: 投稿しない`)
        assert.ok(!g.written(nonce), `${name}: ファイルを残さない`)
      }
      for (const bad of [['11', nonce], ['x', nonce, 'a'.repeat(64)], ['11', 'N', 'a'.repeat(64)], ['11', nonce, 'x']]) {
        assert.equal(g.run(bash, 'pr-comment.sh', bad).status, 2, bad.join(' '))
      }
    } finally {
      g.done()
    }
  })

  test(`${tag} resolve-thread.sh: 旧コマンドと同じ mutation を送り、出力と終了コードをそのまま返す`, () => {
    const g = setup({ 'graphql.json': { data: { resolveReviewThread: { thread: { id: 'PRRT_x1', isResolved: true } } } } })
    try {
      const old = g.old(bash, OLD.resolve('PRRT_x1'))
      const r = g.run(bash, 'resolve-thread.sh', ['PRRT_x1'])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, old.stdout)
      const [oc, nc] = g.calls()
      // threadId は -f（文字列）で渡す（旧コマンドの -F は数値・真偽値に見える値を型変換する）。それ以外は同じ
      assert.equal(oc, 'api graphql -f query=mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}} -F tid=PRRT_x1')
      assert.equal(nc, oc.replace('-F tid=', '-f tid='), '同じ mutation')
      writeFileSync(join(g.dir, 'err-graphql'), 'GraphQL: Could not resolve to a node')
      assert.equal(g.run(bash, 'resolve-thread.sh', ['PRRT_x1']).status, 1)
      for (const bad of [[], ['a b'], ['x;y'], ['a', 'b'], ['x'.repeat(101)]]) assert.equal(g.run(bash, 'resolve-thread.sh', bad).status, 2, bad.join(' '))
    } finally {
      g.done()
    }
  })

  test(`${tag} 端から端まで: ホストのプロンプトの Write する内容とコマンドをそのまま使うと、照合を通って書き込める`, () => {
    // Low 指摘のコメント
    const low = defs.lowFindingsCommentPrompt({ number: 5 }, 21, '指摘 A: `x` を直す $HOME')
    const [, nonce, hash] = low.match(/pr-comment\.sh 21 ([0-9a-z]+) ([0-9a-f]{64})/)
    const text = low.split(`=== UNTRUSTED_${nonce}_BEGIN ===\n`)[1].split(`\n=== UNTRUSTED_${nonce}_END ===`)[0]
    const g = setup()
    try {
      g.write(nonce, `${text}\n`)
      const r = g.run(bash, 'pr-comment.sh', ['21', nonce, hash])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(readFileSync(join(g.dir, 'comment-21.md'), 'utf8').startsWith('## 最終 Review で許容した Low 指摘'))
      // PR 作成の手順 1c の対象外節
      const pr = defs.prCreatePrompt({ number: 42, title: 't' }, { prNumber: 0, branch: 'feat/42-x' }, ['範囲外の作業 $x'])
      const [, n2, h2] = pr.match(/ensure <番号> 42 --oos ([0-9a-z]+) ([0-9a-f]{64})/)
      const sec = pr.split(`=== UNTRUSTED_${n2}_BEGIN ===\n`)[1].split(`\n=== UNTRUSTED_${n2}_END ===`)[0]
      assert.ok(sec.startsWith(OOS_HEADING))
      g.setBody(30, '## Summary\n')
      g.write(n2, sec)
      const e = g.run(bash, 'pr-body-edit.sh', ['ensure', '30', '42', '--oos', n2, h2])
      assert.equal(e.status, 0, e.stderr)
      assert.ok(g.body(30).includes(`${sec}\n`))
    } finally {
      g.done()
    }
  })
}
