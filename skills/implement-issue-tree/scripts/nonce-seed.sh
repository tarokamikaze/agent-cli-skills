#!/usr/bin/env bash
# nonce-seed.sh — 未信頼データの境界トークン用の乱数 seed（/dev/urandom の 32 バイト）を小文字 16 進 64 桁で出す
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash nonce-seed.sh
#
# 旧プロンプトが agent に実行させていた `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'` を、そのままスクリプトへ
# 移したもの（ファイルを読む head と、引用符の中の空白・改行を消す tr のパイプを agent に書かせない。Issue #11 の範囲 A）。
# 出力の形式は旧コマンドと同じ。
#
# 出力（標準出力）: 小文字 16 進 64 桁（改行なし。旧コマンドと同じ）。
# 終了コード:
#   0  出した
#   1  64 桁を作れなかった（/dev/urandom を読めない等）。何も出さない
#   2  使い方の誤り（引数がある）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし。

set -u
LC_ALL=C
export LC_ALL

[ $# -eq 0 ] || {
  echo "使い方: nonce-seed.sh（引数なし）" >&2
  exit 2
}

hex=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') || exit 1
case "${hex}" in
  '' | *[!0-9a-f]*) exit 1 ;;
esac
[ "${#hex}" -eq 64 ] || exit 1
printf '%s' "${hex}"
