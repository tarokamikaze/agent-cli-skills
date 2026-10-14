#!/usr/bin/env bash
# required-context-missing.sh — ベースブランチの required context のうち、HEAD sha 上にまだ無いものの件数を出す読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash required-context-missing.sh <URL エンコード済みのベースブランチ名> <40 桁の head sha>
#
# 旧プロンプト（autoMerge のランの monitor 手順 3g）が agent に実行させていた、REQ・CR・ST・HAVE の代入と jq を && で
# 5 本つないだ 1 行を、スクリプトへ移したもの（3 本以上の連結・{} と [] と | を含む jq の式を agent に書かせない。
# Issue #11 の範囲 A）。required context と HEAD 上の context の取得は lib/gh-read.sh にあり、マージの安全判定（G0 の (v)）
# でも同じ集合を使える。数え方（required のうち HEAD 上の check-run 名・commit status の context のどれとも一致しない
# ものの件数）は旧コマンドの jq と同じ。context 名は出さない（件数だけ）。
#
# 出力（標準出力）: 不足件数の整数 1 個と改行（required が 0 件なら 0）。
# 終了コード:
#   0  求めた
#   1  どれかの取得に失敗した（何も出さない。不足 0 と同一視させない）
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

[ $# -eq 2 ] && gr_valid_encoded_branch "$1" && gr_valid_sha "$2" || {
  echo "使い方: required-context-missing.sh ベースブランチ（URL エンコード済み） HEAD_SHA（40 桁の小文字 16 進）" >&2
  exit 2
}

req=$(gr_required_contexts "$1") || exit 1
[ -n "${req}" ] || exit 1
have=$(gr_head_contexts "$2") || exit 1
[ -n "${have}" ] || exit 1
jq -n --argjson r "${req}" --argjson h "${have}" '[$r[] | select(. as $c | ($h | index($c)) | not)] | length' || exit 1
