#!/usr/bin/env bash
# checks-state-counts.sh — PR のチェックを状態ごとに数える読み取り専用スクリプト（チェック名は出さない）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash checks-state-counts.sh <PR 番号>
#
# 旧プロンプト（merge-exec の手順 3）が agent に実行させていた
#   gh pr checks <N> --json state --jq '[.[].state] | group_by(.) | map({state: .[0], count: length})'
# を、スクリプトへ移したもの（[] と | を含む --jq の式を agent に書かせない。Issue #11 の範囲 A）。取得する項目（state だけ。
# 名前・説明・リンクは取得しない）と数え方は旧コマンドと同じ。gh pr checks は失敗だけでなく未完了（pending）でも非 0 で
# 終わるため、旧コマンドと同じく、出力できた件数は出したうえで gh の終了コードをそのまま返す。
#
# 出力（標準出力）: 「<状態> <件数>」の行を状態の昇順で（SUCCESS / FAILURE / PENDING / SKIPPED 等）。チェックが 0 件なら何も出さない。
# 終了コード:
#   gh pr checks の終了コード（0 = 全チェックが成功。非 0 は失敗・未完了・チェック不在・取得失敗のいずれか。旧コマンドと同じ）。
#   件数の集計に失敗したら 1（gh が 0 で終わっていても）。2 は使い方の誤り。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

[ $# -eq 1 ] && gr_valid_pos_int "$1" || {
  echo "使い方: checks-state-counts.sh PR番号" >&2
  exit 2
}

raw=$(gh pr checks "$1" --json state)
rc=$?
if [ -z "${raw}" ]; then
  # 何も取得できなかった（チェック不在のエラー・通信の失敗など）。0 で終わっていても成功にしない
  [ "${rc}" -eq 0 ] && exit 1
  exit "${rc}"
fi
counts=$(printf '%s' "${raw}" | jq -c '[.[].state] | group_by(.) | map({v: .[0], count: length})') || exit 1
printf '%s' "${counts}" | gr_counts_to_lines || exit 1
exit "${rc}"
