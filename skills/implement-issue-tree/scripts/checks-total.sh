#!/usr/bin/env bash
# checks-total.sh — HEAD sha に対するチェック総数（check-run の件数 + commit status の件数）を出す読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash checks-total.sh <40 桁の head sha>
#
# 旧プロンプト（monitor の手順 2、PR 作成と fix の push 後の CI 起動確認）が agent に実行させていた 2 本の取得
#   gh api repos/{owner}/{repo}/commits/<sha>/check-runs --jq '.total_count'
#   gh api repos/{owner}/{repo}/commits/<sha>/status --jq '.statuses | length'
# と、その合計（agent が暗算していた）を、そのままスクリプトへ移したもの（--jq の式の | を agent に書かせない。
# Issue #11 の範囲 A）。合計の定義（gh pr checks と同じく check-run と commit status を合算する）は旧手順と同じ。
#
# 出力（標準出力）: 合計の整数 1 個と改行。
# 終了コード:
#   0  両方の取得に成功した
#   1  どちらかの取得に失敗した（何も出さない。0 件と同一視させない = fail-closed）
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

[ $# -eq 1 ] && gr_valid_sha "$1" || {
  echo "使い方: checks-total.sh HEAD_SHA（40 桁の小文字 16 進）" >&2
  exit 2
}

runs=$(gh api "repos/{owner}/{repo}/commits/$1/check-runs" --jq '.total_count') || exit 1
statuses=$(gh api "repos/{owner}/{repo}/commits/$1/status" --jq '.statuses | length') || exit 1
for v in "${runs}" "${statuses}"; do
  case "${v}" in
    '' | *[!0-9]*)
      echo "FAILED: 件数を読めない" >&2
      exit 1
      ;;
  esac
done
echo $((runs + statuses))
