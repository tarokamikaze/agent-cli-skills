#!/bin/bash
# fake-gh.sh — テスト用の偽の gh（issue-scripts.test.mjs が PATH の先頭に gh として置く）
#
# 引数から fixture のファイル名（$FAKE_GH_DIR/<key>.json）を決め、--jq があれば本物の jq（-r -c。gh の --jq と同じく
# 文字列は生、値は 1 行の JSON）で適用して出す。--paginate は無視する（fixture は 1 ページ）。
# 呼び出しは $FAKE_GH_DIR/calls.log に 1 行ずつ残す。$FAKE_GH_DIR/err-<key> があれば、その内容を標準エラーへ出して exit 1。
d=$FAKE_GH_DIR
jqf=''
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq)
      jqf=$2
      shift 2
      ;;
    --paginate) shift ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
printf '%s\n' "${args[*]}" >>"$d/calls.log"
key=''
case "${args[0]} ${args[1]}" in
  'api graphql') key=graphql ;;
  'api rate_limit') key=rate ;;
  'pr list') key=prlist ;;
  'issue view') key="view-${args[2]}" ;;
  'pr view') key="prview-${args[2]}" ;;
  api\ repos/*)
    p=${args[1]#repos/\{owner\}/\{repo\}/}
    case "$p" in
      issues/*/sub_issues*)
        n=${p#issues/}
        key="sub-${n%%/*}"
        ;;
      issues/*) key="issue-${p#issues/}" ;;
      commits/*/check-runs)
        s=${p#commits/}
        key="checks-${s%%/*}"
        ;;
    esac
    ;;
esac
if [ -f "$d/err-$key" ]; then
  # 本物の gh と同じく、エラーメッセージは改行で終える
  printf '%s\n' "$(cat "$d/err-$key")" >&2
  exit 1
fi
[ -f "$d/$key.json" ] || {
  echo "fake gh: no fixture for $key" >&2
  exit 1
}
if [ -n "$jqf" ]; then
  jq -rc "$jqf" "$d/$key.json"
else
  cat "$d/$key.json"
fi
