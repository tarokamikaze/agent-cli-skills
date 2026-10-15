#!/usr/bin/env bash
# state.sh — 状態ファイル（_/issue-trees/<親>.json）の書き込みを決定的に行う
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、state 書込みエージェントが 1 回実行する）:
#   bash state.sh --file _/issue-trees/N.json merge            （標準入力: [{"numbers":[…],"patch":{…}}…]）
#   bash state.sh --file _/issue-trees/N.json init             （標準入力: [{"number":N,"type":"implement|verify-close"}…]）
#   bash state.sh --file _/issue-trees/N.json merge --input-nonce X --input-sha S   （入力: _/issue-trees/N.json.input-X.json）
#   bash state.sh --file _/issue-trees/N.json init  --input-nonce X --input-sha S
#   bash state.sh --file _/issue-trees/N.json hw-max --bytes B --version V
#   bash state.sh --file _/issue-trees/N.json hw-set --bytes B --version V
#   bash state.sh --file _/issue-trees/N.json clear-worktree --issue I
#   bash state.sh --file _/issue-trees/N.json create --base B --parallel P --version V
#
# 役割: 状態ファイルを jq で書き換える手順（mktemp → jq → mv）を、エージェントが文章から組み立てる代わりに、固定のコマンド列として
#       持つ（Issue #603 第 5 弾）。patch の自由文はプログラム文字列に入れず --slurpfile で渡す。入力の形を検証し、書き換え前に
#       ファイルが変わっていないか確かめる（lib/state-lib.sh の st_rewrite）。worktree・branch の削除と読み込みはしない。
# 入力ファイル（--input-nonce / --input-sha）: 標準入力の代わりに、エージェントが Write ツールで書いた
#       <状態ファイル>.input-<nonce>.json を読む。ヒアドキュメントで JSON（{} と引用符）をコマンド行に載せると、利用側の
#       Claude Code の権限確認（展開による難読化の検査）がランのたびに出てランが止まるため。ホストは
#       SHA-256(nonce + 改行 + モード + 改行 + JSON) を --input-sha で渡し、このスクリプトはファイルの内容（末尾の改行を除く）から
#       同じ式で計算した値と一致するときだけ書き込む（転記の誤り・別の呼び出しやモード向けの入力の流用を書き込む前に止める）。
#       照合と読み込みは自分の一時ファイルへ写したものに対して行う。入力ファイルは nonce の形を確かめたあと、成否に関わらず消す。
# clear-worktree: .items["I"].worktree を "" にする（項目が無ければ作る）。worktree の掃除が済んだあとに使う。
# create: ファイルが無いときだけ親ディレクトリを作り、初期 JSON（parent はファイル名の番号・items は空）を書く。既にあれば
#       already-exists。置き先の作成は ln で行い、同時に初期化しても既存のファイルを上書きしない。
# 出力: 標準出力の最後の 1 行が `STATE_RESULT {"ok":true}` または `STATE_RESULT {"ok":false,"reason":"…"}`。reason は固定語彙
#       （invalid-input / no-file / rewrite-failed / changed-concurrently / no-temp / input-missing / input-mismatch /
#       already-exists）。patch の内容は出さない。
#       結果を出せたときは、書き込みの失敗を含めて exit 0。
# 終了コード: 0 結果の行を出力した / 2 使い方の誤り（結果の行は出さない）/ 3 jq が無い
# 自衛: 書き込み先は _/issue-trees/<正の整数>.json の 1 形だけ。rm は自分が作った一時ファイルだけ。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL

command -v jq >/dev/null 2>&1 || { echo "state: jq が無い" >&2; exit 3; }
script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 3
# shellcheck source=lib/state-lib.sh
. "${script_dir}/lib/state-lib.sh" || exit 3
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3

usage() {
  echo "使い方: state.sh --file _/issue-trees/N.json (merge|init [--input-nonce X --input-sha S]|hw-max --bytes B --version V|hw-set --bytes B --version V|clear-worktree --issue I|create --base B --parallel P --version V)" >&2
  [ $# -eq 0 ] || echo "state: $1" >&2
  exit 2
}
result() {
  if [ "$1" = ok ]; then
    printf 'STATE_RESULT {"ok":true}\n'
  else
    printf 'STATE_RESULT {"ok":false,"reason":"%s"}\n' "$1"
  fi
  exit 0
}

file=""
mode=""
bytes=""
version=""
in_nonce=""
in_sha=""
issue=""
base=""
parallel=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file | --bytes | --version | --input-nonce | --input-sha | --issue | --base | --parallel)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --file) file=$2 ;;
        --bytes) bytes=$2 ;;
        --version) version=$2 ;;
        --input-nonce) in_nonce=$2 ;;
        --input-sha) in_sha=$2 ;;
        --issue) issue=$2 ;;
        --base) base=$2 ;;
        --parallel) parallel=$2 ;;
      esac
      shift 2
      ;;
    merge | init | hw-max | hw-set | clear-worktree | create)
      [ -z "${mode}" ] || usage "モードは 1 つだけ"
      mode=$1
      shift
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done
[ -n "${mode}" ] || usage "モードが無い"
st_valid_file "${file}" || usage "--file は _/issue-trees/N.json の形で指定する"

pf=""
# 入力ファイル（--input-nonce の経路）。nonce の形を確かめたあとで設定し、成否・引数の誤りに関わらず EXIT の trap で消す。
# 消すのは検証済みの状態ファイルのパスと nonce から組み立てたこの形のファイルだけ
in_src=""
# shellcheck disable=SC2329  # trap 経由で呼ばれる
cleanup() {
  [ -z "${pf}" ] || rm -f -- "${pf}"
  pf=""
  [ -z "${in_src}" ] || rm -f -- "${in_src}"
  in_src=""
  st_drop
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT HUP

if [ -n "${in_nonce}" ] || [ -n "${in_sha}" ]; then
  case "${mode}" in
    merge | init) ;;
    *) usage "--input-nonce / --input-sha は merge と init だけ" ;;
  esac
  so_valid_nonce "${in_nonce}" || usage "--input-nonce は小文字英数字 1〜64 文字"
  in_src="${file}.input-${in_nonce}.json"
  case "${in_sha}" in
    '' | *[!0-9a-f]*) usage "--input-sha は小文字 16 進 64 桁" ;;
  esac
  [ "${#in_sha}" -eq 64 ] || usage "--input-sha は小文字 16 進 64 桁"
fi

ts=$(date -u +%FT%TZ)
rc=0
case "${mode}" in
  merge | init)
    if [ -n "${in_src}" ]; then
      # 入力ファイルを自分の一時ファイルへ写し、その写しを照合して読む（照合のあとで元ファイルが差し替えられても、
      # 照合していない内容を読まない）。$(...) は末尾の改行をすべて除く（Write ツールが末尾に改行を足しても同じ内容として扱う）
      [ -f "${in_src}" ] || result input-missing
      pf=$(mktemp "${TMPDIR:-/tmp}/state-in.XXXXXX") || result no-temp
      cp -- "${in_src}" "${pf}" || result input-missing
      body=$(cat -- "${pf}") || result input-missing
      got=$(printf '%s\n%s\n%s' "${in_nonce}" "${mode}" "${body}" | so_sha256) || result no-temp
      [ "${got}" = "${in_sha}" ] || result input-mismatch
      rm -f -- "${pf}"
      pf=""
    else
      body=$(cat) || usage "標準入力を読めない"
    fi
    if [ "${mode}" = merge ]; then
      st_valid_groups "${body}" || result invalid-input
      prog=${ST_MERGE_JQ}
      var=groups
    else
      st_valid_entries "${body}" || result invalid-input
      prog=${ST_INIT_JQ}
      var=entries
    fi
    pf=$(mktemp "${TMPDIR:-/tmp}/state-in.XXXXXX") || result no-temp
    printf '%s\n' "${body}" >"${pf}" || result no-temp
    st_rewrite "${file}" "${prog}" --slurpfile "${var}" "${pf}" --arg ts "${ts}" || rc=$?
    ;;
  hw-max | hw-set)
    st_uint "${bytes}" || usage "--bytes は 0 以上の整数で指定する"
    if [ "${mode}" = hw-max ] && [ "${bytes}" = 0 ]; then usage "hw-max の --bytes は正の整数で指定する"; fi
    st_uint "${version}" || usage "--version は 0 以上の整数で指定する"
    if [ "${mode}" = hw-max ]; then prog=${ST_HW_MAX_JQ}; else prog=${ST_HW_SET_JQ}; fi
    st_rewrite "${file}" "${prog}" --argjson hw "${bytes}" --argjson v "${version}" --arg ts "${ts}" || rc=$?
    ;;
  clear-worktree)
    case "${issue}" in
      '' | 0* | *[!0-9]*) usage "--issue は正の整数で指定する" ;;
    esac
    st_uint "${issue}" || usage "--issue は正の整数で指定する"
    st_rewrite "${file}" "${ST_CLEAR_WORKTREE_JQ}" --arg n "${issue}" --arg ts "${ts}" || rc=$?
    ;;
  create)
    case "${base}" in
      '' | -* | *..* | *[!A-Za-z0-9._/+@-]*) usage "--base はブランチ名の形で指定する" ;;
    esac
    case "${parallel}" in
      '' | 0* | *[!0-9]*) usage "--parallel は正の整数で指定する" ;;
    esac
    st_uint "${parallel}" || usage "--parallel は正の整数で指定する"
    st_uint "${version}" || usage "--version は 0 以上の整数で指定する"
    parent=${file#_/issue-trees/}
    parent=${parent%.json}
    [ -e "${file}" ] && result already-exists
    mkdir -p -- "${file%/*}" || result rewrite-failed
    pf=$(mktemp "${file}.XXXXXX") || result no-temp
    jq -n --argjson parent "${parent}" --arg base "${base}" --argjson parallel "${parallel}" --argjson v "${version}" \
      '{parent: $parent, baseBranch: $base, parallel: $parallel, updatedAt: "", perWorktreeByteReserveHighWater: 0, perWorktreeByteReserveHighWaterVersion: $v, items: {}}' \
      >"${pf}" 2>/dev/null || result rewrite-failed
    # 「無いときだけ作る」を原子的にする: ln（ハードリンク）は置き先が既にあれば失敗する。mv -f だと、上の [ -e ] の
    # 検査から置き換えまでの間に別の初期化・書き込みが作ったファイルを後勝ちで上書きし、項目を失いうる
    ln -- "${pf}" "${file}" 2>/dev/null || result already-exists
    ;;
esac
case "${rc}" in
  0) result ok ;;
  2) result no-file ;;
  3) result no-temp ;;
  4) result changed-concurrently ;;
  *) result rewrite-failed ;;
esac
