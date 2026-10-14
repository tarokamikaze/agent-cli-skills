#!/usr/bin/env bash
# fetch-root-ancestors.sh — イシューの親チェーン（sub-issues の祖先）を指定の段数まで取得する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash fetch-root-ancestors.sh <イシュー番号> <段数>
#
# 旧プロンプトがエージェントに実行させていた gh api graphql（クエリの {} と --jq の式を引用符でコマンド行に埋め込み、
# Claude Code の権限確認が出た）を、そのままスクリプトへ移したもの。クエリと jq の式は旧プロンプトと同じで、
# 出力の形式も同じ。owner・name は -F で '{owner}'・'{repo}' を渡し、gh がカレントリポジトリの値へ展開する
# （-f / --raw-field は展開しないため使わない）。
#
# 出力（標準出力）: [{"number":N,"parent":P}, ...] の JSON 配列（起点から親へ向かう順）。P は親の番号、親が無ければ 0、
#                   段数が尽きて親の有無を確認できなかった最深のノードは -1。
# 終了コード:
#   0  取得した
#   2  使い方の誤り
#   それ以外  gh の失敗（gh の終了コードをそのまま返す）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2

[ $# -eq 2 ] && sf_valid_pos_int "$1" && sf_valid_pos_int "$2" && [ "$2" -le 50 ] || {
  echo "使い方: fetch-root-ancestors.sh イシュー番号 段数（1〜50）" >&2
  exit 2
}

sel='number'
i=0
while [ "${i}" -lt "$2" ]; do
  sel="number parent{${sel}}"
  i=$((i + 1))
done

exec gh api graphql -F owner='{owner}' -F name='{repo}' -F n="$1" \
  -f query="query(\$owner:String!,\$name:String!,\$n:Int!){repository(owner:\$owner,name:\$name){issue(number:\$n){${sel}}}}" \
  --jq '[.data.repository.issue | recurse(.parent // empty) | {number: .number, parent: (if has("parent") then (.parent.number // 0) else -1 end)}]'
