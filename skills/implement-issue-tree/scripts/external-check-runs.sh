#!/usr/bin/env bash
# external-check-runs.sh — HEAD sha 上の、指定した外部チェック App の check-run を状態ごとに数える読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash external-check-runs.sh <40 桁の head sha> <App の slug>
#
# 旧プロンプト（monitor の手順 4a・4x、merge-exec の手順 4b）が agent に実行させていた
#   HEAD_SHA="<sha>"
#   gh api --paginate "repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs" \
#     --jq '[.check_runs[] | select(.app.slug == "<slug>") | (.conclusion // .status)] | group_by(.) | map({v: .[0], count: length})'
# と、ページごとに出る件数の合算（agent が暗算していた）を、スクリプトへ移したもの（変数の代入・{} と | を含む --jq の
# 式を agent に書かせない。Issue #11 の範囲 A）。選ぶ check-run と値（結論、未完了なら進行状態）は旧コマンドと同じで、
# 全ページを束ねてから数えるので、ページの合算もスクリプトが行う。
#
# 出力（標準出力）: 「<値> <件数>」の行を値の昇順で。値は conclusion（success / failure / neutral / skipped / cancelled /
#                   timed_out 等）、結論が無いものは status（queued / in_progress 等）、どちらも無ければ null。
#                   該当する check-run が 0 件なら何も出さない。
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

[ $# -eq 2 ] && gr_valid_sha "$1" && gr_valid_slug "$2" || {
  echo "使い方: external-check-runs.sh HEAD_SHA（40 桁の小文字 16 進） APP_SLUG" >&2
  exit 2
}

pages=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/$1/check-runs") || exit 1
counts=$(printf '%s' "${pages}" |
  jq -c --arg slug "$2" '[.[].check_runs[] | select(.app.slug == $slug) | (.conclusion // .status)] | group_by(.) | map({v: .[0], count: length})') || exit 1
[ -n "${counts}" ] || exit 1
printf '%s' "${counts}" | gr_counts_to_lines || exit 1
