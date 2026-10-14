#!/usr/bin/env bash
# unresolved-threads.sh — PR の未解決レビュースレッドを全ページ取得する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash unresolved-threads.sh <PR 番号>            # 未解決スレッドの一覧（monitor の手順 5）
#   bash unresolved-threads.sh <PR 番号> --count    # 未解決スレッドの件数だけ（merge-exec の手順 4。コメントを取得しない）
#
# 旧プロンプトが agent に書かせていた疑似ループ（cursor=""; hasNextPage=true; while ... gh api graphql -f query='...'
# -F cursor="$cursor"）を、スクリプトへ移したもの（変数の代入と while の連結・{} を含むクエリを agent に書かせない。
# Issue #11 の範囲 A）。クエリは旧プロンプトと同じで、ページの辿り方（reviewThreads(first:100, after:<endCursor>) を
# hasNextPage が false になるまで）も同じ。--count のクエリはスレッドの isResolved だけを読み、コメントを取得しない
# （merge-exec はコメント本文を読まない契約のため）。owner・name は -F で '{owner}'・'{repo}' を渡し、gh がカレント
# リポジトリの値へ展開する。
#
# 出力（標準出力）:
#   一覧: 未解決スレッド 1 件につき 1 行の JSON {"threadId","path","url","author","body"}（取得した順）と、最後に
#         「TOTAL <件数>」。url・author・body は最終コメントのもので、コメントが無ければ空文字。body は GitHub 由来の
#         未信頼データで、<untrusted-data source="review-comment">…</untrusted-data> で囲む（本文中の境界タグに似た文字列は
#         (untrusted-data) に置き換える。ホストの untrusted() と同じ扱い）。
#   --count: 未解決スレッドの件数の整数 1 個と改行。
# 終了コード:
#   0  全ページを取得した
#   1  取得に失敗した（途中のページを含む。件数・一覧を出さない = 0 件と同一視させない）
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（読み取り専用のクエリだけを送る）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

usage() {
  echo "使い方: unresolved-threads.sh PR番号 [--count]" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] && gr_valid_pos_int "$1" || usage
count_only=0
if [ $# -eq 2 ]; then
  [ "$2" = --count ] || usage
  count_only=1
fi

if [ "${count_only}" -eq 1 ]; then
  nodes='isResolved'
else
  nodes='id isResolved path comments(last:1){nodes{body url author{login}}}'
fi
query="query(\$owner:String!,\$name:String!,\$number:Int!,\$cursor:String){repository(owner:\$owner,name:\$name){pullRequest(number:\$number){reviewThreads(first:100,after:\$cursor){nodes{${nodes}}pageInfo{hasNextPage endCursor}}}}}"

# 未解決スレッドを行にする jq。body の境界タグに似た文字列は (untrusted-data) に置き換えてから囲む
line_jq='.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | (.comments.nodes[0] // {}) as $c | {threadId: .id, path: (.path // ""), url: ($c.url // ""), author: ($c.author.login // ""), body: ("<untrusted-data source=\"review-comment\">" + (($c.body // "") | gsub("</?\\s*untrusted-data"; "(untrusted-data)"; "i")) + "</untrusted-data>")}'

pr=$1
total=0
cursor=''
pages=0
lines=''
while :; do
  pages=$((pages + 1))
  # 無限ループの防止（1 ページ 100 件で 1000 ページ = 10 万スレッド。超えたら取得失敗として扱う）
  [ "${pages}" -le 1000 ] || exit 1
  # cursor は文字列として渡す（-F は数値・真偽値に見える値を型変換するため -f を使う）。初回は渡さない（after: null）
  if [ -z "${cursor}" ]; then
    page=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F number="${pr}" -f query="${query}") || exit 1
  else
    page=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F number="${pr}" -f cursor="${cursor}" -f query="${query}") || exit 1
  fi
  has_next=$(printf '%s' "${page}" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage') || exit 1
  next_cursor=$(printf '%s' "${page}" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // ""') || exit 1
  n=$(printf '%s' "${page}" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length') || exit 1
  case "${has_next}" in
    true | false) ;;
    *) exit 1 ;;
  esac
  case "${n}" in
    '' | *[!0-9]*) exit 1 ;;
  esac
  total=$((total + n))
  if [ "${count_only}" -eq 0 ] && [ "${n}" -gt 0 ]; then
    add=$(printf '%s' "${page}" | jq -c "${line_jq}") || exit 1
    lines="${lines}${add}
"
  fi
  [ "${has_next}" = true ] || break
  [ -n "${next_cursor}" ] && [ "${next_cursor}" != "${cursor}" ] || exit 1
  cursor=${next_cursor}
done

if [ "${count_only}" -eq 1 ]; then
  echo "${total}"
else
  printf '%s' "${lines}"
  echo "TOTAL ${total}"
fi
