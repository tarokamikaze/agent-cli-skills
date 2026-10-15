#!/usr/bin/env bash
# resolve-thread.sh — レビュースレッドを 1 件 resolve するスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash resolve-thread.sh <threadId>
#
# 旧プロンプト（Merge ループの fix の手順 5）は agent に
#   gh api graphql -f query='mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}' -F tid=<threadId>
# を実行させていた。{} と引用符が同じコマンド行に同居し、利用側の権限確認が出るため、ここへ移した（Issue #11 の範囲 C）。
# mutation は旧プロンプトと同じ。threadId はホストの sanitizeThreadId と同じ形（英数字・_・- の 1〜100 文字）だけを受け取り、
# -f（文字列）で渡す（旧プロンプトの -F は数値・真偽値に見える値を型変換するため）。
#
# 出力: gh api graphql の出力をそのまま出す。
# 終了コード: gh api graphql の終了コード（0 = resolve した。GraphQL のエラーは gh が非 0 にする）。2 = 使い方の誤り。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
LC_ALL=C
export LC_ALL

usage() {
  echo "使い方: resolve-thread.sh threadId" >&2
  exit 2
}

[ $# -eq 1 ] || usage
case "$1" in
  '' | *[!A-Za-z0-9_-]*) usage ;;
esac
[ "${#1}" -le 100 ] || usage

query='mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}'
exec gh api graphql -f query="${query}" -f tid="$1"
