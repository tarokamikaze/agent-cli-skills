// GitHub を読む同梱スクリプト（scripts/fetch-tree.sh・probe-prereqs.sh・probe-declared-deps.sh・fetch-root-ancestors.sh・
// detect-external-checks.sh）を、偽の gh（fixture の JSON に本物の jq で --jq を適用する）に対して実行する回帰テスト
// （y-backend#300 の追跡: agent のプロンプトにシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる）。
//
// 検証する契約（ホストの照合は変えていないので、スクリプトは旧プロンプトの手順と同じ出力をする）:
//   - fetch-tree.sh: ルートと全子孫を NODE 行で出す。closed のノードも辿り、total が 0 のノードでは sub_issues を呼ばない。
//     子の件数が total と合わなければ取り直し、なお合わなければ MISMATCH と exit 1。open のノードの opt-in マーカーを OPTIN 行で出す
//   - probe-prereqs.sh / probe-declared-deps.sh: 1 行の JSON の sig がホストの outOfTreeStateChecksum / declaredDepsChecksum と一致する。
//     失敗した番号は FAILED。レート制限と確認できたときだけ RATE_LIMIT 行を出す（権限系の 403 では出さない）
//   - fetch-root-ancestors.sh: 段数ぶんの parent{} を入れ子にした読み取り専用クエリを送り、旧プロンプトと同じ配列を出す
//   - detect-external-checks.sh: github-actions 以外の App slug を重複なしで出し、失敗は何も出さず 0
//   - 番号の引数は正の整数だけを受理する（コマンド片は exit 2）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { importDefinitions } from './lib/stub-run.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const BASHES = availableBashes()
const { declaredDepsChecksum, outOfTreeStateChecksum, ROOT_ANCESTOR_DEPTH } = await importDefinitions(
  ['declaredDepsChecksum', 'outOfTreeStateChecksum', 'ROOT_ANCESTOR_DEPTH'],
  'issue-scripts',
)

// 偽の gh（tests/lib/fake-gh.sh。fixture の JSON に本物の jq で --jq を適用し、呼び出しを calls.log に残す）
const FAKE_GH = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'fake-gh.sh'), 'utf8')

function setup(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-gh-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  writeFileSync(join(dir, 'calls.log'), '')
  return {
    dir,
    run: (bash, script, args) => spawnSync(bash, [join(SCRIPTS, script), ...args], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: dir },
    }),
    calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trimEnd().split('\n').filter(Boolean),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const node = (number, state, total, title = `issue ${number}`) => ({ number, state, title, sub_issues_summary: { total } })
// ルート 1 → [2(open, 子 2), 3(closed, 子 1)]。2 → [4, 5]。closed の 3 の下に open の 6。
const TREE = {
  'issue-1.json': node(1, 'open', 2, 'root'),
  'sub-1.json': [node(2, 'open', 2, 'phase\tA'), node(3, 'closed', 1, 'phase B')],
  'sub-2.json': [node(4, 'open', 0), node(5, 'closed', 0)],
  'sub-3.json': [node(6, 'open', 0)],
  'view-1.json': { body: '' },
  'view-2.json': { body: null },
  'view-4.json': { body: 'x\n<!-- optin-tests: make e2e -->\n<!--optin-tests:cargo test -- --ignored-->\n' },
  'view-6.json': { body: 'none' },
}

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} fetch-tree.sh: 全子孫を NODE 行で出し、closed も辿り、total 0 のノードでは sub_issues を呼ばない。OPTIN と DONE を出す`, () => {
    const g = setup(TREE)
    try {
      const r = g.run(bash, 'fetch-tree.sh', ['1'])
      assert.equal(r.status, 0, r.stderr)
      const lines = r.stdout.trimEnd().split('\n')
      const nodes = lines.filter((l) => l.startsWith('NODE\t')).map((l) => l.split('\t').slice(1))
      assert.deepEqual(nodes, [
        ['1', '0', '0', 'open', '2', 'root'],
        ['2', '1', '0', 'open', '2', 'phase\\tA'], // タイトルのタブは @tsv でエスケープされる
        ['3', '1', '1', 'closed', '1', 'phase B'],
        ['4', '2', '0', 'open', '0', 'issue 4'],
        ['5', '2', '1', 'closed', '0', 'issue 5'],
        ['6', '3', '0', 'open', '0', 'issue 6'],
      ])
      assert.deepEqual(lines.filter((l) => l.startsWith('OPTIN\t')), ['OPTIN\t4\t["make e2e","cargo test -- --ignored"]'])
      assert.equal(lines.at(-1), 'DONE 6')
      const subCalls = g.calls().filter((c) => c.includes('sub_issues'))
      assert.deepEqual(subCalls.map((c) => /issues\/(\d+)\/sub_issues/.exec(c)[1]), ['1', '2', '3'], 'total 0 の葉では呼ばない・closed の 3 は辿る')
      assert.ok(subCalls.every((c) => c.includes('repos/{owner}/{repo}/issues/') && c.includes('per_page=100')))
      // open のノードだけ本文のマーカーを読む
      assert.deepEqual(g.calls().filter((c) => c.startsWith('issue view')).map((c) => c.split(' ')[2]), ['1', '2', '4', '6'])
    } finally {
      g.done()
    }
  })

  test(`${tag} fetch-tree.sh: 子の件数が total と合わなければ 3 回まで取り直し、なお合わなければ MISMATCH と exit 1（出せた NODE 行は残す）`, () => {
    const g = setup({ ...TREE, 'sub-2.json': [node(4, 'open', 0)] })
    try {
      const r = g.run(bash, 'fetch-tree.sh', ['1'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^MISMATCH 2 1 2$/m)
      assert.equal(g.calls().filter((c) => c.includes('issues/2/sub_issues')).length, 3)
      assert.ok(r.stdout.includes('NODE\t4\t2\t0\topen\t0\tissue 4'))
      assert.match(r.stdout, /^DONE 5$/m)
    } finally {
      g.done()
    }
  })

  test(`${tag} fetch-tree.sh: ルートの取得に失敗したら FAILED と exit 1。番号でない引数は exit 2`, () => {
    const g = setup({ 'err-issue-1': 'HTTP 404' })
    try {
      const r = g.run(bash, 'fetch-tree.sh', ['1'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /FAILED 1/)
      for (const bad of ['0', '1;ls', 'abc', '']) assert.equal(g.run(bash, 'fetch-tree.sh', [bad]).status, 2, bad)
      assert.equal(g.run(bash, 'fetch-tree.sh', []).status, 2)
    } finally {
      g.done()
    }
  })

  test(`${tag} probe-prereqs.sh: sig はホストの outOfTreeStateChecksum と一致し、issue で取れない番号は pr view で取り直す。両方だめなら FAILED`, () => {
    const g = setup({
      'view-5.json': { number: 5, state: 'OPEN' },
      'view-6.json': { number: 6, state: 'CLOSED' },
      'err-view-7': 'not an issue',
      'prview-7.json': { number: 7, state: 'MERGED' },
      'err-view-8': 'nope',
      'err-prview-8': 'nope',
    })
    try {
      const r = g.run(bash, 'probe-prereqs.sh', ['5', '6', '7', '8'])
      assert.equal(r.status, 0, r.stderr)
      const rows = r.stdout.trimEnd().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(rows.map((x) => [x.number, x.state]), [[5, 'OPEN'], [6, 'CLOSED'], [7, 'MERGED']])
      for (const x of rows) assert.equal(x.sig, outOfTreeStateChecksum(x.number, x.state))
      assert.match(r.stderr, /^FAILED #8$/m)
      assert.ok(g.calls().every((c) => !/body/.test(c)), '本文を取得しない')
      assert.equal(g.run(bash, 'probe-prereqs.sh', ['5', '6; rm -rf /']).status, 2)
    } finally {
      g.done()
    }
  })

  test(`${tag} probe-declared-deps.sh: REST で本文を取り、整数配列の deps と sig（ホストの declaredDepsChecksum と一致）を出す`, () => {
    const g = setup({
      'issue-34.json': { number: 34, body: '## 依存\n- #21\n- #22\n\nDepends on #9' },
      'issue-35.json': { number: 35, body: null },
      'err-issue-36': 'HTTP 404: Not Found',
    })
    try {
      const r = g.run(bash, 'probe-declared-deps.sh', ['34', '35', '36'])
      assert.equal(r.status, 0, r.stderr)
      const rows = r.stdout.trimEnd().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(rows.map((x) => [x.number, x.deps]), [[34, [9, 21, 22]], [35, []]])
      for (const x of rows) assert.equal(x.sig, declaredDepsChecksum(x.number, x.deps))
      assert.match(r.stderr, /^FAILED #36$/m)
      assert.doesNotMatch(r.stderr, /RATE_LIMIT/, '404 はレート制限ではない')
      assert.ok(!r.stdout.includes('依存'), '本文テキストを出力しない')
      assert.ok(g.calls().every((c) => !c.startsWith('issue view')), 'GraphQL（gh issue view）を使わない')
    } finally {
      g.done()
    }
  })

  test(`${tag} probe-declared-deps.sh: レート制限は RATE_LIMIT 行で報告し、権限系の 403（core に残りがある）は報告しない`, () => {
    const future = Math.floor(Date.now() / 1000) + 600
    const cases = [
      // [標準エラー, core の remaining, 期待する RATE_LIMIT 行の正規表現（null は出さない）]
      ['You have exceeded a secondary rate limit', 5000, /^RATE_LIMIT secondary$/m],
      ['API rate limit exceeded for user (HTTP 403)', 0, /^RATE_LIMIT core 0 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \d+$/m],
      ['HTTP 403: Resource protected by organization SAML enforcement', 0, /^RATE_LIMIT core 0 /m],
      ['HTTP 403: Must have admin rights', 4999, null],
      ['HTTP 429: Too Many Requests', 4999, null],
      // レート制限の語があっても core が枯渇していなければ、core の reset までの秒数を返さない（ホストの待機上限を超えさせない）
      ['API rate limit exceeded for installation', 4999, /^RATE_LIMIT core 4999 - -$/m],
    ]
    for (const [err, remaining, want] of cases) {
      const g = setup({ 'err-issue-1': err, 'err-issue-2': err, 'rate.json': { resources: { core: { remaining, reset: future } } } })
      try {
        const r = g.run(bash, 'probe-declared-deps.sh', ['1', '2'])
        assert.equal(r.status, 0)
        assert.match(r.stderr, /^FAILED #1$/m)
        assert.match(r.stderr, /^FAILED #2$/m)
        if (want) {
          assert.match(r.stderr, want, err)
          assert.equal((r.stderr.match(/^RATE_LIMIT/gm) ?? []).length, 1, '1 回だけ出す')
        } else {
          assert.doesNotMatch(r.stderr, /RATE_LIMIT/, err)
        }
      } finally {
        g.done()
      }
    }
  })

  test(`${tag} fetch-root-ancestors.sh: 段数ぶんの parent{} を入れ子にした読み取り専用クエリを送り、旧プロンプトと同じ配列を出す`, () => {
    const g = setup({ 'graphql.json': { data: { repository: { issue: { number: 4, parent: { number: 3, parent: { number: 1, parent: null } } } } } } })
    try {
      const r = g.run(bash, 'fetch-root-ancestors.sh', ['4', String(ROOT_ANCESTOR_DEPTH)])
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(JSON.parse(r.stdout), [{ number: 4, parent: 3 }, { number: 3, parent: 1 }, { number: 1, parent: 0 }])
      const call = g.calls()[0]
      assert.equal((call.match(/parent\{/g) ?? []).length, ROOT_ANCESTOR_DEPTH)
      assert.ok(call.includes('owner={owner}') && call.includes('name={repo}') && call.includes('n=4'))
      assert.doesNotMatch(call, /mutation/)
      assert.equal(g.run(bash, 'fetch-root-ancestors.sh', ['4']).status, 2)
      assert.equal(g.run(bash, 'fetch-root-ancestors.sh', ['0', '8']).status, 2)
    } finally {
      g.done()
    }
  })

  test(`${tag} detect-external-checks.sh: github-actions 以外の App slug を重複なし昇順で出す。取得失敗は何も出さず 0`, () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const g = setup({
      'prlist.json': [{ headRefOid: a }, { headRefOid: b }, { headRefOid: 'not-a-sha;ls' }],
      [`checks-${a}.json`]: { check_runs: [{ app: { slug: 'github-actions' } }, { app: { slug: 'cursor' } }] },
      [`checks-${b}.json`]: { check_runs: [{ app: { slug: 'sonarcloud' } }, { app: { slug: 'cursor' } }] },
    })
    try {
      const r = g.run(bash, 'detect-external-checks.sh', [])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'cursor\nsonarcloud\n')
      assert.ok(g.calls().every((c) => !c.includes('not-a-sha')), 'SHA でない値は URL に入れない')
    } finally {
      g.done()
    }
    const e = setup({ 'err-prlist': 'boom' })
    try {
      const r = e.run(bash, 'detect-external-checks.sh', [])
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '')
    } finally {
      e.done()
    }
  })
}
