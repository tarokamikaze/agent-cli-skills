#!/usr/bin/env bash
# worktree-cleanup.sh — worktree とブランチの削除を、削除の安全判定ごと 1 コマンドで行うスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリはメイン worktree）:
#   bash worktree-cleanup.sh remove        <worktree の絶対パス>
#   bash worktree-cleanup.sh delete-branch <ブランチ名>
#   bash worktree-cleanup.sh sweep         <状態ファイル> <nonce> <束縛した候補一覧の sha256>
#
# 旧プロンプトは掃除の agent（state:cleanup）とラン末尾のスイープの agent（worktree:sweep）に、$(cd "$p" && pwd -P)・
# awk・while ループ・rm -rf を含むシェルを書かせていた。利用側の PreToolUse の hook が拒否しうる形（cd の後の &&、3 本以上の
# 連結）に当たるため、削除の安全判定ごとこのスクリプトへ移した。判定の結果と順序は旧プロンプトの手順と同じ:
#   1. 対象が git worktree list --porcelain の登録済みパスか（先頭のエントリ = メイン worktree は除く）
#   2. git worktree remove --force、失敗したら unlock してもう一度
#   3. それでも失敗したら、rm -rf の前に実パス（cd して pwd -P）で確かめる。実パスが空（もう無い）なら消さない。
#      git rev-parse --show-toplevel・porcelain の先頭エントリの実パスと一致する、または toplevel の配下なら消さない
#   4. 最後に git worktree prune
# sweep はこれに加えて、状態ファイルで failed / blocked / monitoring の項目が記録した worktree を消さない（旧手順 1）。
# 候補の一覧（JSON の配列 1 行）はコマンド行に載せない。agent が Write ツールで <状態ファイル>.sweep-<nonce>.json に書き、
# このスクリプトが SHA-256(nonce + 改行 + sweep + 改行 + 内容〔末尾の改行を除く〕) をホストの渡した値と照合してから使う
# （state-write.sh の patch と同じ形。写し間違いを削除の前に止める。悪意のある書き換えへの認証ではない）。
# 候補ファイルは成否・引数の誤りに関わらず消す（nonce の形式を確かめたあと）。
#
# 旧手順より厳しくした点（どれも「消さない」側。消す場合の判定は変えていない）:
#   - パス・ブランチ名の形式をホストの sanitizeWorktreePath・isValidBranchName と同じ規則で検査し直す（不正は exit 2）
#   - git rev-parse --show-toplevel が失敗したら rm -rf しない（旧手順は "$main"/* が /* になり、結果として同じく消さなかった）
#   - porcelain の先頭エントリの実パスの配下も消さない（toplevel は cwd に依存し、リンク worktree の中から起動されると
#     メイン worktree の配下を守れないため）。その実パスを取れないときも rm -rf しない
#   - git worktree list の取得に失敗したら何も消さない
#   - porcelain の先頭エントリは、旧 state:cleanup の awk '{print $2}'（空白で切れる）ではなく sweep と同じ接頭辞の除去で読む
#
# 出力（標準出力）:
#   remove:        REMOVED <パス> / ABSENT <パス>（登録されていない・もう無い）/ REFUSED <パス>（メイン worktree かその配下）/
#                  FAILED <パス>
#   delete-branch: DELETED <ブランチ> / ABSENT <ブランチ> / FAILED <ブランチ>
#   sweep:         候補ごとに REMOVED <パス> か SKIPPED <理由> <パス>（理由は retained / unregistered / invalid / absent /
#                  refused / failed）、保持対象ごとに RETAINED <パス>、最後に DONE <削除した件数>
# 終了コード:
#   0  remove: REMOVED / ABSENT。delete-branch: DELETED / ABSENT。sweep: DONE まで進んだ（個々の候補の失敗を含む）
#   1  remove: REFUSED / FAILED。delete-branch: FAILED。sweep: 候補一覧の照合の失敗・状態ファイルを読めない・
#      worktree の一覧を取れない（何も消さない）
#   2  使い方の誤り（未知のサブコマンド・引数の形式不正）。何も消さない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。連想配列・mapfile を使わない。
# 副作用: 上の削除と git worktree prune、自分で作った一時ファイル（終了時に消す）、sweep の候補ファイルの削除だけ。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2

usage() {
  echo "使い方: worktree-cleanup.sh {remove パス|delete-branch ブランチ|sweep 状態ファイル nonce sha256}" >&2
  exit 2
}

# 自分で作った一時ディレクトリと sweep の候補ファイルを終了時に消す（候補ファイルは検証済みの状態ファイルのパスと nonce から
# 組み立てた <状態ファイル>.sweep-<nonce>.json の形のものだけ）
work=''
cand_src=''
cleanup() {
  [ -n "${work}" ] && rm -rf -- "${work}"
  [ -n "${cand_src}" ] && rm -f -- "${cand_src}"
  return 0
}
trap cleanup EXIT
make_work() {
  work=$(mktemp -d) || return 1
}

# ホストの sanitizeWorktreePath と同じ規則: 絶対パスで、先頭の / の次は英数字、英数字・/・-・_・.・半角スペースだけ、.. を含まない
valid_wt_path() {
  case "$1" in
    '' | *..*) return 1 ;;
    /[A-Za-z0-9]*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9/_.\ -]*) return 1 ;;
  esac
  return 0
}

# ホストの isValidBranchName と同じ規則: 先頭は英数字、英数字・-・_・.・/ だけ、.. を含まない
valid_branch() {
  case "$1" in
    '' | *..* | *[!A-Za-z0-9/_.-]*) return 1 ;;
    [A-Za-z0-9]*) return 0 ;;
  esac
  return 1
}

# 実パス（シンボリックリンクを解いた絶対パス）。無い・入れないときは空
real_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

# git worktree list --porcelain の worktree 行のパスを、1 行に 1 つ $1 のファイルへ書く（先頭はメイン worktree）。
# パスに空白を含んでも壊れないよう、フィールド分割ではなく "worktree " の接頭辞を除いて読む
list_worktrees() {
  git worktree list --porcelain >"${work}/porcelain" || return 1
  awk '/^worktree /{sub(/^worktree /,""); print}' "${work}/porcelain" >"$1"
}

# rm -rf の前の安全確認と削除（旧手順のフォールバックの b）。$1 = 対象パス、$2 = メイン worktree（porcelain の先頭）。
# 戻り値: 0 = 消した、10 = もう無い（消す必要がない）、11 = メイン worktree かその配下なので消さない、12 = rm -rf の失敗
safe_rm() {
  local p="$1" main_wt="$2" target main main_wt_real
  target=$(real_dir "${p}")
  main=$(git rev-parse --show-toplevel 2>/dev/null)
  main_wt_real=''
  [ -n "${main_wt}" ] && main_wt_real=$(real_dir "${main_wt}")
  [ -z "${target}" ] && return 10
  [ -z "${main}" ] && return 11
  # porcelain の先頭（メイン worktree）の実パスを取れないときも消さない（下の配下の判定ができないため）
  [ -z "${main_wt_real}" ] && return 11
  if [ "${target}" = "${main}" ] || [ "${target}" = "${main_wt_real}" ]; then
    return 11
  fi
  # 配下の判定は、cwd の toplevel（main）と porcelain の先頭の実パス（main_wt_real）の両方で行う。toplevel は cwd に依存し、
  # リンク worktree の中から起動されるとその worktree を指すため、それだけではメイン worktree の配下を守れない
  case "${target}" in
    "${main}"/* | "${main_wt_real}"/*) return 11 ;;
  esac
  rm -rf -- "${p}" || return 12
  return 0
}

# 登録済みの worktree を消す（旧手順の remove --force → unlock して再試行 → 安全確認のうえ rm -rf）。戻り値は safe_rm と同じ。
# $3 が 1 なら rm -rf で消したあとに git worktree prune する（旧 state:cleanup の「成功後 git worktree prune」。旧スイープは
# ループの中で prune せず最後に 1 回だけなので 0 を渡す。ループの途中で prune すると、実体の無い後続の候補の登録が先に消え、
# remove が失敗して「消した」と数えなくなる）
remove_registered() {
  local p="$1" main_wt="$2" prune_after_rm="$3" rc
  git worktree remove --force -- "${p}" >&2 && return 0
  git worktree unlock -- "${p}" >/dev/null 2>&1
  git worktree remove --force -- "${p}" >/dev/null 2>&1 && return 0
  safe_rm "${p}" "${main_wt}"
  rc=$?
  [ "${rc}" -eq 0 ] && [ "${prune_after_rm}" = 1 ] && git worktree prune >&2
  return "${rc}"
}

[ $# -ge 1 ] || usage
sub=$1
shift

case "${sub}" in
  remove)
    [ $# -eq 1 ] || usage
    p=$1
    valid_wt_path "${p}" || usage
    make_work || { echo "FAILED ${p}"; exit 1; }
    wts="${work}/worktrees"
    if ! list_worktrees "${wts}"; then
      echo "FAILED ${p}"
      exit 1
    fi
    main_wt=$(sed -n 1p "${wts}")
    if [ "${p}" = "${main_wt}" ]; then
      echo "REFUSED ${p}"
      exit 1
    fi
    # 登録されていなければ何もしない（旧手順: 含まれない場合・すでに存在しない場合は正常終了）
    if ! sed 1d "${wts}" | grep -qxF -- "${p}"; then
      git worktree prune >&2
      echo "ABSENT ${p}"
      exit 0
    fi
    remove_registered "${p}" "${main_wt}" 1
    rc=$?
    git worktree prune >&2
    case "${rc}" in
      0) echo "REMOVED ${p}" ;;
      10) echo "ABSENT ${p}" ;;
      11)
        echo "REFUSED ${p}"
        exit 1
        ;;
      *)
        echo "FAILED ${p}"
        exit 1
        ;;
    esac
    exit 0
    ;;
  delete-branch)
    [ $# -eq 1 ] || usage
    b=$1
    valid_branch "${b}" || usage
    if ! out=$(git branch --list -- "${b}"); then
      echo "FAILED ${b}"
      exit 1
    fi
    if [ -z "${out}" ]; then
      echo "ABSENT ${b}"
      exit 0
    fi
    if git branch -D -- "${b}" >&2; then
      echo "DELETED ${b}"
      exit 0
    fi
    echo "FAILED ${b}"
    exit 1
    ;;
  sweep)
    # 状態ファイルと nonce の形式を確かめたら、以降の引数の誤り（exit 2）でも候補ファイルを残さない
    if [ $# -ge 2 ] && sf_valid_state_path "$1" && sf_valid_nonce "$2"; then
      cand_src="$1.sweep-$2.json"
    fi
    [ $# -eq 3 ] || usage
    [ -n "${cand_src}" ] || usage
    state=$1
    nonce=$2
    want=$3
    case "${want}" in
      '' | *[!0-9a-f]*) usage ;;
    esac
    [ "${#want}" -eq 64 ] || usage
    make_work || exit 1

    # 候補一覧: 自分の一時ファイルへ写し、その写しを照合して使う（照合のあとで元ファイルが差し替えられても、照合していない
    # 内容を読まない）
    if [ ! -f "${cand_src}" ]; then
      echo "FAILED: 候補一覧のファイルが無い（${cand_src}）" >&2
      exit 1
    fi
    cand="${work}/candidates.json"
    cp -- "${cand_src}" "${cand}" || { echo "FAILED: 候補一覧のファイルを読めない" >&2; exit 1; }
    actual=$(printf '%s\n%s\n%s' "${nonce}" sweep "$(cat -- "${cand}")" | so_sha256) || { echo "FAILED: SHA-256 を計算できない" >&2; exit 1; }
    if [ "${actual}" != "${want}" ]; then
      echo "FAILED: 候補一覧の内容がホストの渡したものと一致しない（期待 ${want}・実測 ${actual}）" >&2
      exit 1
    fi
    paths="${work}/paths"
    if ! jq -r '.[]' "${cand}" >"${paths}"; then
      echo "FAILED: 候補一覧を JSON の配列として読めない" >&2
      exit 1
    fi

    # 旧手順 1: 保持対象（failed / blocked / monitoring の項目が記録した worktree）。状態ファイルが無い・読めないなら何も消さない
    retain="${work}/retain"
    if ! jq -r '.items | to_entries[] | select(.value.status == "failed" or .value.status == "blocked" or .value.status == "monitoring") | .value.worktree | select(. != null and . != "")' "${state}" >"${retain}"; then
      echo "FAILED: 状態ファイルを読めない（${state}）。何も消さない" >&2
      exit 1
    fi
    # 旧手順 2: 登録済みのパス（先頭 = メイン worktree を除く）
    wts="${work}/worktrees"
    if ! list_worktrees "${wts}"; then
      echo "FAILED: git worktree list を取れない。何も消さない" >&2
      exit 1
    fi
    main_wt=$(sed -n 1p "${wts}")
    registered="${work}/registered"
    sed 1d "${wts}" >"${registered}"

    # 旧手順 3・4: 一覧にあり、登録済みで、保持対象でないものだけを消す。1 件の失敗で止めない
    removed=0
    while IFS= read -r p; do
      [ -z "${p}" ] && continue
      if ! valid_wt_path "${p}"; then
        echo "SKIPPED invalid ${p}"
        continue
      fi
      if grep -qxF -- "${p}" "${retain}"; then
        echo "SKIPPED retained ${p}"
        continue
      fi
      if ! grep -qxF -- "${p}" "${registered}"; then
        echo "SKIPPED unregistered ${p}"
        continue
      fi
      remove_registered "${p}" "${main_wt}" 0 </dev/null
      case $? in
        0)
          echo "REMOVED ${p}"
          removed=$((removed + 1))
          ;;
        10) echo "SKIPPED absent ${p}" ;;
        11) echo "SKIPPED refused ${p}" ;;
        *) echo "SKIPPED failed ${p}" ;;
      esac
    done <"${paths}"
    while IFS= read -r r; do
      [ -n "${r}" ] && echo "RETAINED ${r}"
    done <"${retain}"
    # 旧手順 5
    git worktree prune >&2
    echo "DONE ${removed}"
    exit 0
    ;;
  *) usage ;;
esac
