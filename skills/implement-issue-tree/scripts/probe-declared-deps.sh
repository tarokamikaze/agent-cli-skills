#!/usr/bin/env bash
# probe-declared-deps.sh — イシュー本文の依存宣言を、転記の検査値（sig）付きの整数配列として機械抽出する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash probe-declared-deps.sh <番号>...
#
# 旧プロンプトがエージェントに実行させていた for ループ（約 3 KB の jq の式を単一引用符でコマンド行に埋め込み、
# Claude Code の権限確認がランのたびに出た）を、そのままスクリプトへ移したもの。jq の式は lib/issue-jq.sh の
# DECLARED_DEPS_JQ・DECLARED_DEPS_SIG_JQ（旧定数と同じ文字列）。本文は REST（gh api。core 枠）で取得し、jq が整数配列へ
# 正規化した出力だけを出す（本文テキストは出力しない）。
#
# 出力:
#   標準出力  抽出できた番号ごとに 1 行の JSON {"number":N,"deps":[...],"sig":S}（gh の --jq の出力）
#   標準エラー 失敗した番号ごとに FAILED #<番号>。レート制限と確認できたときは、最初の 1 回だけ次のどちらかの行を足す
#             RATE_LIMIT core <remaining> <resetAt> <waitSeconds>   エラーにレート制限の語がある、または HTTP 403 / 429 で
#                                                                    gh api rate_limit の core の remaining が 0
#                                                                    （resetAt は ISO 8601 UTC、waitSeconds は復帰までの秒数）
#                                                                    エラーにレート制限の語があっても core の remaining が 0 で
#                                                                    ないとき・取得できないときは resetAt・waitSeconds を - にする
#                                                                    （core の reset まで待たせない。ホストが固定の短い待機をする）
#             RATE_LIMIT secondary                                   エラーに secondary rate limit がある（retry-after は取れない）
#             権限・SSO など他の 403 では RATE_LIMIT 行を出さない（通常の失敗）。
# 終了コード:
#   0  ループを最後まで実行した（個々の失敗は FAILED 行で表す。旧コマンドと同じ扱い）
#   2  使い方の誤り（番号が無い・正の整数でない）。何も取得しない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: 自分で作った一時ファイル（gh の標準エラーの保存先）だけ。終了時に消す。待機（sleep）はしない（ホストが待つ）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2
# shellcheck source=lib/issue-jq.sh
. "${script_dir}/lib/issue-jq.sh" || exit 2

[ $# -ge 1 ] || {
  echo "使い方: probe-declared-deps.sh 番号..." >&2
  exit 2
}
for n in "$@"; do
  sf_valid_pos_int "${n}" || {
    echo "probe-declared-deps: 番号は正の整数で指定する: ${n}" >&2
    exit 2
  }
done

errf=$(mktemp) || exit 1
trap 'rm -f -- "${errf}"' EXIT

filter="{number: .number, deps: (${DECLARED_DEPS_JQ})} | ${DECLARED_DEPS_SIG_JQ}"
rate_reported=0

# gh の標準エラー（errf）からレート制限を判定し、該当すれば RATE_LIMIT 行を標準エラーへ 1 回だけ出す。
report_rate_limit() {
  local core remaining
  [ "${rate_reported}" = 0 ] || return 0
  if grep -qi 'secondary rate limit' "${errf}"; then
    echo "RATE_LIMIT secondary" >&2
    rate_reported=1
    return 0
  fi
  if grep -qiE 'rate limit|RATE_LIMITED' "${errf}" || grep -qE 'HTTP (403|429)' "${errf}"; then
    core=$(gh api rate_limit --jq '.resources.core | "\(.remaining) \(.reset | todate) \([.reset - now, 0] | max | ceil)"' 2>/dev/null) || core=''
    case "${core}" in
      '0 '*)
        echo "RATE_LIMIT core ${core}" >&2
        rate_reported=1
        ;;
      *)
        # エラーにレート制限の語があるのに core に残りがある（または取得できない）場合も、レート制限として報告する
        # （旧手順と同じ判定）。ただし resetAt・waitSeconds は core が枯渇したときだけ返す（旧手順と同じ）。core の
        # reset は最大約 1 時間先で、枯渇していない core の待ち時間を返すとホストの待機上限を超えて止まるため、
        # - にしてホストの固定の短い待機に任せる
        if grep -qiE 'rate limit|RATE_LIMITED' "${errf}"; then
          remaining=${core%% *}
          [ -n "${remaining}" ] || remaining=-
          echo "RATE_LIMIT core ${remaining} - -" >&2
          rate_reported=1
        fi
        ;;
    esac
  fi
}

for n in "$@"; do
  if out=$(gh api "repos/{owner}/{repo}/issues/${n}" --jq "${filter}" 2>"${errf}"); then
    printf '%s\n' "${out}"
  else
    cat -- "${errf}" >&2
    echo "FAILED #${n}" >&2
    report_rate_limit
  fi
done
exit 0
