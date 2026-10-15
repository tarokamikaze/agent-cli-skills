#!/usr/bin/env bash
# optin-record-count.sh — PR 本文の opt-in テスト実行記録のマーカー行を、現在の HEAD に対して数える読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash optin-record-count.sh [--repo <owner/name>] <PR> <コマンド>...
#   <コマンド> は opt-in テストのコマンドの空白を %20 にしたもの（ホストが宣言の順に並べる）。
#
# 旧プロンプト（マージ前の opt-in 記録の確認）が agent に書かせていた手順を移したもの（Issue #11 の範囲 C）:
#   j=$(mktemp); gh pr view <PR> --json body,headRefOid > "$j"
#   H=$(jq -r '.headRefOid // ""' "$j")                     # 40 桁の小文字 16 進でなければ取得失敗
#   f=$(mktemp); jq -r '.body // ""' "$j" > "$f"
#   g=$(mktemp); tr -d '\r' < "$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$g"
#   コマンドごとに pass=$(grep -cxF -- "<!-- optin-test-record: $H pass <コマンド> -->" "$g") と fail・not-run の 2 本
# 数え方は旧手順と同じ（行頭・行末の空白と CR を除いた行の固定文字列の完全一致）。本文そのものは出さない。
#
# 出力（標準出力）: 「HEAD <sha>」の 1 行と、コマンドごとに「COUNT <index> <pass の件数> <fail + not-run の件数>」の行
#   （index は 0 から、引数の順）。
# 終了コード:
#   0  数えた
#   1  取得に失敗した（gh の失敗・headRefOid が 40 桁の小文字 16 進でない・grep の終了コードが 2 以上）。何も出さない
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/pr-write.sh
. "${script_dir}/lib/pr-write.sh" || exit 2

usage() {
  echo "使い方: optin-record-count.sh [--repo owner/name] PR番号 コマンド..." >&2
  exit 2
}

if [ $# -ge 2 ] && [ "$1" = --repo ]; then
  pw_valid_repo "$2" || usage
  PW_REPO=$2
  shift 2
fi
[ $# -ge 1 ] || usage
pr=$1
shift
pw_valid_pos_int "${pr}" || usage
commands=()
for c in "$@"; do
  dec=$(pw_decode_command "${c}") || usage
  commands+=("${dec}")
done

# 一時ファイルは 1 つずつ作って 1 つずつ消す（再帰削除を持たない。scripts/ の静的ガードが rm -r を禁じる）
j=''
f=''
g=''
# shellcheck disable=SC2329  # trap 経由で呼ばれる
cleanup() {
  [ -z "${j}" ] || rm -f -- "${j}"
  [ -z "${f}" ] || rm -f -- "${f}"
  [ -z "${g}" ] || rm -f -- "${g}"
}
trap cleanup EXIT
j=$(mktemp) || exit 1
f=$(mktemp) || exit 1
g=$(mktemp) || exit 1

pw_gh_pr view "${pr}" --json body,headRefOid >"${j}" || exit 1
H=$(jq -r '.headRefOid // ""' "${j}") || exit 1
pw_valid_sha "${H}" || exit 1
jq -r '.body // ""' "${j}" >"${f}" || exit 1
tr -d '\r' <"${f}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' >"${g}" || exit 1

out="HEAD ${H}
"
i=0
for c in ${commands[@]+"${commands[@]}"}; do
  set -- pass fail not-run
  n_pass=0
  n_non=0
  for r in "$@"; do
    n=$(grep -cxF -- "${PW_OPTIN_MARKER_PREFIX}${H} ${r} ${c} -->" "${g}")
    rc=$?
    [ "${rc}" -le 1 ] || exit 1
    case "${n}" in
      '' | *[!0-9]*) exit 1 ;;
    esac
    if [ "${r}" = pass ]; then
      n_pass=${n}
    else
      n_non=$((n_non + n))
    fi
  done
  out="${out}COUNT ${i} ${n_pass} ${n_non}
"
  i=$((i + 1))
done
printf '%s' "${out}"
