#!/usr/bin/env bash
# pr-body-edit.sh — PR 本文を取得し、決まった補正だけを加えて gh pr edit で書き戻し、反映を確かめるスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash pr-body-edit.sh [--repo <owner/name>] ensure     <PR> <issue> [--milestone-warning] [--oos <nonce> <sha256>] [--optin <sha> <結果> <コマンド>...]
#   bash pr-body-edit.sh [--repo <owner/name>] optin      <PR> <sha> <結果> <コマンド>...
#   bash pr-body-edit.sh [--repo <owner/name>] oos-append <PR> <nonce> <threadId>...
#   --repo はホストの args.repo（gh の呼び出しを対象リポジトリへ束縛する。無ければカレントディレクトリのリポジトリ）。
#   --milestone-warning は PR 作成で pr-push.sh --mode pr の結果の milestone が unassigned のとき（警告の行を無ければ末尾へ足す）。
#
# 旧プロンプトは agent に f=$(mktemp)・gh pr view・grep と echo の連結・grep -avE と mv の連結・HEREDOC・gh pr edit を
# 組み立てさせていた（PR 作成の手順 1c・fix の手順 4b と 6）。利用側の hook が拒否しうる形（;・&& の 3 本以上の連結）を
# 含み、PR 本文（未信頼の自由文）を扱うシェルを agent が書くことになるため、ここへ移した（Issue #11 の範囲 C）。
#
# サブコマンド:
#   ensure      PR 作成の手順 1c（既存 PR を再利用するとき）。旧手順と同じ順で補正する:
#               1. 本文に「Closes #<issue>」が無ければ、空行 2 つと「Closes #<issue>」を末尾へ足す
#               2. --oos のとき、本文に「## 対象外（out-of-scope）」が無ければ、空行 1 つと agent が Write ツールで書いた
#                  対象外節（ホストが SHA-256 を渡す。束縛先は issue 番号。照合の定義は lib/pr-write.sh の
#                  pw_verify_written）を末尾へ足す
#               3. --optin のとき、opt-in テスト実行記録の節を書き直す（lib/pr-write.sh の pw_optin_rewrite）
#   optin       fix の手順 4b。opt-in テスト実行記録の節を書き直す
#   oos-append  fix の手順 6。agent が Write ツールで書いた対象外の行（1 件 1 行、
#               「- [threadId: <threadId>] <本文>」の形。threadId は引数で渡した一覧のどれか）を、本文の
#               「## 対象外（out-of-scope）」節の末尾へ足す（節が無ければ本文の末尾に節を作る）。本文に既にある threadId の
#               行は足さない。足す行が無ければ書き戻さない。Issue を閉じる記法（Closes #N など）を含む行は拒否する
#   <結果> は pass / fail / not-run をコマンドの順にカンマで並べたもの。<コマンド> は opt-in テストのコマンドの空白を %20 に
#   したもの（ホストが組み立てる。引用符を使わないため）。
#
# 書き戻しの安全側の扱い（fail-closed）: 本文の取得に失敗した・補正後の本文が空・補正の前にあった「Closes #」の行と
# 「## 対象外（out-of-scope）」の見出しのどちらかが補正後に無い、のいずれかなら gh pr edit を呼ばない。書き戻したあとは
# 本文を取り直し、足したもの（Closes 行・対象外の見出しと各 threadId・記録節の各マーカー行）が本文にあることを確かめる。
# Write ツールで書いたファイルは成否に関わらず消す。
#
# 出力: 成功は標準出力に OK の 1 行。失敗は標準エラーに FAILED: <理由> で、標準出力には何も出さない。
# 終了コード:
#   0  書き戻して反映を確かめた（oos-append で足す行が無かったときも 0）
#   1  取得・照合・補正・書き戻し・反映の確認のどれかに失敗した
#   2  使い方の誤り（引数の形式不正）。何もしない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 2
# shellcheck source=lib/pr-write.sh
. "${script_dir}/lib/pr-write.sh" || exit 2

OOS_HEADING='## 対象外（out-of-scope）'
# milestone の警告の行の先頭（pr-push.sh --mode pr が新規作成の本文へ足すものと同じ文言）
MILESTONE_WARNING_PREFIX='> **警告**: Closes 対象の '
# GitHub の closing keyword（close・closes・closed・fix・fixes・fixed・resolve・resolves・resolved）の後に、任意のコロンと
# 空白を挟んで Issue の参照（#N・owner/repo#N・https://github.com/owner/repo/issues/N）が続く形。grep -iE で使う
CLOSING_KEYWORD_RE='(^|[^a-z0-9_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+(([a-z0-9_.-]+/[a-z0-9_.-]+)?#[0-9]+|https?://github[.]com/[^/[:space:]]+/[^/[:space:]]+/(issues|pull)/[0-9]+)'

usage() {
  echo "使い方: pr-body-edit.sh [--repo owner/name] {ensure|optin|oos-append} PR番号 引数..." >&2
  exit 2
}

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

written=''
# 一時ファイルは 1 つずつ作って 1 つずつ消す（再帰削除を持たない。scripts/ の静的ガードが rm -r を禁じる）
tmp_files=()
cleanup() {
  local t
  for t in ${tmp_files[@]+"${tmp_files[@]}"}; do rm -f -- "${t}"; done
  [ -n "${written}" ] && rm -f -- "${written}"
  return 0
}
trap cleanup EXIT
# 一時ファイルを作り、後始末に登録してパスを TMPF に入れる
new_tmp() {
  TMPF=$(mktemp) || fail "一時ファイルを作れない"
  tmp_files+=("${TMPF}")
}

# Write ツールで書くファイルを、nonce の形式を確かめたあとで後始末に登録する（引数の誤りでも残さない）
arm_written() {
  pw_valid_nonce "$1" || usage
  written=$(pw_written_path "$1")
}

if [ $# -ge 2 ] && [ "$1" = --repo ]; then
  pw_valid_repo "$2" || usage
  PW_REPO=$2
  shift 2
fi
[ $# -ge 2 ] || usage
sub=$1
pr=$2
shift 2
pw_valid_pos_int "${pr}" || usage

issue=''
milestone_warning=0
oos_nonce=''
oos_sha=''
optin_sha=''
optin_results=''
commands=()
thread_ids=()

# --optin <sha> <結果> <コマンド>... を読む（残りの引数をすべてコマンドとして扱う）
read_optin() {
  [ $# -ge 3 ] || usage
  optin_sha=$1
  optin_results=$2
  shift 2
  pw_valid_sha "${optin_sha}" || usage
  local c dec
  for c in "$@"; do
    dec=$(pw_decode_command "${c}") || usage
    commands+=("${dec}")
  done
  pw_valid_results "${optin_results}" "${#commands[@]}" || usage
}

case "${sub}" in
  ensure)
    [ $# -ge 1 ] || usage
    issue=$1
    shift
    pw_valid_pos_int "${issue}" || usage
    if [ $# -ge 1 ] && [ "$1" = --milestone-warning ]; then
      milestone_warning=1
      shift
    fi
    if [ $# -ge 1 ] && [ "$1" = --oos ]; then
      [ $# -ge 3 ] || usage
      arm_written "$2"
      oos_nonce=$2
      oos_sha=$3
      case "${oos_sha}" in
        '' | *[!0-9a-f]*) usage ;;
      esac
      [ "${#oos_sha}" -eq 64 ] || usage
      shift 3
    fi
    if [ $# -ge 1 ]; then
      [ "$1" = --optin ] || usage
      shift
      read_optin "$@"
    fi
    ;;
  optin)
    read_optin "$@"
    ;;
  oos-append)
    [ $# -ge 2 ] || usage
    arm_written "$1"
    oos_nonce=$1
    shift
    for t in "$@"; do
      case "${t}" in
        '' | *[!A-Za-z0-9_-]*) usage ;;
      esac
      [ "${#t}" -le 100 ] || usage
      thread_ids+=("${t}")
    done
    ;;
  *) usage ;;
esac

new_tmp
orig=${TMPF}
new_tmp
body=${TMPF}
new_tmp
section=${TMPF}
new_tmp
add=${TMPF}
new_tmp
newlines=${TMPF}
new_tmp
merged=${TMPF}
new_tmp
after=${TMPF}

# 照合は本文の取得より前に行う（写し間違いなら PR に触れずに止める）
if [ -n "${oos_nonce}" ] && [ "${sub}" = ensure ]; then
  # 束縛先は issue 番号（再利用する PR の番号はホストがプロンプトを作る時点で決まっていない）
  pw_verify_written "${oos_nonce}" "${issue}" "${oos_sha}" "${section}" || exit 1
fi
if [ "${sub}" = oos-append ]; then
  [ -f "${written}" ] || fail "Write ツールで書くファイルが無い（${written}）"
  cp -- "${written}" "${section}" || fail "Write ツールで書いたファイルを読めない"
  # 行の形と threadId を確かめる。空行は捨てる。CR は除く
  lines=0
  : >"${add}"
  while IFS= read -r l || [ -n "${l}" ]; do
    l=${l%$'\r'}
    [ -z "${l}" ] && continue
    lines=$((lines + 1))
    [ "${lines}" -le 20 ] || fail "対象外の行が 20 行を超える"
    [ "${#l}" -le 2000 ] || fail "対象外の行が長すぎる（2000 バイト超）"
    case "${l}" in
      '- [threadId: '*'] '?*) ;;
      *) fail "対象外の行の形が「- [threadId: <threadId>] <本文>」でない" ;;
    esac
    t=${l#'- [threadId: '}
    t=${t%%']'*}
    ok=0
    for a in ${thread_ids[@]+"${thread_ids[@]}"}; do
      [ "${a}" = "${t}" ] && ok=1
    done
    [ "${ok}" -eq 1 ] || fail "threadId（${t}）が未解決スレッドの一覧に無い"
    # 行の本文は未信頼データ（指摘の要約など）。GitHub の closing keyword の形（Closes #N・fixes owner/repo#N・
    # resolved: https://github.com/<owner>/<repo>/issues/N など。大文字小文字を問わない）を含むと、PR のマージ時に
    # 無関係な Issue を閉じさせられるため、書き込まない
    if printf '%s\n' "${l}" | grep -qiE "${CLOSING_KEYWORD_RE}"; then
      fail "対象外の行に Issue を閉じる記法（close / fix / resolve の後の #番号・owner/repo#番号・Issue の URL）がある"
    fi
    printf '%s\n' "${l}" >>"${add}"
  done <"${section}"
  [ "${lines}" -ge 1 ] || fail "対象外の行が 1 行も無い"
fi

pw_fetch_body "${pr}" "${orig}" || fail "PR #${pr} の本文を取得できない"
cp -- "${orig}" "${body}" || fail "一時ファイルへ写せない"

case "${sub}" in
  ensure)
    if ! grep -qF "Closes #${issue}" "${body}"; then
      {
        echo
        echo
        echo "Closes #${issue}"
      } >>"${body}"
    fi
    if [ -n "${oos_nonce}" ] && ! grep -qF "${OOS_HEADING}" "${body}"; then
      {
        echo
        cat -- "${section}"
        echo
      } >>"${body}"
    fi
    if [ -n "${optin_sha}" ]; then
      pw_optin_rewrite "${body}" "${optin_sha}" "${optin_results}" "${commands[@]}" || exit 1
    fi
    # --milestone-warning: pr-push.sh --mode pr の結果の milestone が unassigned のとき（Closes 対象の Issue に milestone が無い）、
    # 警告の行を無ければ末尾へ足す（新規作成の経路で pr-push.sh が本文へ足すものと同じ文言）
    if [ "${milestone_warning}" = 1 ] && ! grep -qF "${MILESTONE_WARNING_PREFIX}#${issue} " "${body}"; then
      {
        echo
        echo "${MILESTONE_WARNING_PREFIX}#${issue} に milestone が割り当てられていない。"
      } >>"${body}"
    fi
    ;;
  optin)
    pw_optin_rewrite "${body}" "${optin_sha}" "${optin_results}" "${commands[@]}" || exit 1
    ;;
  oos-append)
    # 本文に既にある threadId の行は足さない
    : >"${newlines}"
    while IFS= read -r l; do
      t=${l#'- [threadId: '}
      t=${t%%']'*}
      grep -qF "[threadId: ${t}]" "${body}" || printf '%s\n' "${l}" >>"${newlines}"
    done <"${add}"
    if [ ! -s "${newlines}" ]; then
      echo OK
      exit 0
    fi
    # 見出しの行（前後の空白と CR を無視）を探し、その節（次の「#」で始まる見出しの行の手前まで）の最後の空でない行の
    # 後ろへ足す。見出しが無ければ、空行 1 つと見出しを末尾に足してから足す
    awk -v h="${OOS_HEADING}" -v add="${newlines}" '
      function trim(s) { sub(/\r$/, "", s); sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
      { line[NR] = $0 }
      END {
        hi = 0
        for (i = 1; i <= NR; i++) if (trim(line[i]) == h) { hi = i; break }
        if (hi == 0) {
          for (i = 1; i <= NR; i++) print line[i]
          print ""
          print h
          while ((getline a < add) > 0) print a
          exit 0
        }
        last = hi
        for (i = hi + 1; i <= NR; i++) {
          if (line[i] ~ /^[ \t]*#/) break
          if (trim(line[i]) != "") last = i
        }
        for (i = 1; i <= last; i++) print line[i]
        while ((getline a < add) > 0) print a
        for (i = last + 1; i <= NR; i++) print line[i]
      }
    ' "${body}" >"${merged}" || fail "対象外の行を本文へ足せない"
    mv -f -- "${merged}" "${body}" || fail "一時ファイルを置き換えられない"
    ;;
esac

# 書き戻す前の確認（fail-closed）: 空でない・取得した本文にあった Closes 行と対象外の見出しを失っていない
[ -s "${body}" ] || fail "補正後の本文が空"
if grep -qF "Closes #" "${orig}" && ! grep -qF "Closes #" "${body}"; then
  fail "補正後の本文から Closes 行が消える"
fi
if grep -qF "${OOS_HEADING}" "${orig}" && ! grep -qF "${OOS_HEADING}" "${body}"; then
  fail "補正後の本文から対象外の節が消える"
fi

pw_gh_pr edit "${pr}" --body-file "${body}" >/dev/null || fail "gh pr edit に失敗"

# 反映の確認: 取り直した本文に、足したものがあること
pw_fetch_body "${pr}" "${after}" || fail "更新後の本文を取得できない"
case "${sub}" in
  ensure)
    grep -qF "Closes #${issue}" "${after}" || fail "更新後の本文に Closes #${issue} が無い"
    if [ -n "${oos_nonce}" ]; then
      grep -qF "${OOS_HEADING}" "${after}" || fail "更新後の本文に対象外の節が無い"
    fi
    ;;
  oos-append)
    grep -qF "${OOS_HEADING}" "${after}" || fail "更新後の本文に対象外の節が無い"
    while IFS= read -r l; do
      t=${l#'- [threadId: '}
      t=${t%%']'*}
      grep -qF "[threadId: ${t}]" "${after}" || fail "更新後の本文に threadId ${t} の行が無い"
    done <"${newlines}"
    ;;
esac
if [ -n "${optin_sha}" ]; then
  rest="${optin_results}"
  for c in "${commands[@]}"; do
    r=${rest%%,*}
    rest=${rest#*,}
    grep -qxF "${PW_OPTIN_MARKER_PREFIX}${optin_sha} ${r} ${c} -->" "${after}" || fail "更新後の本文に記録のマーカー行が無い（${r}）"
  done
fi
echo OK
