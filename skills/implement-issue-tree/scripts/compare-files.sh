#!/usr/bin/env bash
# compare-files.sh — 2 つの commit の比較（status と変更ファイル名の一覧）を出す読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash compare-files.sh <前回の 40 桁の sha> <今回の 40 桁の head sha>
#
# 旧プロンプト（monitor の手順 1b）が agent に実行させていた
#   gh api repos/{owner}/{repo}/compare/<前回>...<今回> --jq '{status:.status,files:[.files[].filename]}'
# を、そのままスクリプトへ移したもの（{} と [] を含む --jq の式を agent に書かせない。Issue #11 の範囲 A）。
# jq の式と出力の形式は旧コマンドと同じ（ホストは compareStatus・changedFiles として受け取り、従来どおり検証する）。
#
# 出力（標準出力）: {"status":"<ahead|behind|diverged|identical>","files":["<パス>",...]} の 1 行の JSON。
# 終了コード:
#   0  取得した
#   2  使い方の誤り
#   それ以外  gh の失敗（gh の終了コードをそのまま返す。agent は compareStatus: "unknown" を返す）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

[ $# -eq 2 ] && gr_valid_sha "$1" && gr_valid_sha "$2" || {
  echo "使い方: compare-files.sh 前回のSHA 今回のSHA（どちらも 40 桁の小文字 16 進）" >&2
  exit 2
}

exec gh api "repos/{owner}/{repo}/compare/$1...$2" --jq '{status:.status,files:[.files[].filename]}'
