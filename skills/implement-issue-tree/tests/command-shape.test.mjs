// コマンドの形の検査器（tests/lib/command-shape.mjs。Issue #11）そのもののテスト。
// 通す形（陰性）と、利用側の hook が拒否しうる 4 つの形（陽性）を固定し、検査器が緩んで回帰防止のテスト
// （agent-command-shapes.test.mjs）が何も検出しなくなる退行と、通すべき形を拒否する退行の両方を止める。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCommand, extractCommandCandidates } from './lib/command-shape.mjs'

const rules = (command) => [...new Set(checkCommand(command).map((v) => v.rule))].sort()

// 通す形（どの形にも当たらない）
const NEGATIVE = [
  'git -C /repo/wt status --porcelain',
  'git grep -n "foo" -- src',
  'gh pr checks 12',
  'gh pr checks 12 --watch --interval 60',
  'gh pr view 12 --json state --jq .state',
  'gh pr view 12 --json headRefOid --jq .headRefOid',
  "gh pr view 12 --json body --jq '.body // \"\"'",
  "gh api repos/{owner}/{repo}/commits/abc/check-runs --jq '.total_count'",
  "bash '/opt/skills/x/scripts/run-verified.sh' 0123abcd checks-total.sh <HEAD sha>",
  "bash '/opt/skills/x/scripts/run-verified.sh' 0123abcd required-context-missing.sh main <手順 1 の headRefOid>",
  'git ls-remote --heads origin | grep "/12-"',
  'git worktree list --porcelain | grep -c "^worktree "',
  'gh api graphql -f query=\'query{viewer{login}}\'',
  'git fetch origin',
  'git rev-parse --verify "refs/remotes/origin/feat/12-x"',
  // 2 本の連結は (c) に当たらない
  'git fetch origin && git checkout -B feat/1-x origin/main',
  'f=$(mktemp); gh pr view 12 --json body --jq .body > "$f"',
  // パイプの右側で標準入力を読む head / tail / sed -n / cat は対象外
  'git log --oneline | head -n 5',
  'gh pr list | tail -1',
  "git diff | sed -n '1,20p'",
  'git show HEAD | cat',
  // ヒアドキュメントの cat と、その本文（本文の行はコマンドとして読まない）
  "git commit -F - <<'EOF'\ncd /tmp && rm -rf x && cat secret\nEOF",
  "gh pr create --title t --body \"$(cat <<'EOF'\n本文 ; && | { [\nEOF\n)\"",
  // sed は -n でなければ対象外、-n でもファイルを読まなければ対象外
  "sed 's/a/b/' file.txt",
  "printf '%s' x | sed -n 's/a/b/p'",
  // 引用符の中の区切り記号はコマンドの区切りではない
  "gh pr comment 12 --body 'a; b && c; d'",
  'echo "cd /tmp && ls; x; y"',
  // cd 単独、cd の後のパイプ（連結ではない）
  'cd /repo',
  // jq 単独の式（gh の --jq ではない）
  "jq -c '[.[] | {a: .b}]' file.json",
  // 2>&1 などの fd の複製・リダイレクト
  'gh pr checks 12 2>&1',
]

// 拒否しうる形（陽性）。[コマンド, 当たるべき形の一覧]
const POSITIVE = [
  // (a)
  ['cd /repo && git status', ['a']],
  ['cd /repo; git status', ['a']],
  ['target=$(cd "$p" && pwd -P)', ['a']],
  ['x="$(cd "$p" && pwd -P)"', ['a']],
  // (b)
  ["sed -n '1,20p' file.txt", ['b']],
  ["sed -ne 's/a/b/p' file.txt", ['b']],
  ['cat file.txt', ['b']],
  ['cat -- "$f"', ['b']],
  ['head -c 32 /dev/urandom | od -An -tx1', ['b']],
  ['head -n 5 file.txt', ['b']],
  ['tail -n 20 log.txt', ['b']],
  ['tail -5 log.txt', ['b']],
  ['cat < file.txt', ['b']],
  ['git status | cat file.txt', ['b']],
  // (c)
  ['a=1; b=2; echo "$a$b"', ['c']],
  ['git fetch origin && git checkout x && git merge --ff-only y', ['c']],
  ['f=$(mktemp) && gh pr view 1 --json body > "$f" && rm -f "$f"', ['c']],
  ['for n in 1 2; do gh issue view $n; done', ['c']],
  ['while true; do gh pr checks 1; sleep 30; done', ['c']],
  ['if test -f x; then rm x; fi', ['c']],
  ['a | b && c | d && e', ['c']],
  ['a\nb\nc', ['c']],
  ['x=$(a; b; c)', ['c']],
  // (d)
  ["gh api repos/{owner}/{repo}/commits/x/status --jq '.statuses | length'", ['d']],
  ["gh api repos/{owner}/{repo}/compare/a...b --jq '{status:.status,files:[.files[].filename]}'", ['d']],
  ["gh pr checks 1 --json state --jq '[.[].state] | group_by(.)'", ['d']],
  ['gh api x -q \'.[0]\'', ['d']],
  ['gh api x --jq=\'.a | length\'', ['d']],
  ['gh api --paginate "repos/{owner}/{repo}/pulls/1/reviews" --jq "[.[] | .state]"', ['d']],
  // 複合
  ['REQ=$(gh api --paginate --slurp "x" | jq -c \'[.[]]\') && CR=$(gh api y --jq \'[.a]\') && jq -n 1', ['c', 'd']],
  ['cd /x && cat a && head b', ['a', 'b', 'c']],
]

test('検査器: 通す形（単独の git -C・git grep・gh pr checks・単純な --jq・bash <file>・パイプ 1 本・ヒアドキュメント）は何にも当たらない', () => {
  for (const c of NEGATIVE) assert.deepEqual(checkCommand(c), [], c)
})

test('検査器: (a)〜(d) の形を検出する', () => {
  for (const [c, want] of POSITIVE) assert.deepEqual(rules(c), want, c)
})

test('静的な走査: 文中の ASCII の連なりから、先頭語・変数の代入から始まる断片を切り出す', () => {
  const text = [
    '1. まず gh pr view 12 --json state --jq .state で状態を取得する。',
    '2. f=$(mktemp); gh pr view 12 --json body > "$f" で本文を取得する（HEAD sha の扱い）。',
    '   REQ=$(gh api "x" | jq -c \'[.[]]\') && CR=$(gh api y) && jq -n 1',
    '3. 次の値 <手順 1 の headRefOid> を使い head -c 32 /dev/urandom | od -An -tx1 を実行する。',
    'HEAD sha と headRefOid の説明だけの行',
  ].join('\n')
  assert.deepEqual(extractCommandCandidates(text), [
    'gh pr view 12 --json state --jq .state',
    'f=$(mktemp); gh pr view 12 --json body > "$f"',
    'REQ=$(gh api "x" | jq -c \'[.[]]\') && CR=$(gh api y) && jq -n 1',
    'head -c 32 /dev/urandom | od -An -tx1',
  ])
})
