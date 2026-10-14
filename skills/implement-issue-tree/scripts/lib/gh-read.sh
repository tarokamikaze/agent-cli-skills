#!/usr/bin/env bash
# gh-read.sh — CI 監視・マージ実行の読み取り専用スクリプトの共通ヘルパー（source 専用）
#
# 呼び出し元: checks-total.sh / compare-files.sh / external-check-runs.sh / required-context-missing.sh /
#             unresolved-threads.sh / checks-state-counts.sh / review-state-counts.sh（Issue #11 の範囲 A）、
#             g0-check.sh（範囲 B）。monitor・merge-exec・PR 作成・fix の agent にシェルを組み立てさせず、同梱スクリプトを
#             1 コマンドで呼ばせる。
# 役割: 引数（sha・PR 番号・App slug・URL エンコード済みのブランチ名）の形式検証と、ベースブランチの ruleset のルール・
#       required context・HEAD sha 上のチェックの context の取得。required context はマージの安全判定（G0 の (v)）でも
#       同じ式を使う。
# 契約: 失敗は非ゼロ return（取得の失敗を空や 0 に畳み込まない）。source 元のシェル状態を壊さないため
#       set -e / set -u / trap / exit は置かない。二重 source は無害（ガードで即 return）。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）の両方で動く書き方だけを使う。
#
# このファイルは単体実行しない。run-verified.sh のハッシュ照合は scripts/lib/*.sh も対象に含む。

[[ -n "${GH_READ_LIB_LOADED:-}" ]] && return 0
GH_READ_LIB_LOADED=1

# commit sha（40 桁の小文字 16 進）。ホストの sanitizeSha と同じ形。短縮 sha は受理しない
gr_valid_sha() {
  case "$1" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

# 正の整数（先頭ゼロなし・15 桁以内）。PR 番号に使う
gr_valid_pos_int() {
  case "$1" in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 15 ]
}

# 外部チェック App の slug。ホストの EXTERNAL_CHECK_APP_SLUG_RE（^[a-z0-9][a-z0-9-]{0,38}$）と同じ形
gr_valid_slug() {
  case "$1" in
    '' | [!a-z0-9]* | *[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#1}" -le 39 ]
}

# URL エンコード済みのブランチ名（ホストの encodeURIComponent(baseBranch)。sanitizeBranch を通った値なので
# 英数字・-・_・.・%2F だけになる）。/ と .. は受理しない
gr_valid_encoded_branch() {
  case "$1" in
    '' | *..* | *[!A-Za-z0-9._%-]*) return 1 ;;
  esac
  [ "${#1}" -le 400 ]
}

# ベースブランチ（URL エンコード済み）に適用される ruleset のルールを、全ページを --slurp で束ねた配列（ページの配列）で出す。
gr_rules_pages() {
  gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/$1"
}

# gr_rules_pages の出力（標準入力）から、required status checks の context を重複なしの JSON 配列で出す
# （旧プロンプトの monitor 手順 3g・merge-exec G0 (v) の REQ と同じ式）。g0-check.sh は取得済みのルールにこれを適用する。
gr_required_contexts_of_pages() {
  jq -c '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique'
}

# ベースブランチ（URL エンコード済み）の ruleset の required status checks の context を、重複なしの JSON 配列で出す。
gr_required_contexts() {
  local raw
  raw=$(gr_rules_pages "$1") || return 1
  printf '%s' "${raw}" | gr_required_contexts_of_pages
}

# HEAD sha 上の check-run の名前と commit status の context を連結した JSON 配列を出す（旧プロンプトの monitor 手順 3g の
# CR + ST と同じ。重複は残す）。
gr_head_contexts() {
  local cr st
  cr=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/$1/check-runs") || return 1
  cr=$(printf '%s' "${cr}" | jq -c '[.[].check_runs[].name]') || return 1
  st=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/$1/statuses") || return 1
  st=$(printf '%s' "${st}" | jq -c '[.[][].context]') || return 1
  jq -nc --argjson a "${cr}" --argjson b "${st}" '$a + $b'
}

# 値ごとの件数の JSON（[{"v":<値>,"count":<件数>}...]）を「<値> <件数>」の行にする。値が null のときは null と書く
gr_counts_to_lines() {
  jq -r '.[] | "\(.v // "null") \(.count)"'
}
