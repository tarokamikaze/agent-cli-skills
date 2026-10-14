// Review ループの回帰テスト。
//
// 契約:
//   1. fix へ渡す Review の指摘は 2000 文字で切られない（長い指摘の後半も fix のプロンプトに載る）。
//      上限（REVIEW_FINDING_MAX）を超えたときは、切られたことと省略した文字数を fix に明示する。
//   2. Review の結果が Low だけなら最終巡でなくても通過し、Low の指摘は PR へのコメントに回る（fix は起動しない）。
//   3. Medium 以上は従来どおり fix して再 Review する。Critical・High の扱いは変えない。
//   4. セキュリティの Review がある場合も、合わせた結果が Low だけのときに限り通過する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScript, BASE_ARGS, importDefinitions } from './lib/stub-run.mjs'

const { REVIEW_FINDING_MAX } = await importDefinitions(['REVIEW_FINDING_MAX'], 'review-loop-findings')

const nf = (sev, summary) => ({ state: 'needs-fix', highestSeverity: sev, summary, worktreePath: '/w/x' })
const labels = (calls, prefix) => calls.filter((c) => c.opts.label.startsWith(prefix))

// reviews[i] = i 巡目の Review の応答（undefined は stub の既定 = ok）
function scripted(reviews, sec = []) {
  let m = 0
  let s = 0
  return (label) => {
    if (label.startsWith('review:#')) return reviews[m++]
    if (label.startsWith('security-review:#')) return sec[s++]
    return undefined
  }
}

test('fix へ渡す Review の指摘は 2000 文字で切られず、後半の指摘も届く', async () => {
  const long = `${'x'.repeat(2500)} HIGH-3-LAST-FINDING`
  const { calls } = await runScript({ args: BASE_ARGS, override: scripted([nf('high', long)]) })
  const fixes = labels(calls, 'fix:#')
  assert.equal(fixes.length, 1)
  assert.match(fixes[0].prompt, /HIGH-3-LAST-FINDING/)
  assert.doesNotMatch(fixes[0].prompt, /指摘が上限/, '上限内なら注記は付かない')
})

test('fix へ渡す Review の指摘が上限を超えたら、切られたことと省略した文字数を明示する', async () => {
  const over = 100
  const long = `${'y'.repeat(REVIEW_FINDING_MAX)}${'z'.repeat(over)}`
  const { calls } = await runScript({ args: BASE_ARGS, override: scripted([nf('high', long)]) })
  const p = labels(calls, 'fix:#')[0].prompt
  assert.match(p, new RegExp(`指摘が上限 ${REVIEW_FINDING_MAX} 文字で切られた。以降 ${over} 文字の指摘は届いていない`))
  assert.doesNotMatch(p, /z{10}/)
})

test('Low だけなら 1 巡目で通過し、fix せず、Low の指摘は PR コメントに回る', async () => {
  const { calls, logs } = await runScript({ args: BASE_ARGS, override: scripted([nf('low', 'LOW-ONLY-FINDING')]) })
  assert.equal(labels(calls, 'review:#').length, 1, '再 Review しない')
  assert.equal(labels(calls, 'fix:#').length, 0)
  assert.equal(labels(calls, 'pr-create:#').length, 1)
  const comment = labels(calls, 'low-comment:#')
  assert.equal(comment.length, 1)
  assert.match(comment[0].prompt, /LOW-ONLY-FINDING/)
  assert.ok(logs.some((l) => l.includes('Review は Low のみ')))
})

test('2 巡目が Low だけなら 3 巡目は走らない', async () => {
  const { calls } = await runScript({ args: BASE_ARGS, override: scripted([nf('medium', 'MED'), nf('low', 'LOW-ROUND-2')]) })
  assert.equal(labels(calls, 'review:#').length, 2)
  assert.equal(labels(calls, 'fix:#').length, 1)
  assert.equal(labels(calls, 'pr-create:#').length, 1)
  assert.match(labels(calls, 'low-comment:#')[0].prompt, /LOW-ROUND-2/)
})

test('High・Critical・Medium は従来どおり fix して再 Review する', async () => {
  for (const sev of ['critical', 'high', 'medium']) {
    const { calls } = await runScript({ args: BASE_ARGS, override: scripted([nf(sev, `FINDING-${sev}`)]) })
    assert.equal(labels(calls, 'fix:#').length, 1, sev)
    assert.match(labels(calls, 'fix:#')[0].prompt, new RegExp(`FINDING-${sev}`))
    assert.equal(labels(calls, 'review:#').length, 2, `${sev}: 再 Review する`)
    assert.equal(labels(calls, 'low-comment:#').length, 0, sev)
  }
})

test('重要度が none・不明の needs-fix は medium 相当で、Low のように通過させない', async () => {
  for (const sev of ['none', undefined]) {
    const { calls } = await runScript({ args: BASE_ARGS, override: scripted([nf(sev, 'CONTRADICTION')]) })
    assert.equal(labels(calls, 'fix:#').length, 1, String(sev))
    assert.equal(labels(calls, 'low-comment:#').length, 0, String(sev))
  }
})

test('Medium 以上が最終巡まで残れば従来どおり blocked（push・PR 作成なし）', async () => {
  const { calls, result } = await runScript({
    args: BASE_ARGS,
    override: scripted([nf('high', 'a'), nf('high', 'b'), nf('high', 'LAST-HIGH')]),
  })
  assert.equal(labels(calls, 'review:#').length, 3)
  assert.equal(labels(calls, 'pr-create:#').length, 0)
  assert.equal(result.failures.find((x) => x.issue === 2)?.status, 'blocked')
})

test('セキュリティの Review がある場合: 両方 Low 以下なら 1 巡目で通過し、片方が medium 以上なら fix する', async () => {
  const args = { ...BASE_ARGS, securityReview: true }
  const lowLow = await runScript({ args, override: scripted([nf('low', 'LOW-MAIN')], [nf('low', 'LOW-SEC')]) })
  assert.equal(labels(lowLow.calls, 'review:#').length, 1)
  assert.equal(labels(lowLow.calls, 'fix:#').length, 0)
  const comment = labels(lowLow.calls, 'low-comment:#')
  assert.match(comment[0].prompt, /LOW-MAIN/)
  assert.match(comment[0].prompt, /LOW-SEC/)

  const lowHigh = await runScript({ args, override: scripted([nf('low', 'LOW-MAIN')], [nf('high', 'HIGH-SEC')]) })
  assert.equal(labels(lowHigh.calls, 'fix:#').length, 1)
  assert.equal(labels(lowHigh.calls, 'low-comment:#').length, 0)

  const okLow = await runScript({ args, override: scripted([undefined], [nf('low', 'LOW-SEC-ONLY')]) })
  assert.equal(labels(okLow.calls, 'fix:#').length, 0, '片方 ok・片方 Low なら通過')
  assert.match(labels(okLow.calls, 'low-comment:#')[0].prompt, /LOW-SEC-ONLY/)
})
