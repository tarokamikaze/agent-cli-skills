#!/usr/bin/env bash
# review-state-counts.sh — PR のレビューのうち、指定した App の bot が HEAD sha に対して投稿したものを state ごとに数える
# 読み取り専用スクリプト（レビュー本文は出さない）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash review-state-counts.sh <PR 番号> <40 桁の head sha> <App の slug>
#
# 旧プロンプト（merge-exec の手順 4b）が agent に実行させていた
#   gh api --paginate "repos/{owner}/{repo}/pulls/<N>/reviews" \
#     --jq "[.[] | select(.user.login == \"<slug>[bot]\" and .commit_id == \"$HEAD_SHA\") | .state] | group_by(.) | map({v: .[0], count: length})"
# と、ページごとに出る件数の合算（agent が暗算していた）を、スクリプトへ移したもの（{} と [] と | を含む --jq の式・
# 変数の代入を agent に書かせない。Issue #11 の範囲 A）。選ぶレビュー（ログイン名が <slug>[bot] で commit_id が HEAD sha の
# もの）と値（state）は旧コマンドと同じで、全ページを束ねてから数える。
#
# 出力（標準出力）: 「<state> <件数>」の行を state の昇順で（APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING）。
#                   該当するレビューが 0 件なら何も出さない。
# 終了コード:
#   0  取得した（0 件を含む）
#   1  取得に失敗した（何も出さない。0 件と同一視させない）
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

[ $# -eq 3 ] && gr_valid_pos_int "$1" && gr_valid_sha "$2" && gr_valid_slug "$3" || {
  echo "使い方: review-state-counts.sh PR番号 HEAD_SHA（40 桁の小文字 16 進） APP_SLUG" >&2
  exit 2
}

pages=$(gh api --paginate --slurp "repos/{owner}/{repo}/pulls/$1/reviews") || exit 1
counts=$(printf '%s' "${pages}" |
  jq -c --arg login "$3[bot]" --arg sha "$2" '[.[][] | select(.user.login == $login and .commit_id == $sha) | .state] | group_by(.) | map({v: .[0], count: length})') || exit 1
[ -n "${counts}" ] || exit 1
printf '%s' "${counts}" | gr_counts_to_lines || exit 1
