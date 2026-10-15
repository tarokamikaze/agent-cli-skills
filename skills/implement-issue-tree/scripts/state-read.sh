#!/usr/bin/env bash
# state-read.sh — 状態ファイルの読み込み（state:load・state:load-fill）を 1 コマンドで行う読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash state-read.sh summary <状態ファイル>
#   bash state-read.sh range   <状態ファイル> <開始> <終了>
#   bash state-read.sh keys    <状態ファイル> <キー>...
#
# 旧プロンプトはエージェントに jq の式（.items | with_entries(select(...)) など）を組み立てさせていた。式の {} と
# 引用符がコマンド行に同居すると Claude Code の権限確認が出るため、式をこのスクリプトへ移した。
#
# 出力（標準出力）:
#   summary  ファイルが無い: NOFILE
#            JSON として読めない: PARSE_ERROR
#            読めた: OK count=<items の全キー数> bytes=<高水位> version=<版>（高水位・版は無ければ 0。
#                    整数でない値はそのまま出し、ホストが形の不一致として扱う）
#            旧形式はラベルの無い OK <件数> <高水位> <版> で、読込エージェントに位置で数値を分解させていた。
#            取り違えると照合不成立でランが止まるため（Issue #23 と同じ症状）、ラベルを付け、エージェントは
#            この行を加工せずに返し、ホストの parseStateLoadSummary が分解する。
#   range    .items のキー（jq の keys の並び＝文字列昇順）の <開始>〜<終了> 番目（1 始まり・両端を含む）の項目だけを
#            持つ JSON オブジェクト 1 行（jq -c）。範囲外は {}
#   keys     指定したキー（正の整数の 10 進表記だけ）の項目だけを持つ JSON オブジェクト 1 行（jq -c）。
#            旧プロンプトの jq -c --argjson k '[...]' '.items | with_entries(select(.key as $x | $k | index($x)))' と同じ値
# 終了コード:
#   0  出力した
#   1  ファイルが無い・JSON として読めない（range / keys のみ。summary は NOFILE / PARSE_ERROR を出して 0）
#   2  使い方の誤り（未知のサブコマンド・パスやキーの形式不正）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（一時ファイルも作らない）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2

usage() {
  echo "使い方: state-read.sh summary 状態ファイル | range 状態ファイル 開始 終了 | keys 状態ファイル キー..." >&2
  exit 2
}

[ $# -ge 2 ] || usage
cmd=$1
f=$2
shift 2
sf_valid_state_path "${f}" || usage

case "${cmd}" in
  summary)
    [ $# -eq 0 ] || usage
    if [ ! -f "${f}" ]; then
      echo NOFILE
      exit 0
    fi
    if ! jq . "${f}" >/dev/null 2>&1; then
      echo PARSE_ERROR
      exit 0
    fi
    jq -r '"OK count=\(.items // {} | length) bytes=\(.perWorktreeByteReserveHighWater // 0) version=\(.perWorktreeByteReserveHighWaterVersion // 0)"' "${f}" || exit 1
    ;;
  range)
    [ $# -eq 2 ] || usage
    sf_valid_pos_int "$1" || usage
    sf_valid_pos_int "$2" || usage
    [ -f "${f}" ] || exit 1
    jq -c --argjson from "$1" --argjson to "$2" \
      '(.items // {}) as $i | [$i | keys[]][($from - 1):$to] | map({key: ., value: $i[.]}) | from_entries' "${f}" || exit 1
    ;;
  keys)
    [ $# -ge 1 ] || usage
    list=''
    for k in "$@"; do
      sf_valid_pos_int "${k}" || usage
      list="${list}${list:+,}\"${k}\""
    done
    [ -f "${f}" ] || exit 1
    jq -c --argjson k "[${list}]" '.items | with_entries(select(.key as $x | $k | index($x)))' "${f}" || exit 1
    ;;
  *) usage ;;
esac
