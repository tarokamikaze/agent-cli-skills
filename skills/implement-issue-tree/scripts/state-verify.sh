#!/usr/bin/env bash
# state-verify.sh — 状態ファイルの内容照合（state:load-verify）に使うハッシュ一覧を出す読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash state-verify.sh <状態ファイル> [<開始行> <終了行>]
#
# 旧プロンプトがエージェントに 1 行で実行させていたシェル（関数定義・$(...) の入れ子・jq の式と引用符が同居し、
# Claude Code の権限確認がランのたびに出た）を、そのままスクリプトへ移したもの。出力の形式は旧コマンドと
# バイト単位で同じで、ホストの照合（keysSha256・keysCount・高水位・項目ごとの hashes）は変えていない
# （tests/state-scripts.test.mjs が旧コマンドとの一致を検証する）。
#
# 出力（標準出力）:
#   ファイルが無い: NOFILE の 1 行
#   ファイルがある:
#     1 行目  KEYS <sha256> <件数>   数値キー（正の整数の 10 進表記）を文字列昇順に並べた JSON 配列
#                                   （jq -jc。末尾改行なし）の SHA-256 と、その件数
#     2 行目  [<高水位>,<版>]         .perWorktreeByteReserveHighWater // 0 と .perWorktreeByteReserveHighWaterVersion // 0
#     3 行目以降 <キー> <sha256>       数値キーごとに jq -jcS '.items[$k]' の SHA-256。<開始行> <終了行> を渡すと
#                                   キーの並びのその範囲（1 始まり・両端を含む）だけを出す（出力が切れたときの分割実行用）
# 終了コード:
#   0  出力した（NOFILE を含む）
#   2  使い方の誤り（パスの形式不正・範囲が正の整数でない）。何も出力しない
#   3  sha256sum / shasum が無い
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（一時ファイルも作らない）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 3

usage() {
  echo "使い方: state-verify.sh 状態ファイル [開始行 終了行]" >&2
  exit 2
}

[ $# -eq 1 ] || [ $# -eq 3 ] || usage
f=$1
sf_valid_state_path "${f}" || usage
range='1,$'
if [ $# -eq 3 ]; then
  sf_valid_pos_int "$2" || usage
  sf_valid_pos_int "$3" || usage
  range="$2,$3"
fi
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || {
  echo "state-verify: sha256sum / shasum が無い" >&2
  exit 3
}

# 旧コマンドの h()（sha256sum の出力の先頭 64 文字）と同じ値を出す
h() {
  so_sha256
}

if [ -f "${f}" ]; then
  K='[.items // {} | keys[] | select(test("^[1-9][0-9]*$"))]'
  echo "KEYS $(jq -jc "${K}" "${f}" | h | cut -c1-64) $(jq "${K} | length" "${f}")"
  jq -c '[.perWorktreeByteReserveHighWater // 0, .perWorktreeByteReserveHighWaterVersion // 0]' "${f}"
  jq -r "${K} | .[]" "${f}" | sed -n "${range}p" | while IFS= read -r k; do
    printf '%s %s\n' "${k}" "$(jq -jcS --arg k "${k}" '.items[$k]' "${f}" | h | cut -c1-64)"
  done
else
  echo NOFILE
fi
