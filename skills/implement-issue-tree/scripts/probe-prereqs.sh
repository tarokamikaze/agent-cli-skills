#!/usr/bin/env bash
# probe-prereqs.sh — ツリー外の前提イシューの state を、転記の検査値（sig）付きで取得する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash probe-prereqs.sh <番号>...
#
# 旧プロンプトがエージェントに実行させていた for ループ（$(...) の中で {} と引用符を含む jq の式を使い、
# Claude Code の権限確認がランのたびに出た）を、そのままスクリプトへ移したもの。jq の式は lib/issue-jq.sh の
# OUT_OF_TREE_STATE_SIG_JQ（旧定数と同じ文字列）で、出力の形式と sig の計算はホストの outOfTreeStateChecksum と同じ。
# 本文・タイトル・コメントは取得しない。
#
# 出力:
#   標準出力  取得できた番号ごとに 1 行の JSON {"number":N,"state":"OPEN|CLOSED|MERGED","sig":S}（gh の --jq の出力）
#   標準エラー 取得できなかった番号ごとに FAILED #<番号>
#   gh issue view で取れない番号（PR 番号が issue として解決されない場合）は gh pr view で取り直す（旧手順と同じ）。
# 終了コード:
#   0  ループを最後まで実行した（個々の失敗は FAILED 行で表す。旧コマンドと同じ扱い）
#   2  使い方の誤り（番号が無い・正の整数でない）。何も取得しない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2
# shellcheck source=lib/issue-jq.sh
. "${script_dir}/lib/issue-jq.sh" || exit 2

[ $# -ge 1 ] || {
  echo "使い方: probe-prereqs.sh 番号..." >&2
  exit 2
}
for n in "$@"; do
  sf_valid_pos_int "${n}" || {
    echo "probe-prereqs: 番号は正の整数で指定する: ${n}" >&2
    exit 2
  }
done

q="{number: .number, state: .state} | ${OUT_OF_TREE_STATE_SIG_JQ}"
for n in "$@"; do
  if out=$(gh issue view "${n}" --json number,state --jq "${q}" 2>/dev/null || gh pr view "${n}" --json number,state --jq "${q}"); then
    printf '%s\n' "${out}"
  else
    echo "FAILED #${n}" >&2
  fi
done
exit 0
