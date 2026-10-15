#!/usr/bin/env bash
# state-file.sh — 状態ファイル（_/issue-trees/<parent>.json）を扱うスクリプトの共通ヘルパー（source 専用）
#
# 呼び出し元: state-verify.sh / state-read.sh / fetch-tree.sh / fetch-root-ancestors.sh / probe-declared-deps.sh / probe-prereqs.sh
#             （利用側のリポジトリで観測した権限確認によるランの停止への対応: agent にシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる）。
#             状態ファイルへの書き込みは state.sh（lib/state-lib.sh）が行う。
# 役割: 入力（状態ファイルのパス・正の整数）の形式検証。
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
