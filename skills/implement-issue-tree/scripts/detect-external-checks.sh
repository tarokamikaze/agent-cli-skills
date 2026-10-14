#!/usr/bin/env bash
# detect-external-checks.sh — 直近 3 件の merged PR の check-runs から GitHub Actions 以外の App slug を集める読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash detect-external-checks.sh
#
# 旧プロンプトがエージェントに実行させていたパイプライン（$(...)・xargs・sh -c の入れ子と、{} と引用符を含む --jq の式。
# Claude Code の権限確認がランのたびに出た）を、そのままスクリプトへ移したもの。結果は参考値で、外部チェックの構成は
# args.externalChecks の明示入力で確定する（ホストの扱いは変えていない）。
#
# 出力（標準出力）: 重複を除いた App slug を 1 行に 1 つ（文字列昇順）。merged PR が無い・取得に失敗した場合は何も出さない。
# 終了コード: 0（取得の失敗も 0。旧手順と同じく「検出なし」として扱う）。2 は使い方の誤り。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

[ $# -eq 0 ] || {
  echo "使い方: detect-external-checks.sh（引数なし）" >&2
  exit 2
}

shas=$(gh pr list --state merged --limit 3 --json headRefOid --jq '.[].headRefOid' 2>/dev/null) || exit 0
for sha in ${shas}; do
  case "${sha}" in
    '' | *[!0-9a-f]*) continue ;;
  esac
  gh api "repos/{owner}/{repo}/commits/${sha}/check-runs" \
    --jq '[.check_runs[] | select(.app.slug != "github-actions") | .app.slug] | .[]' 2>/dev/null
done | sort -u
exit 0
