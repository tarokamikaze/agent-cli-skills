#!/usr/bin/env bash
# g0-check.sh — マージ実行（merge-exec）の G0 ゲート（ベースブランチのサーバー側強制の実測）を判定する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリのリポジトリが対象）:
#   bash g0-check.sh <URL エンコード済みのベースブランチ名> <40 桁の head sha> [<App の slug>:<エンコード済みの context>...]
#
#   3 つ目以降は args.externalChecks で宣言した App と信頼済み check context の組（G0 の (iv)）。context は任意の文字列で
#   空白・引用符・{} を含みうるので、ホストが英数字・.・_・- 以外の全バイトを %XX（大文字の 16 進。UTF-8 のバイト単位）に
#   したものを渡す（コマンド行に引用符と {} を載せないため）。このスクリプトが元の文字列に戻し、jq の --arg に値で渡す。
#   制御文字（%00〜%1F・%7F）を含むものと、slug の形式（ホストの EXTERNAL_CHECK_APP_SLUG_RE）に合わないものは使い方の誤り。
#
# 旧プロンプト（merge-exec の手順 2b (i)〜(v-b)）が agent に実行させていた、gh api の結果を jq へパイプする多段・
# --jq の式（{} と | を含む）・HEAD_SHA / REQ / RSC / APP_ID_<SLUG> の代入と、それらを 1 回の Bash 実行でまとめて流す手順を、
# スクリプトへ移したもの（Issue #11 の範囲 B）。各判定の jq の式は旧プロンプトと同じで、判定の順序も同じ（例外は、あとから
# (i) の直後に足した (i-a)。Issue #15）。旧手順と同じく、
# 不合格（取得の失敗を含む）になった判定でそれより後の判定を行わずに終わる。違うのは、ルールの一覧（rules/branches）と
# HEAD sha 上の check-run を 1 回ずつだけ取得して各判定で使い回すこと（旧手順は判定ごとに同じ API を取り直していた）。
#
# 出力（標準出力）: 判定ごとに「<判定名> <値>」の行を下の順で。値は件数（非負整数）か true / false、取得・計算に失敗したら
# error。不合格の判定より後の行は出さない。最後に必ず「verdict <結果>」の 1 行を出す（使い方の誤りを除く）。
#   required-status-check-rules <件数>            (i)    required_status_checks のルールの件数。1 以上で合格
#   required-status-check-contexts <件数>         (i-a)  必須の context（重複なし・空でない文字列）の件数。1 以上で合格
#                                                        （旧手順に無い判定。Issue #15）
#   non-repository-rulesets <件数>                (i-b)  適用 ruleset のうち、id が数値でない・ソースが Repository でないもの。0 で合格
#   rulesets-with-bypass <件数>                   (i-b)  bypass_actors が空の配列でない ruleset。0 で合格
#   thread-resolution-required <true|false>       (iii)  pull_request ルールのどれかが required_review_thread_resolution。true で合格
#   unbound-external-contexts <件数>              (iv)   宣言した App ID + context の組で required になっていないもの。0 で合格
#                                                        （宣言なしなら 0。App ID が数値で取れなければ error）
#   client-only-check-runs <件数>                 (v)    HEAD 上の check-run のうち required に含まれない名前の件数。0 で合格
#   client-only-statuses <件数>                   (v)    HEAD 上の commit status の context（重複なし）のうち required に含まれないもの。0 で合格
#   required-checks-without-integration-id <件数> (v-b)  integration_id が数値でない required check。0 で合格
#   required-contexts-without-bound-run <件数>    (v-b)  宣言 integration_id と一致する App の check-run が HEAD 上に無い required context。0 で合格
#   verdict <pass|classic-unsupported|server-enforcement-missing|issuer-unbound|checks-not-green>
# verdict の決め方（旧プロンプトの判定と同じ）:
#   (i) が 0 か error → classic-unsupported。(i-a)・(i-b)・(iii)・(iv)・(v) の不合格・error → server-enforcement-missing
#   （(i-a) だけは旧手順に無く、必須の context が 0 件の構成では旧手順が pass にしうるところを辞退にする）。
#   (v-b) の 1 つ目が 1 以上か error、または 2 つ目が error → issuer-unbound。1 つ目が 0 で 2 つ目だけ 1 以上 → checks-not-green
#   （束縛済みの check-run が未発行。一過性の可能性）。すべて合格 → pass。
# 終了コード:
#   0  verdict pass
#   1  verdict が pass 以外（取得の失敗を含む。合格に倒さない）
#   2  使い方の誤り（何も出さない）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（GET だけ。branch protection の protection 系エンドポイントは呼ばない）。context 文字列・App 名・チェック名は出さない。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/gh-read.sh
. "${script_dir}/lib/gh-read.sh" || exit 2

usage() {
  echo "使い方: g0-check.sh ベースブランチ（URL エンコード済み） HEAD_SHA（40 桁の小文字 16 進） [APP_SLUG:エンコード済みの CONTEXT ...]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
gr_valid_encoded_branch "$1" && gr_valid_sha "$2" || usage
branch=$1
sha=$2
shift 2

# 宣言した App と context の組を検証して元の文字列に戻す。bash 3.2 の set -u は空配列の "${a[@]}" を未定義として扱うので、
# 件数 n と添字で読む
ctx_arg_re='^[a-z0-9][a-z0-9-]{0,38}:([A-Za-z0-9._-]|%[0-9A-F]{2})+$'
n=0
for a in "$@"; do
  [ "${#a}" -le 3200 ] || usage
  [[ ${a} =~ ${ctx_arg_re} ]] || usage
  gr_valid_slug "${a%%:*}" || usage
  enc=${a#*:}
  # % は必ずエスケープの先頭なので、%0X・%1X・%7F は制御文字そのもの
  case "${enc}" in
    *%0[0-9A-F]* | *%1[0-9A-F]* | *%7F*) usage ;;
  esac
  slugs[n]=${a%%:*}
  ctxs[n]=$(printf '%b' "${enc//%/\\x}") || usage
  [ -n "${ctxs[n]}" ] || usage
  n=$((n + 1))
done

emit() {
  printf '%s %s\n' "$1" "$2"
}

finish() {
  emit verdict "$1"
  [ "$1" = pass ] && exit 0
  exit 1
}

is_count() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  return 0
}

# (i) ruleset の required status checks の存在。ルールは全ページを 1 つの配列に束ねて、以降の判定でも使う
rules_ok=0
rules=$(gr_rules_pages "${branch}") && rules_ok=1
v=error
if [ "${rules_ok}" = 1 ]; then
  c=$(printf '%s' "${rules}" | jq '[.[][] | select(.type == "required_status_checks")] | length') && is_count "${c}" && v=${c}
fi
emit required-status-check-rules "${v}"
[ "${v}" != error ] && [ "${v}" -ge 1 ] || finish classic-unsupported

# (i-a) 必須の context が 1 件以上あること（旧手順に無い判定。Issue #15）。ルールがあっても必須の context が 0 件なら、
# サーバー側の強制は何も見ていない。旧手順は HEAD にチェックも commit status も無いと (v)・(v-b) が 0/0 になって pass に
# していた。(i) と分けるのは、(i) の不合格は classic branch protection の経路（classic-unsupported）を意味し、こちらは
# ruleset の経路でサーバー側の強制を確認できない（server-enforcement-missing）ため。ここで求めた REQ は (v) でも使う
v=error
req_ok=0
if req=$(printf '%s' "${rules}" | gr_required_contexts_of_pages) && [ -n "${req}" ]; then
  req_ok=1
  c=$(printf '%s' "${req}" | jq '[.[] | select(type == "string" and length > 0)] | length') && is_count "${c}" && v=${c}
fi
emit required-status-check-contexts "${v}"
[ "${v}" != error ] && [ "${v}" -ge 1 ] || finish server-enforcement-missing

# (i-b) 適用 ruleset がすべて数値の id でリポジトリの ruleset であること（Organization から継承した ruleset は検証できない）
v=error
sources=$(printf '%s' "${rules}" | jq -c '[.[][] | {id: .ruleset_id, src: .ruleset_source_type}] | unique') &&
  c=$(printf '%s' "${sources}" | jq '[.[] | select((.id | type) != "number" or .src != "Repository")] | length') &&
  is_count "${c}" && v=${c}
emit non-repository-rulesets "${v}"
[ "${v}" = 0 ] || finish server-enforcement-missing

# (i-b) 各 ruleset の bypass_actors が空の配列であること（false・null・取得の失敗は不合格）
v=error
if ids=$(printf '%s' "${sources}" | jq -r '[.[].id] | unique | .[]'); then
  v=0
  for id in ${ids}; do
    if ! is_count "${id}"; then
      v=error
      break
    fi
    if ! o=$(gh api "repos/{owner}/{repo}/rulesets/${id}" --jq '.bypass_actors | type == "array" and length == 0'); then
      v=error
      break
    fi
    [ "${o}" = true ] || v=$((v + 1))
  done
fi
emit rulesets-with-bypass "${v}"
[ "${v}" = 0 ] || finish server-enforcement-missing

# (iii) レビュースレッド解消のサーバー側強制
v=error
o=$(printf '%s' "${rules}" | jq '[.[][] | select(.type == "pull_request")] | any(.parameters.required_review_thread_resolution == true)') &&
  case "${o}" in
    true | false) v=${o} ;;
  esac
emit thread-resolution-required "${v}"
[ "${v}" = true ] || finish server-enforcement-missing

# (iv) 宣言した App ID と context の組が required status checks にあること。App ID は App ごとに取得し、
# 別の App の ID を照合に使わない
v=0
prev=''
app_id=''
i=0
while [ "${i}" -lt "${n}" ]; do
  slug=${slugs[i]}
  if [ "${slug}" != "${prev}" ]; then
    if ! app_id=$(gh api "apps/${slug}" --jq '.id') || ! is_count "${app_id}"; then
      v=error
      break
    fi
    prev=${slug}
  fi
  if ! c=$(printf '%s' "${rules}" | jq --argjson appid "${app_id}" --arg ctx "${ctxs[i]}" '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | select(.integration_id == $appid and .context == $ctx)] | length') || ! is_count "${c}"; then
    v=error
    break
  fi
  [ "${c}" -ge 1 ] || v=$((v + 1))
  i=$((i + 1))
done
emit unbound-external-contexts "${v}"
[ "${v}" = 0 ] || finish server-enforcement-missing

# (v) HEAD sha 上の check-run / commit status の context がすべて required に含まれること（client-only のチェックが無いこと）
cr=error
st=error
runs_ok=0
if [ "${req_ok}" = 1 ]; then
  if runs=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/${sha}/check-runs"); then
    runs_ok=1
    c=$(printf '%s' "${runs}" | jq --argjson req "${req}" '[.[].check_runs[].name | select(. as $n | ($req | index($n)) | not)] | length') &&
      is_count "${c}" && cr=${c}
  fi
  if statuses=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/${sha}/statuses"); then
    c=$(printf '%s' "${statuses}" | jq --argjson req "${req}" '[.[][].context] | unique | map(select(. as $c | ($req | index($c)) | not)) | length') &&
      is_count "${c}" && st=${c}
  fi
fi
emit client-only-check-runs "${cr}"
emit client-only-statuses "${st}"
[ "${cr}" = 0 ] && [ "${st}" = 0 ] || finish server-enforcement-missing

# (v-b) required status checks の発行元の束縛（同名の commit status による偽装を合格の根拠にしない）
u1=error
u2=error
if rsc=$(printf '%s' "${rules}" | jq -c '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | {context: .context, integration_id: .integration_id}] | unique') && [ -n "${rsc}" ]; then
  c=$(printf '%s' "${rsc}" | jq '[.[] | select((.integration_id | type) != "number")] | length') && is_count "${c}" && u1=${c}
  if [ "${runs_ok}" = 1 ]; then
    c=$(printf '%s' "${runs}" | jq --argjson rsc "${rsc}" '[.[].check_runs[] | {n: .name, a: .app.id}] as $runs | [$rsc[] | select(. as $r | ($runs | any(.n == $r.context and .a == $r.integration_id)) | not)] | length') &&
      is_count "${c}" && u2=${c}
  fi
fi
emit required-checks-without-integration-id "${u1}"
emit required-contexts-without-bound-run "${u2}"
[ "${u1}" = 0 ] && [ "${u2}" != error ] || finish issuer-unbound
[ "${u2}" = 0 ] || finish checks-not-green
finish pass
