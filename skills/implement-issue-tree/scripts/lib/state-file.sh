#!/usr/bin/env bash
# state-file.sh — 状態ファイル（_/issue-trees/<parent>.json）を扱うスクリプトの共通ヘルパー（source 専用）
#
# 呼び出し元: state-verify.sh / state-read.sh / state-write.sh（Issue #300 の追跡: agent にシェルを組み立てさせず、
#             同梱スクリプトを 1 コマンドで呼ばせる）。
# 役割: 入力（状態ファイルのパス・整数・nonce）の形式検証と、jq の出力で状態ファイルを原子的に置き換える書き込み。
#       書き込みは「同じディレクトリに mktemp で一時ファイルを作り、jq の出力を書いて mv で置き換える」形で、
#       旧プロンプトの `tmp=$(mktemp "<state>.XXXXXX") && jq ... > "$tmp" && mv "$tmp" <state>` と同じ。
#       失敗時は一時ファイルを消す（旧プロンプトは失敗時の一時ファイルを残し得た）。
# 契約: 失敗は非ゼロ return。source 元のシェル状態を壊さないため set -e / set -u / trap / exit は置かない。
#       二重 source は無害（ガードで即 return）。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）の両方で動く書き方だけを使う。
#
# このファイルは単体実行しない。run-verified.sh のハッシュ照合は scripts/lib/*.sh も対象に含む。

[[ -n "${STATE_FILE_LIB_LOADED:-}" ]] && return 0
STATE_FILE_LIB_LOADED=1

# 状態ファイルのパスの形式。英数字・_・.・/・- だけで、.json で終わり、.. と // を含まない。
# 相対パス（ホストが渡す _/issue-trees/<parent>.json）と、テスト用の絶対パスを受理する。
sf_valid_state_path() {
  case "$1" in
    '' | *..* | *//* | *[!A-Za-z0-9_./-]*) return 1 ;;
    *.json) ;;
    *) return 1 ;;
  esac
  case "$1" in
    /[A-Za-z0-9_]* | [A-Za-z0-9_]*) return 0 ;;
  esac
  return 1
}

# 正の整数（先頭ゼロなし・15 桁以内）。issue 番号に使う。
sf_valid_pos_int() {
  case "$1" in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 15 ]
}

# 0 以上の整数（先頭ゼロなし・15 桁以内）。バイト数・版数に使う。
sf_valid_nonneg_int() {
  [ "$1" = 0 ] && return 0
  sf_valid_pos_int "$1"
}

# nonce（小文字英数字 1〜64 文字）。ホストの boundaryNonce（base36）を受け取る。
sf_valid_nonce() {
  case "$1" in
    '' | *[!0-9a-z]*) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}

# 現在時刻（UTC・秒精度）。旧プロンプトの $(date -u +%FT%TZ) と同じ書式。
sf_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# jq の出力で状態ファイルを原子的に置き換える。$1 = 状態ファイル、残りは jq の引数（フィルタを含む。
# 状態ファイルは最後に自動で付ける）。jq の失敗・空出力・mv の失敗は非ゼロ。一時ファイルは必ず消す。
sf_jq_write() {
  local state="$1" tmp
  shift
  [ -f "${state}" ] || return 1
  tmp=$(mktemp "${state}.XXXXXX") || return 1
  if jq "$@" "${state}" >"${tmp}" && [ -s "${tmp}" ] && mv -f "${tmp}" "${state}"; then
    return 0
  fi
  rm -f "${tmp}"
  return 1
}
