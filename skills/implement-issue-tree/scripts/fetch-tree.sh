#!/usr/bin/env bash
# fetch-tree.sh — イシューツリー（ルートと全子孫）のノード一覧を GitHub から取得する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash fetch-tree.sh <ルートのイシュー番号>
#
# 旧プロンプトは Tree エージェントに gh api の --jq 式（{} と引用符を含む）と ; での連結を自分で組み立てさせており、
# 形が毎回変わって Claude Code の権限確認がランのたびに出た。取得の手順（全ページ取得・closed のノードも辿る・
# sub_issues_summary.total との件数の自己点検・opt-in テスト宣言マーカーの抽出）をこのスクリプトへ移した。
#
# 手順（旧プロンプトの手順 1・2・5 と同じ）:
#   1. gh api repos/{owner}/{repo}/issues/<ルート> でルートを取得する
#   2. キューをルートで初期化し、sub_issues_summary.total が 0 でないノードごとに
#      gh api --paginate "repos/{owner}/{repo}/issues/<n>/sub_issues?per_page=100" で直下の子を全ページ取得する
#      （closed のノードも辿る。深さで打ち切らない。訪問済みの番号は再度積まない）。取得した子の件数が total と
#      合わなければ最大 3 回まで取り直す
#   3. open のノードごとに本文の opt-in テスト宣言マーカー <!-- optin-tests: <コマンド> --> の値を抽出する
#
# 出力（標準出力。区切りはタブ。タイトルは jq の @tsv でエスケープ済み〔タブ・改行・\ が \t・\n・\\ になる〕）:
#   NODE <番号> <親の番号> <siblingIndex> <state> <subIssuesTotal> <タイトル>
#        ルートは親 0・siblingIndex 0。siblingIndex は親の sub_issues が返した配列内の 0 始まりの位置。
#        state は API の値（open / closed）。subIssuesTotal は sub_issues_summary.total（無ければ 0）
#   OPTIN <番号> <JSON 配列>   open のノードのうちマーカーがあるものだけ。値はマーカーの値の配列（jq -c 相当）
#   DONE <ノード数>            最後の行。これが無い出力は途中で失敗している
# 標準エラー:
#   MISMATCH <番号> <取得した子の件数> <total>   取り直しても件数が合わないノード（終了コード 1）
#   FAILED <番号>                                  そのノードの取得に失敗した（終了コード 1）
#   OPTIN_FAILED <番号>                            マーカーの抽出に失敗した（optinTests は空として扱われる。終了コードは変えない）
# 終了コード:
#   0  全ノードを取得し、全ノードで子の件数が total と一致した
#   1  取得の失敗または件数の不一致がある（出力済みの NODE 行は残る。ホストも同じ照合で停止する）
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。連想配列・mapfile を使わない。
# 副作用: 自分で作った一時ディレクトリだけ（終了時に消す）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2

usage() {
  echo "使い方: fetch-tree.sh ルートのイシュー番号" >&2
  exit 2
}

[ $# -eq 1 ] || usage
root=$1
sf_valid_pos_int "${root}" || usage

work=$(mktemp -d) || exit 1
trap 'rm -rf -- "${work}"' EXIT

# 1 行 = 番号 タブ state タブ total タブ タイトル（@tsv）
NODE_JQ='[.number, .state, (.sub_issues_summary.total // 0), .title] | @tsv'
OPTIN_JQ='[(.body // "") | scan("<!--[ \t]*optin-tests:[ \t]*([^\n]*?)[ \t]*-->") | .[0]] | tojson'
TAB=$(printf '\t')
status=0
count=0
queue="${work}/queue"
: >"${queue}"
open_nodes="${work}/open"
: >"${open_nodes}"
visited=" ${root} "

emit() {
  # $1 番号 $2 親 $3 siblingIndex $4 state $5 total $6 タイトル
  printf 'NODE\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
  count=$((count + 1))
  [ "$4" = open ] && printf '%s\n' "$1" >>"${open_nodes}"
  if [ "$5" != 0 ]; then
    printf '%s\t%s\n' "$1" "$5" >>"${queue}"
  fi
}

if ! line=$(gh api "repos/{owner}/{repo}/issues/${root}" --jq "${NODE_JQ}"); then
  echo "FAILED ${root}" >&2
  exit 1
fi
IFS="${TAB}" read -r n st total title <<EOF
${line}
EOF
emit "${n}" 0 0 "${st}" "${total}" "${title}"

i=1
while :; do
  entry=$(sed -n "${i}p" "${queue}")
  [ -n "${entry}" ] || break
  i=$((i + 1))
  parent=${entry%%"${TAB}"*}
  want=${entry#*"${TAB}"}
  children="${work}/children"
  got=-1
  attempt=0
  while [ "${attempt}" -lt 3 ]; do
    attempt=$((attempt + 1))
    if gh api --paginate "repos/{owner}/{repo}/issues/${parent}/sub_issues?per_page=100" --jq ".[] | ${NODE_JQ}" >"${children}"; then
      got=$(awk 'END { print NR }' "${children}")
      [ "${got}" = "${want}" ] && break
    else
      got=-1
    fi
  done
  if [ "${got}" = -1 ]; then
    echo "FAILED ${parent}" >&2
    status=1
    continue
  fi
  if [ "${got}" != "${want}" ]; then
    echo "MISMATCH ${parent} ${got} ${want}" >&2
    status=1
  fi
  idx=0
  while IFS="${TAB}" read -r n st total title; do
    [ -n "${n}" ] || continue
    case "${visited}" in
      *" ${n} "*)
        idx=$((idx + 1))
        continue
        ;;
    esac
    visited="${visited}${n} "
    emit "${n}" "${parent}" "${idx}" "${st}" "${total}" "${title}"
    idx=$((idx + 1))
  done <"${children}"
done

while IFS= read -r n; do
  [ -n "${n}" ] || continue
  if out=$(gh issue view "${n}" --json body --jq "${OPTIN_JQ}"); then
    [ "${out}" = '[]' ] || printf 'OPTIN\t%s\t%s\n' "${n}" "${out}"
  else
    echo "OPTIN_FAILED ${n}" >&2
  fi
done <"${open_nodes}"

echo "DONE ${count}"
exit "${status}"
