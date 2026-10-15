#!/usr/bin/env bash
# pr-comment.sh — agent が Write ツールで書いたコメント本文を照合してから、PR にコメントするスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash pr-comment.sh [--repo <owner/name>] <PR> <nonce> <sha256>
#   --repo はホストの args.repo（gh pr comment を対象リポジトリへ束縛する。無ければカレントディレクトリのリポジトリ）
#
# 旧プロンプト（最終 Review の Low 指摘のコメント）は agent に gh pr comment <PR> --body "$(cat <<'LOWEOF' ... LOWEOF
# )" を実行させていた。コメント本文（Review の指摘。未信頼の自由文）がコマンド行の HEREDOC に載るため、ここへ移した
# （Issue #11 の範囲 C）。agent は本文を Write ツールでカレントディレクトリの .implement-issue-tree-<nonce>.md に書き、
# このスクリプトは内容（末尾の改行を除く）から計算した SHA-256(nonce + 改行 + PR 番号 + 改行 + 内容) がホストの渡した値と
# 一致するときだけ投稿する（写し間違い・別の呼び出し向けの本文の流用を投稿する前に止める。悪意ある書き換えへの認証では
# ない）。投稿する本文は旧コマンドと同じ（$(...) と同じく末尾の改行を除いたもの）。書いたファイルは成否に関わらず消す。
#
# 出力: gh pr comment の出力（コメントの URL）をそのまま出す。照合の失敗は標準エラーに FAILED: <理由>。
# 終了コード:
#   0  投稿した
#   1  ファイルが無い・照合が一致しない・gh pr comment の失敗
#   2  使い方の誤り
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 2
# shellcheck source=lib/pr-write.sh
. "${script_dir}/lib/pr-write.sh" || exit 2

usage() {
  echo "使い方: pr-comment.sh [--repo owner/name] PR番号 nonce sha256" >&2
  exit 2
}

written=''
body=''
cleanup() {
  [ -n "${written}" ] && rm -f -- "${written}"
  [ -n "${body}" ] && rm -f -- "${body}"
  return 0
}
trap cleanup EXIT

if [ $# -ge 2 ] && [ "$1" = --repo ]; then
  pw_valid_repo "$2" || usage
  PW_REPO=$2
  shift 2
fi
[ $# -ge 2 ] && pw_valid_nonce "$2" || usage
written=$(pw_written_path "$2")
[ $# -eq 3 ] && pw_valid_pos_int "$1" || usage
case "$3" in
  '' | *[!0-9a-f]*) usage ;;
esac
[ "${#3}" -eq 64 ] || usage

body=$(mktemp) || exit 1
pw_verify_written "$2" "$1" "$3" "${body}" || exit 1
pw_gh_pr comment "$1" --body-file "${body}"
