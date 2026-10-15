#!/usr/bin/env bash
# gh-read.sh — GitHub を読む同梱スクリプトの引数の形式検証（source 専用）
#
# 呼び出し元: compare-files.sh（monitor の手順 1b。agent にシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる）。
# 契約: 失敗は非ゼロ return。source 元のシェル状態を壊さないため set -e / set -u / trap / exit は置かない。
#       二重 source は無害（ガードで即 return）。
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
