#!/usr/bin/env bash
# pr-write.sh — PR 本文・コメント・レビュースレッドへ書き込むスクリプトの共通ヘルパー（source 専用）
#
# 呼び出し元: pr-body-edit.sh / optin-record-count.sh / pr-comment.sh（Issue #11 の範囲 C: PR 作成・fix・Low 指摘の
#             コメント・opt-in 記録の確認の agent にシェルを組み立てさせず、同梱スクリプトを 1 コマンドで呼ばせる）。
# 役割: 引数（PR 番号・sha・nonce・opt-in テストのコマンド・URL エンコード済みのブランチ名）の形式検証、PR の head・base の照合、agent が Write ツールで書いたファイルの照合、
#       PR 本文の取得、opt-in テスト実行記録の節の書き直し。
# 契約: 失敗は非ゼロ return。source 元のシェル状態を壊さないため set -e / set -u / trap / exit は置かない。
#       二重 source は無害（ガードで即 return）。pw_verify_written は lib/signed-output.sh の so_sha256 を使う
#       （呼び出し元が先に source する）。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）の両方で動く書き方だけを使う。
#
# このファイルは単体実行しない。run-verified.sh のハッシュ照合は scripts/lib/*.sh も対象に含む。

[[ -n "${PR_WRITE_LIB_LOADED:-}" ]] && return 0
PR_WRITE_LIB_LOADED=1

# opt-in テスト実行記録の節の固定文字列。ホストの OPTIN_RECORD_HEADING・OPTIN_RECORD_MARKER_PREFIX・
# OPTIN_RECORD_HUMAN_PREFIX と同じ（tests/write-scripts.test.mjs が一致を確かめる）
PW_OPTIN_HEADING='## opt-in テスト実行記録'
PW_OPTIN_MARKER_PREFIX='<!-- optin-test-record: '
PW_OPTIN_HUMAN_PREFIX='- opt-in テスト結果: '

# 正の整数（先頭ゼロなし・15 桁以内）。PR・issue の番号に使う
pw_valid_pos_int() {
  case "$1" in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 15 ]
}

# commit sha（40 桁の小文字 16 進）。ホストの sanitizeSha と同じ形
pw_valid_sha() {
  case "$1" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

# nonce（小文字英数字 1〜64 文字）。ホストの fileNonce（16 進）を受け取る
pw_valid_nonce() {
  case "$1" in
    '' | *[!0-9a-z]*) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}

# agent が Write ツールで書くファイルの名前。カレントディレクトリ（agent の作業ディレクトリ）に置き、使ったら消す
pw_written_path() {
  printf '%s' "./.implement-issue-tree-$1.md"
}

# opt-in テストのコマンドを 1 個、引数の形（空白を %20 にしたもの）から戻して標準出力へ出す。戻した値がホストの
# OPTIN_TEST_COMMAND_RE（^[A-Za-z0-9][A-Za-z0-9 _./:=@+,-]{0,199}$）に合わなければ非ゼロ。
pw_decode_command() {
  local enc="$1" dec
  case "${enc}" in
    '' | *[!A-Za-z0-9_./:=@+,%-]*) return 1 ;;
  esac
  # %20 以外の % は受理しない（%20 を空白へ戻したあとに % が残れば不正）
  dec=$(printf '%s' "${enc}" | sed -e 's/%20/ /g') || return 1
  case "${dec}" in
    *%* | [!A-Za-z0-9]*) return 1 ;;
  esac
  [ "${#dec}" -le 200 ] || return 1
  printf '%s' "${dec}"
}

# agent が Write ツールで書いたファイル（pw_written_path）を自分の一時ファイル $4 へ写し、写しの内容（末尾の改行を除く）
# から計算した SHA-256(nonce + 改行 + 束縛先 + 改行 + 内容) が期待値と一致するか確かめる（state-write.sh の verify_patch と
# 同じ定義。ホストの statePatchSha256）。照合と読み込みは同じ写しに対して行う。$1 = nonce、$2 = 束縛先、$3 = 期待値。
# 一致すれば写しを「末尾の改行を除いた内容」に書き直して 0。無い・不一致は標準エラーに理由を出して非ゼロ。
pw_verify_written() {
  local src actual content
  src=$(pw_written_path "$1")
  if [ ! -f "${src}" ]; then
    echo "FAILED: Write ツールで書くファイルが無い（${src}）" >&2
    return 1
  fi
  cp -- "${src}" "$4" || return 1
  content=$(cat -- "$4") || return 1
  actual=$(printf '%s\n%s\n%s' "$1" "$2" "${content}" | so_sha256) || return 1
  if [ "${actual}" != "$3" ]; then
    echo "FAILED: ${src} の内容がホストの渡したものと一致しない（期待 $3・実測 ${actual}）" >&2
    return 1
  fi
  printf '%s' "${content}" >"$4"
}

# URL エンコード済みのブランチ名（ホストの encodeURIComponent。sanitizeBranch を通った値なので英数字・-・_・.・%2F だけに
# なる）を元の名前に戻して標準出力へ出す。%2F 以外の % を含む・.. を含む・戻した値がホストの sanitizeBranch の形
# （^[A-Za-z0-9][A-Za-z0-9._/-]*$）でない・400 文字超は非ゼロ。
pw_decode_branch() {
  local enc="$1" dec
  case "${enc}" in
    '' | *..* | *[!A-Za-z0-9._%-]*) return 1 ;;
  esac
  [ "${#enc}" -le 400 ] || return 1
  dec=$(printf '%s' "${enc}" | sed -e 's/%2[Ff]/\//g') || return 1
  case "${dec}" in
    *%* | [!A-Za-z0-9]*) return 1 ;;
  esac
  printf '%s' "${dec}"
}

# PR $1 の head ブランチと base ブランチが、ホストの知る名前（$2・$3。戻した値）と一致するか確かめる。agent が PR 番号を
# 写し間違えると、無関係な PR の本文に Closes 行と対象外節を足すことになるため、本文に触れる前に照合する（Issue #18）。
# 取得の失敗・項目の欠落（null）・不一致は、標準エラーに理由を出して非ゼロ。
pw_verify_pr_refs() {
  local got
  got=$(gh pr view "$1" --json headRefName,baseRefName --jq '.headRefName, .baseRefName') || {
    echo "FAILED: PR #$1 の head・base を取得できない" >&2
    return 1
  }
  if [ "${got}" != "$2"$'\n'"$3" ]; then
    echo "FAILED: PR #$1 の head・base がホストの知るブランチ（$2 → $3）と一致しない" >&2
    return 1
  fi
}

# PR 本文を $2 へ書く（旧プロンプトの gh pr view <N> --json body --jq '.body // ""' > "$f" と同じ。本文の後ろに改行 1 つ）
pw_fetch_body() {
  gh pr view "$1" --json body --jq '.body // ""' >"$2"
}

# opt-in テスト実行記録の節を書き直す（旧プロンプトの optinRecordRewriteLines と同じ手順）。$1 = 本文のファイル、$2 = sha、
# $3 = 結果（pass / fail / not-run をコマンドの順にカンマで並べたもの）、残り = コマンド（戻した値）。
# 旧記録節の見出し・人間可読行・マーカー行を、行全体の形式に一致する固定パターン 3 本の grep -avE で全行除去し、
# 終了コードが 0 で除去後に空白以外の文字が残るときだけ置き換える（grep -v の 1 は残す行が無いこと。本文を空にしない）。
# そのあと見出しと、コマンドごとの人間可読行・マーカー行を末尾へ足す。
pw_optin_rewrite() {
  local file="$1" sha="$2" results="$3" g rc c r rest
  shift 3
  g=$(mktemp) || return 1
  grep -avE \
    -e "^[[:space:]]*${PW_OPTIN_HEADING}[[:space:]]*\$" \
    -e "^[[:space:]]*${PW_OPTIN_MARKER_PREFIX}[^ ]+ [^ ]+ .+ -->[[:space:]]*\$" \
    -e "^[[:space:]]*${PW_OPTIN_HUMAN_PREFIX}.+ => [^ ]+[[:space:]]*\$" \
    "${file}" >"${g}"
  rc=$?
  # 除去後に空白以外の文字が残らない（空・空行だけ）ときも失敗にする。gh の出力は本文の後ろに改行が付くため、記録節だけの
  # 本文でも除去後に空行が 1 つ残り、[ -s ] だけでは「本文を空にしない」を守れない
  if [ "${rc}" -ne 0 ] || ! grep -q '[^[:space:]]' "${g}"; then
    rm -f -- "${g}"
    echo "FAILED: 旧記録節の除去に失敗（grep の終了コード ${rc}。除去後が空なら本文が記録節だけ）" >&2
    return 1
  fi
  mv -f -- "${g}" "${file}" || {
    rm -f -- "${g}"
    return 1
  }
  {
    printf '%s\n' "${PW_OPTIN_HEADING}"
    rest="${results}"
    for c in "$@"; do
      r=${rest%%,*}
      rest=${rest#*,}
      printf '%s%s => %s\n' "${PW_OPTIN_HUMAN_PREFIX}" "${c}" "${r}"
      printf '%s%s %s %s -->\n' "${PW_OPTIN_MARKER_PREFIX}" "${sha}" "${r}" "${c}"
    done
  } >>"${file}"
}

# 結果の並び（pass / fail / not-run のカンマ区切り）が $2 個のコマンドに対応するか
pw_valid_results() {
  local rest="$1" n="$2" i=0 r
  case "${rest}" in
    '' | *[!a-z,-]* | ,* | *, | *,,*) return 1 ;;
  esac
  while :; do
    r=${rest%%,*}
    case "${r}" in
      pass | fail | not-run) ;;
      *) return 1 ;;
    esac
    i=$((i + 1))
    [ "${rest}" = "${r}" ] && break
    rest=${rest#*,}
  done
  [ "${i}" -eq "${n}" ]
}
