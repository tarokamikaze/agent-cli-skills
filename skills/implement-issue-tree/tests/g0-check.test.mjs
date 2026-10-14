// merge-exec の G0 ゲートの同梱スクリプト（Issue #11 の範囲 B: scripts/g0-check.sh）を、偽の gh（tests/lib/fake-gh.sh。
// fixture の JSON に本物の jq を適用する）に対して実行する回帰テスト。
//
// 検証する契約: 旧プロンプト（merge-exec の手順 2b (i)〜(v-b)）が agent に実行させていたコマンド（このファイルに固定文字列で
// 持つ。src から消えたのでここが旧の正本）を同じ入力に対して実行し、旧プロンプトの判定の手順どおりにテスト側で読んだ値・
// 順序・辞退の reason が、スクリプトの出力（判定ごとの行と verdict）と一致すること。取得の失敗を合格に倒さないこと。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { importDefinitions } from './lib/stub-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const BASHES = availableBashes()
const FAKE_GH = readFileSync(join(HERE, 'lib', 'fake-gh.sh'), 'utf8')
const { g0ContextArg } = await importDefinitions(['g0ContextArg'], 'g0-check')

const SHA = 'a'.repeat(40)
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// --- 旧プロンプトのコマンド（変える前の src の文面そのまま。<...> の目印だけ値に置き換える）---
const OLD = {
  i: (base) => `gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq '[.[][] | select(.type == "required_status_checks")] | length'`,
  ibList: (base) => `gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq '[.[][] | {id: .ruleset_id, src: .ruleset_source_type}] | unique'`,
  ibBypass: (id) => `gh api "repos/{owner}/{repo}/rulesets/${id}" --jq '.bypass_actors | type == "array" and length == 0'`,
  iii: (base) => `gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq '[.[][] | select(.type == "pull_request")] | any(.parameters.required_review_thread_resolution == true)'`,
  ivAppId: (app) => `gh api "apps/${app}" --jq '.id'`,
  ivCtx: (base, app, ctx) => {
    const appVar = `APP_ID_${app.toUpperCase().replace(/-/g, '_')}`
    return [
      `${appVar}=$(gh api "apps/${app}" --jq '.id')`,
      `gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq --argjson appid "$${appVar}" --arg ctx ${shq(ctx)} '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | select(.integration_id == $appid and .context == $ctx)] | length'`,
    ].join('\n')
  },
  // (v)・(v-b) は 1 回の Bash 実行でまとめて流していた塊。出力のどの行がどの値かを取り違えないよう、代入の行に
  // 判定のコマンドを 1 本ずつ足して実行する（同じ塊を 2 回流すのと同じ）
  vHead: (base) => [
    `HEAD_SHA="${SHA}"`,
    `REQ=$(gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq -c '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique')`,
  ],
  vRuns: `gh api --paginate --slurp "repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs" | jq --argjson req "$REQ" '[.[].check_runs[].name | select(. as $n | ($req | index($n)) | not)] | length'`,
  vStatuses: `gh api --paginate --slurp "repos/{owner}/{repo}/commits/$HEAD_SHA/statuses" | jq --argjson req "$REQ" '[.[][].context] | unique | map(select(. as $c | ($req | index($c)) | not)) | length'`,
  vbHead: (base) => [
    `HEAD_SHA="${SHA}"`,
    `RSC=$(gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/${base}" | jq -c '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | {context: .context, integration_id: .integration_id}] | unique')`,
  ],
  vb1: `printf '%s' "$RSC" | jq '[.[] | select((.integration_id | type) != "number")] | length'`,
  vb2: `gh api --paginate --slurp "repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs" | jq --argjson rsc "$RSC" '[.[].check_runs[] | {n: .name, a: .app.id}] as $runs | [$rsc[] | select(. as $r | ($runs | any(.n == $r.context and .a == $r.integration_id)) | not)] | length'`,
}

function setup(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-g0-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  writeFileSync(join(dir, 'calls.log'), '')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: dir }
  return {
    dir,
    run: (bash, args) => spawnSync(bash, [join(SCRIPTS, 'g0-check.sh'), ...args], { encoding: 'utf8', cwd: dir, env }),
    old: (bash, command) => spawnSync(bash, ['-c', command], { encoding: 'utf8', cwd: dir, env }),
    calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trimEnd().split('\n').filter(Boolean),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// 旧コマンドの出力を、旧プロンプトの agent が読んだとおりに読む。非負整数 1 個（または true / false）が出なければ「取得不能」
const count = (r) => (r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? r.stdout.trim() : 'error')

// 旧プロンプトの手順 2b を、書かれた順序と辞退の条件どおりにたどり、スクリプトと同じ「<判定名> <値>」の行と verdict にする
function oldG0(g, bash, base, decl) {
  const out = []
  const end = (verdict) => `${[...out, `verdict ${verdict}`].join('\n')}\n`
  // (i) 0 件・エラーは (ii) classic-unsupported
  const i = count(g.old(bash, OLD.i(base)))
  out.push(`required-status-check-rules ${i}`)
  if (i === 'error' || i === '0') return end('classic-unsupported')
  // (i-b) 列挙の全要素が「数値の id + src が "Repository"」。次に各 id の bypass が true
  const listR = g.old(bash, OLD.ibList(base))
  let list = null
  try {
    if (listR.status === 0) list = JSON.parse(listR.stdout)
  } catch {
    list = null
  }
  const nonRepo = Array.isArray(list) ? String(list.filter((e) => typeof e.id !== 'number' || e.src !== 'Repository').length) : 'error'
  out.push(`non-repository-rulesets ${nonRepo}`)
  if (nonRepo !== '0') return end('server-enforcement-missing')
  let bypass = 0
  for (const id of [...new Set(list.map((e) => e.id))].sort((a, b) => a - b)) {
    const r = g.old(bash, OLD.ibBypass(id))
    if (r.status !== 0) {
      bypass = 'error'
      break
    }
    if (r.stdout.trim() !== 'true') bypass++
  }
  out.push(`rulesets-with-bypass ${bypass}`)
  if (bypass !== 0) return end('server-enforcement-missing')
  // (iii)
  const t = g.old(bash, OLD.iii(base))
  const thread = t.status === 0 && ['true', 'false'].includes(t.stdout.trim()) ? t.stdout.trim() : 'error'
  out.push(`thread-resolution-required ${thread}`)
  if (thread !== 'true') return end('server-enforcement-missing')
  // (iv) App ごとに App ID（数値でなければ辞退）→ その App の context ごとに件数 1 以上
  let unbound = 0
  outer: for (const { app, contexts } of decl) {
    if (count(g.old(bash, OLD.ivAppId(app))) === 'error') {
      unbound = 'error'
      break
    }
    for (const ctx of contexts) {
      const c = count(g.old(bash, OLD.ivCtx(base, app, ctx)))
      if (c === 'error') {
        unbound = 'error'
        break outer
      }
      if (c === '0') unbound++
    }
  }
  out.push(`unbound-external-contexts ${unbound}`)
  if (unbound !== 0) return end('server-enforcement-missing')
  // (v) 2 つとも 0
  const cr = count(g.old(bash, [...OLD.vHead(base), OLD.vRuns].join('\n')))
  const st = count(g.old(bash, [...OLD.vHead(base), OLD.vStatuses].join('\n')))
  out.push(`client-only-check-runs ${cr}`, `client-only-statuses ${st}`)
  if (cr !== '0' || st !== '0') return end('server-enforcement-missing')
  // (v-b) 1 つ目が 1 以上・取得不能は issuer-unbound、1 つ目が 0 で 2 つ目だけ 1 以上は checks-not-green
  const u1 = count(g.old(bash, [...OLD.vbHead(base), OLD.vb1].join('\n')))
  const u2 = count(g.old(bash, [...OLD.vbHead(base), OLD.vb2].join('\n')))
  out.push(`required-checks-without-integration-id ${u1}`, `required-contexts-without-bound-run ${u2}`)
  if (u1 !== '0' || u2 === 'error') return end('issuer-unbound')
  if (u2 !== '0') return end('checks-not-green')
  return end('pass')
}

// --- fixture ---
const CI = { context: 'ci', integration_id: 15368 }
const BUGBOT = { context: 'Cursor Bugbot', integration_id: 1001 }
const SONAR = { context: 'SonarCloud Code Analysis', integration_id: 2002 }
const ODD = `it's {a|b} "日本" (x)*!~`
const ODD_CHECK = { context: ODD, integration_id: 3003 }
const rsc = (checks, id = 10) => ({ type: 'required_status_checks', ruleset_id: id, ruleset_source_type: 'Repository', parameters: { strict_required_status_checks_policy: false, required_status_checks: checks } })
const pr = (resolution, id = 10) => ({ type: 'pull_request', ruleset_id: id, ruleset_source_type: 'Repository', parameters: { required_review_thread_resolution: resolution } })
const checkRun = (name, appId) => ({ name, app: { id: appId, slug: `app-${appId}` }, status: 'completed', conclusion: 'success' })
const okRuleset = { id: 10, bypass_actors: [] }

// 全判定に合格する構成（ルールは 2 ページ。required は ci・Cursor Bugbot・SonarCloud）
function passing() {
  return {
    'rules-main.pages.json': [[rsc([CI, BUGBOT]), pr(true)], [rsc([SONAR], 11)]],
    'ruleset-10.json': okRuleset,
    'ruleset-11.json': { id: 11, bypass_actors: [] },
    'app-cursor.json': { id: 1001 },
    'app-sonarcloud.json': { id: 2002 },
    [`checks-${SHA}.pages.json`]: [{ total_count: 3, check_runs: [checkRun('ci', 15368), checkRun('Cursor Bugbot', 1001)] }, { total_count: 3, check_runs: [checkRun('SonarCloud Code Analysis', 2002)] }],
    [`statuses-${SHA}.json`]: [{ context: 'ci', state: 'success' }],
  }
}
const DECL = [{ app: 'cursor', contexts: ['Cursor Bugbot'] }, { app: 'sonarcloud', contexts: ['SonarCloud Code Analysis'] }]

// [名前, fixture を変える関数, 宣言, 期待する verdict, 期待する最後の判定行]
const CASES = [
  ['すべて合格', (f) => f, DECL, 'pass', 'required-contexts-without-bound-run 0'],
  ['宣言なし（外部チェックなし確定）でも (iv) は 0 件として通る', (f) => f, [], 'pass', 'required-contexts-without-bound-run 0'],
  ['(i) required_status_checks のルールが無い → classic-unsupported', (f) => ({ ...f, 'rules-main.pages.json': [[pr(true)]] }), DECL, 'classic-unsupported', 'required-status-check-rules 0'],
  ['(i) ルールの取得に失敗 → classic-unsupported', (f) => ({ ...f, 'err-rules-main': 'HTTP 502' }), DECL, 'classic-unsupported', 'required-status-check-rules error'],
  ['(i-b) Organization の ruleset → server-enforcement-missing', (f) => ({ ...f, 'rules-main.pages.json': [[rsc([CI, BUGBOT]), pr(true)], [{ ...rsc([SONAR], 11), ruleset_source_type: 'Organization' }]] }), DECL, 'server-enforcement-missing', 'non-repository-rulesets 1'],
  ['(i-b) ruleset_id が欠落 → server-enforcement-missing', (f) => ({ ...f, 'rules-main.pages.json': [[{ type: 'required_status_checks', ruleset_source_type: 'Repository', parameters: { required_status_checks: [CI] } }, pr(true)]] }), DECL, 'server-enforcement-missing', 'non-repository-rulesets 1'],
  ['(i-b) bypass_actors がある → server-enforcement-missing', (f) => ({ ...f, 'ruleset-11.json': { id: 11, bypass_actors: [{ actor_type: 'RepositoryRole' }] } }), DECL, 'server-enforcement-missing', 'rulesets-with-bypass 1'],
  ['(i-b) bypass_actors が null → server-enforcement-missing', (f) => ({ ...f, 'ruleset-10.json': { id: 10, bypass_actors: null } }), DECL, 'server-enforcement-missing', 'rulesets-with-bypass 1'],
  ['(i-b) ruleset の取得に失敗 → server-enforcement-missing', (f) => ({ ...f, 'err-ruleset-11': 'HTTP 403' }), DECL, 'server-enforcement-missing', 'rulesets-with-bypass error'],
  ['(iii) スレッド解消の強制なし → server-enforcement-missing', (f) => ({ ...f, 'rules-main.pages.json': [[rsc([CI, BUGBOT]), pr(false)], [rsc([SONAR], 11)]] }), DECL, 'server-enforcement-missing', 'thread-resolution-required false'],
  ['(iv) context だけ一致（integration_id が別 App）→ server-enforcement-missing', (f) => ({ ...f, 'rules-main.pages.json': [[rsc([CI, { ...BUGBOT, integration_id: 2002 }]), pr(true)], [rsc([SONAR], 11)]] }), DECL, 'server-enforcement-missing', 'unbound-external-contexts 1'],
  ['(iv) App ごとの App ID を使う（cursor の ID を sonarcloud に流用すると不合格になる構成）', (f) => ({ ...f, 'app-sonarcloud.json': { id: 1001 } }), DECL, 'server-enforcement-missing', 'unbound-external-contexts 1'],
  ['(iv) App ID が数値でない → server-enforcement-missing', (f) => ({ ...f, 'app-cursor.json': { id: null } }), DECL, 'server-enforcement-missing', 'unbound-external-contexts error'],
  ['(iv) App ID の取得に失敗 → server-enforcement-missing', (f) => ({ ...f, 'err-app-sonarcloud': 'HTTP 404' }), DECL, 'server-enforcement-missing', 'unbound-external-contexts error'],
  ['(iv) 引用符・{}・| ・非 ASCII を含む context も値で照合する', (f) => ({ ...f, 'rules-main.pages.json': [[rsc([CI, ODD_CHECK]), pr(true)]], 'app-odd-app.json': { id: 3003 }, [`checks-${SHA}.pages.json`]: [{ check_runs: [checkRun('ci', 15368), checkRun(ODD, 3003)] }] }), [{ app: 'odd-app', contexts: [ODD] }], 'pass', 'required-contexts-without-bound-run 0'],
  ['(v) required に無い check-run → server-enforcement-missing', (f) => ({ ...f, [`checks-${SHA}.pages.json`]: [{ check_runs: [checkRun('ci', 15368), checkRun('Cursor Bugbot', 1001), checkRun('lint', 15368)] }, { check_runs: [checkRun('SonarCloud Code Analysis', 2002)] }] }), DECL, 'server-enforcement-missing', 'client-only-statuses 0'],
  ['(v) required に無い commit status → server-enforcement-missing', (f) => ({ ...f, [`statuses-${SHA}.json`]: [{ context: 'ci' }, { context: 'deploy/preview' }, { context: 'deploy/preview' }] }), DECL, 'server-enforcement-missing', 'client-only-statuses 1'],
  ['(v) check-run の取得に失敗 → server-enforcement-missing', (f) => ({ ...f, [`err-checks-${SHA}`]: 'HTTP 502' }), DECL, 'server-enforcement-missing', 'client-only-statuses 0'],
  ['(v) commit status の取得に失敗 → server-enforcement-missing', (f) => ({ ...f, [`err-statuses-${SHA}`]: 'HTTP 502' }), DECL, 'server-enforcement-missing', 'client-only-statuses error'],
  ['(v-b) integration_id が null の required check → issuer-unbound', (f) => ({ ...f, 'rules-main.pages.json': [[rsc([{ context: 'ci', integration_id: null }, BUGBOT]), pr(true)], [rsc([SONAR], 11)]] }), DECL, 'issuer-unbound', 'required-contexts-without-bound-run 1'],
  ['(v-b) 同名の commit status だけで束縛済みの check-run が無い → checks-not-green', (f) => ({ ...f, [`checks-${SHA}.pages.json`]: [{ check_runs: [checkRun('Cursor Bugbot', 1001)] }, { check_runs: [checkRun('SonarCloud Code Analysis', 2002)] }] }), DECL, 'checks-not-green', 'required-contexts-without-bound-run 1'],
  ['(v-b) 同名の check-run が別の App から → checks-not-green', (f) => ({ ...f, [`checks-${SHA}.pages.json`]: [{ check_runs: [checkRun('ci', 9999), checkRun('Cursor Bugbot', 1001)] }, { check_runs: [checkRun('SonarCloud Code Analysis', 2002)] }] }), DECL, 'checks-not-green', 'required-contexts-without-bound-run 1'],
]

for (const bash of BASHES) {
  const tag = `[${bash}]`

  for (const [name, mutate, decl, verdict, lastCheck] of CASES) {
    test(`${tag} g0-check.sh: ${name}（旧コマンドを旧手順どおりに読んだ値・順序・reason と同じ）`, () => {
      const g = setup(mutate(passing()))
      try {
        const want = oldG0(g, bash, 'main', decl)
        const args = ['main', SHA, ...decl.flatMap((d) => d.contexts.map((c) => g0ContextArg(d.app, c)))]
        writeFileSync(join(g.dir, 'calls.log'), '')
        const r = g.run(bash, args)
        assert.equal(r.stdout, want, r.stderr)
        const lines = r.stdout.trimEnd().split('\n')
        assert.equal(lines.at(-1), `verdict ${verdict}`)
        assert.equal(lines.at(-2), lastCheck)
        assert.equal(r.status, verdict === 'pass' ? 0 : 1)
        // ルールと check-run は 1 回ずつだけ取得する。protection 系のエンドポイントは呼ばない。書き込みはしない
        const calls = g.calls()
        assert.ok(calls.filter((c) => c.startsWith('api repos/{owner}/{repo}/rules/branches/')).length <= 1, calls.join('\n'))
        assert.ok(calls.filter((c) => c.includes('/check-runs')).length <= 1, calls.join('\n'))
        assert.ok(calls.every((c) => !c.includes('/protection') && !/(^| )(-X|--method|-f|-F|--field|--input)( |$)/.test(c)), calls.join('\n'))
        // context 文字列・App 名は出さない
        assert.ok(!/Bugbot|SonarCloud|cursor|sonarcloud|日本/.test(r.stdout))
      } finally {
        g.done()
      }
    })
  }

  test(`${tag} g0-check.sh: 使い方の誤りは何も出さず exit 2（引用符・制御文字・小文字の %xx・不正な slug を含む引数を受け付けない）`, () => {
    const g = setup(passing())
    try {
      const bad = [
        [],
        ['main'],
        ['feature/x', SHA],
        ['a..b', SHA],
        ['main', 'x'],
        ['main', SHA.toUpperCase()],
        ['main', SHA, 'cursor'],
        ['main', SHA, 'cursor:'],
        ['main', SHA, 'Cursor:x'],
        ['main', SHA, '-x:y'],
        ['main', SHA, `cursor:${'%41'.repeat(1100)}`],
        ['main', SHA, 'cursor:Cursor Bugbot'],
        ['main', SHA, "cursor:it's"],
        ['main', SHA, 'cursor:%7ba'],
        ['main', SHA, 'cursor:a%0Ab'],
        ['main', SHA, 'cursor:a%1F'],
        ['main', SHA, 'cursor:a%7F'],
        ['main', SHA, 'cursor:a%2'],
      ]
      for (const args of bad) {
        const r = g.run(bash, args)
        assert.equal(r.status, 2, args.join(' '))
        assert.equal(r.stdout, '', args.join(' '))
      }
      assert.deepEqual(g.calls(), [], '使い方の誤りでは gh を呼ばない')
    } finally {
      g.done()
    }
  })
}

test('g0ContextArg: 英数字・.・_・- 以外の全バイトを大文字の %XX にし、slug と : でつなぐ', () => {
  assert.equal(g0ContextArg('cursor', 'Cursor Bugbot'), 'cursor:Cursor%20Bugbot')
  assert.equal(g0ContextArg('my-app', 'a.b_c-d'), 'my-app:a.b_c-d')
  assert.equal(g0ContextArg('x', ODD), 'x:it%27s%20%7Ba%7Cb%7D%20%22%E6%97%A5%E6%9C%AC%22%20%28x%29%2A%21%7E')
  assert.match(g0ContextArg('x', `!'()*~ $\`\\;&|<>{}[]`), /^x:([A-Za-z0-9._-]|%[0-9A-F]{2})+$/)
})

test('g0-check.sh: 各判定の jq の式は旧プロンプトと同じ', () => {
  const src = readFileSync(join(SCRIPTS, 'g0-check.sh'), 'utf8')
  const lib = readFileSync(join(SCRIPTS, 'lib', 'gh-read.sh'), 'utf8')
  const jqOf = (cmd) => cmd.slice(cmd.lastIndexOf(" '") + 1)
  for (const old of [OLD.i('x'), OLD.ibList('x'), OLD.iii('x'), OLD.vRuns, OLD.vStatuses, OLD.vb1, OLD.vb2]) {
    assert.ok(src.includes(jqOf(old)), jqOf(old))
  }
  assert.ok(src.includes(jqOf(OLD.ibBypass(1))), '(i-b) の --jq')
  assert.ok(src.includes(jqOf(OLD.ivCtx('x', 'a', 'c'))), '(iv) の jq')
  assert.ok(src.includes(`--jq '.id'`), '(iv) の App ID の --jq')
  assert.ok(lib.includes(jqOf(OLD.vHead('x')[1]).replace(/\)$/, '')), '(v) の REQ は lib/gh-read.sh の式')
  assert.ok(src.includes(jqOf(OLD.vbHead('x')[1]).replace(/\)$/, '')), '(v-b) の RSC')
})
