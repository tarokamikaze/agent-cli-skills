#!/bin/bash
# fake-gh.sh — テスト用の偽の gh（issue-scripts.test.mjs・ci-scripts.test.mjs が PATH の先頭に gh として置く）
#
# 引数から fixture のファイル名（$FAKE_GH_DIR/<key>.json）を決め、--jq があれば本物の jq（-r -c。gh の --jq と同じく
# 文字列は生、値は 1 行の JSON）で適用して出す。
# ページ: fixture が 1 ページなら <key>.json。複数ページを試すときは <key>.pages.json（ページの配列）を置く。
#   --paginate のときは各ページへ --jq を別々に適用して順に出す（本物の gh と同じく、--jq はページごとに適用される）。
#   --paginate なしなら 1 ページ目だけを使う。--slurp のときはページの配列をそのまま出す（1 ページの fixture は [ページ]）。
# 呼び出しは $FAKE_GH_DIR/calls.log に 1 行ずつ残す。$FAKE_GH_DIR/err-<key> があれば、その内容を標準エラーへ出して exit 1。
# $FAKE_GH_DIR/rc-<key> があれば、出力したあとその内容の終了コードで終わる（gh pr checks の pending = 8 など）。
# pr edit・pr comment は fixture を読まず書き込みを再現する（下の case の説明）。
d=$FAKE_GH_DIR
jqf=''
paginate=0
slurp=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq)
      jqf=$2
      shift 2
      ;;
    --paginate)
      paginate=1
      shift
      ;;
    --slurp)
      slurp=1
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
printf '%s\n' "${args[*]}" >>"$d/calls.log"
key=''
case "${args[0]} ${args[1]}" in
  'api graphql')
    key=graphql
    # unresolved-threads.sh の 2 ページ目以降（-f cursor=<値>）は graphql-<値>
    for a in "${args[@]}"; do
      case "$a" in
        cursor=?*) key="graphql-${a#cursor=}" ;;
      esac
    done
    ;;
  'api rate_limit') key=rate ;;
  api\ apps/*) key="app-${args[1]#apps/}" ;;
  'pr list') key=prlist ;;
  'pr checks') key="prchecks-${args[2]}" ;;
  'issue view') key="view-${args[2]}" ;;
  'pr view') key="prview-${args[2]}" ;;
  'pr edit' | 'pr comment')
    # 書き込み（write-scripts.test.mjs・optin-tests-gate.test.mjs）。pr edit は --body-file の内容で prview-<N>.json の body を
    # 置き換え（$FAKE_GH_DIR/noop-predit-<N> があれば置き換えずに成功だけ返す）、pr comment は本文を comment-<N>.md に書く
    k="pr${args[1]}-${args[2]}"
    if [ -f "$d/err-$k" ]; then
      printf '%s\n' "$(cat "$d/err-$k")" >&2
      exit 1
    fi
    src=''
    i=0
    while [ "$i" -lt "${#args[@]}" ]; do
      case "${args[$i]}" in
        --body-file) src=$(cat "${args[$((i + 1))]}") || exit 1 ;;
        --body) src=${args[$((i + 1))]} ;;
      esac
      i=$((i + 1))
    done
    if [ "${args[1]}" = comment ]; then
      printf '%s' "$src" >"$d/comment-${args[2]}.md"
      echo "https://example.invalid/pull/${args[2]}#issuecomment-1"
      exit 0
    fi
    [ -f "$d/noop-$k" ] && exit 0
    # --body-file の内容をそのまま（末尾の改行も含めて）本文にする
    prev=''
    for a in "${args[@]}"; do
      [ "$prev" = --body-file ] && jq --rawfile b "$a" '.body = $b' "$d/prview-${args[2]}.json" >"$d/.edit.json" && mv "$d/.edit.json" "$d/prview-${args[2]}.json"
      prev=$a
    done
    exit 0
    ;;
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
      commits/*/statuses)
        s=${p#commits/}
        key="statuses-${s%%/*}"
        ;;
      commits/*/status)
        s=${p#commits/}
        key="status-${s%%/*}"
        ;;
      compare/*) key="compare-${p#compare/}" ;;
      rules/branches/*) key="rules-${p#rules/branches/}" ;;
      rulesets/*) key="ruleset-${p#rulesets/}" ;;
      pulls/*/reviews)
        n=${p#pulls/}
        key="reviews-${n%%/*}"
        ;;
    esac
    ;;
esac
if [ -f "$d/err-$key" ]; then
  # 本物の gh と同じく、エラーメッセージは改行で終える
  printf '%s\n' "$(cat "$d/err-$key")" >&2
  exit 1
fi
if [ -f "$d/$key.pages.json" ]; then
  pages="$d/$key.pages.json"
elif [ -f "$d/$key.json" ]; then
  pages=''
else
  echo "fake gh: no fixture for $key" >&2
  exit 1
fi
rc=0
[ -f "$d/rc-$key" ] && rc=$(cat "$d/rc-$key")
if [ "$slurp" = 1 ]; then
  if [ -n "$pages" ]; then jq -c . "$pages"; else jq -c -s . "$d/$key.json"; fi
  exit "$rc"
fi
if [ -z "$pages" ]; then
  if [ -n "$jqf" ]; then
    jq -rc "$jqf" "$d/$key.json"
  else
    cat "$d/$key.json"
  fi
  exit "$rc"
fi
count=$(jq length "$pages")
[ "$paginate" = 1 ] || count=1
i=0
while [ "$i" -lt "$count" ]; do
  if [ -n "$jqf" ]; then
    jq -c ".[$i]" "$pages" | jq -rc "$jqf"
  else
    jq -c ".[$i]" "$pages"
  fi
  i=$((i + 1))
done
exit "$rc"
