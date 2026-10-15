// agent に実行させる読み取り専用スクリプトのうち、CI 監視の補助（scripts/nonce-seed.sh・compare-files.sh）を、
// 偽の gh（tests/lib/fake-gh.sh。fixture の JSON に本物の jq で --jq を適用する）に対して実行する回帰テスト。
// CI の完了待ち・マージ直前の検証は upstream の observe-pr.sh・merge-gate.sh が持つ（それぞれの *.test.mjs）。
//
// 検証する契約: 旧プロンプトが agent に実行させていたコマンド（このファイルに固定文字列で持つ。src から消えたので
// ここが旧の正本）と同じ入力に対して、スクリプトが同じ値を出すこと。取得の失敗は非 0 終了で区別できること。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const BASHES = availableBashes()
const FAKE_GH = readFileSync(join(HERE, 'lib', 'fake-gh.sh'), 'utf8')

const SHA = 'a'.repeat(40)
const PREV = 'b'.repeat(40)

// --- 旧プロンプトのコマンド（変える前の src の文面そのまま）---
const OLD = {
  nonceSeed: "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'",
  compare: (prev, sha) => `gh api repos/{owner}/{repo}/compare/${prev}...${sha} --jq '{status:.status,files:[.files[].filename]}'`,
}

function setup(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-ci-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  writeFileSync(join(dir, 'calls.log'), '')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: dir, HEAD_SHA: SHA }
  return {
    dir,
    run: (bash, script, args) => spawnSync(bash, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd: dir, env }),
    old: (bash, command) => spawnSync(bash, ['-c', command], { encoding: 'utf8', cwd: dir, env }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} nonce-seed.sh: 旧コマンドと同じ形（小文字 16 進 64 桁・改行なし）を出し、呼ぶたびに違う値になる`, () => {
    const g = setup({})
    try {
      const old = g.old(bash, OLD.nonceSeed)
      assert.equal(old.status, 0, old.stderr)
      assert.match(old.stdout, /^[0-9a-f]{64}$/)
      const a = g.run(bash, 'nonce-seed.sh', [])
      const b = g.run(bash, 'nonce-seed.sh', [])
      assert.equal(a.status, 0, a.stderr)
      assert.match(a.stdout, /^[0-9a-f]{64}$/, '改行も空白も含まない')
      assert.notEqual(a.stdout, b.stdout)
      assert.equal(g.run(bash, 'nonce-seed.sh', ['x']).status, 2)
    } finally {
      g.done()
    }
  })

  test(`${tag} compare-files.sh: 旧コマンドとバイト単位で同じ JSON を出す。取得失敗は非 0`, () => {
    const g = setup({ [`compare-${PREV}...${SHA}.json`]: { status: 'ahead', files: [{ filename: 'a.go' }, { filename: 'dir/b c.md' }], commits: [] } })
    try {
      const old = g.old(bash, OLD.compare(PREV, SHA))
      const r = g.run(bash, 'compare-files.sh', [PREV, SHA])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, old.stdout)
      assert.deepEqual(JSON.parse(r.stdout), { status: 'ahead', files: ['a.go', 'dir/b c.md'] })
      writeFileSync(join(g.dir, `err-compare-${PREV}...${SHA}`), 'HTTP 404')
      assert.notEqual(g.run(bash, 'compare-files.sh', [PREV, SHA]).status, 0)
      assert.equal(g.run(bash, 'compare-files.sh', [PREV]).status, 2)
      assert.equal(g.run(bash, 'compare-files.sh', ['b'.repeat(7), SHA]).status, 2)
    } finally {
      g.done()
    }
  })
}
