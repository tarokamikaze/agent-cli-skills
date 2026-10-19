#!/usr/bin/env bash
# branch-ff.sh — Review ループの fix のコミットを、ローカルのブランチ（refs/heads/<branch>）へ fast-forward で載せる
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、隔離されていないエージェントがメイン worktree で 1 回実行する）:
#   bash branch-ff.sh --branch BRANCH --sha SHA [--fix-worktree PATH] [--allow PATH]...
#     --branch        fix の対象ブランチ（ホストが isValidBranchName で検証した値）
#     --sha           fix が作った HEAD（40 桁の小文字 16 進。fix エージェントの申告値）
#     --fix-worktree  fix が作業した worktree のパス（fix エージェントの申告値。sanitizeWorktreePath 済み）。fix がパスを返さなかったときは
#                     省く（ブランチを checkout している worktree があればその側で ff でき、無ければ fix-worktree-missing で止まる）
#     --allow         ブランチを checkout している worktree の側で ff してよいパス（ホストが記録した実装 worktree・直前の fix worktree）
#
# 役割: 以前は fix エージェント自身が、ブランチを checkout している別の worktree へ `git -C <その worktree> merge --ff-only` していた。
#       Claude Code は、隔離された worktree のエージェントが自分以外の worktree を git -C で指すことを、権限の設定とは別に拒否する。
#       そのため fix のコミットがブランチへ載らず、Issue が blocked で止まっていた。ブランチの更新を、隔離されていない側で動く
#       このスクリプトへ移し、fix エージェントには fixHeadSha と worktree のパスを返させるだけにする。
#   1. ブランチの先端を読む。先端が --sha と同じなら何もしない（already-synced。fix が積むコミットが無かった）
#   2. --sha がコミットとして存在し、先端がその祖先であること（fast-forward になること）を確かめる
#   3. fix の worktree が登録されていれば、その HEAD が --sha であり、追跡ファイルに未コミットの変更が無いことを確かめる
#      （申告された sha と worktree の取り違えを止める。fix がコミットし忘れた変更を黙って捨てない）
#   4. ブランチを checkout している worktree（git worktree list --porcelain の branch 行）を探す
#      - ある: メイン worktree でなく、--allow のいずれかと同じ場所で、追跡ファイルに未コミットの変更が無いときだけ、
#              その worktree で `git merge --ff-only <sha>` する。作業ツリーとブランチが一緒に進む
#      - 無い: fix の worktree（登録済み・detached・HEAD が --sha）で、ブランチを checkout してから `git merge --ff-only <sha>` する。
#              以後は fix の worktree がブランチを持つ（次の巡の fix はホストの許可リストの「直前の fix worktree」としてそこで ff する）
#   5. refs/heads/<branch> が --sha になったことを確かめる
#   git update-ref・git branch -f でブランチだけを動かす形は使わない（checkout している worktree の作業ツリーとブランチがずれる。
#   scripts/ の静的ガードも update-ref を限られた形以外拒否する）。push・fetch・reset・削除はしない。
#
# 出力: 標準出力の最後の 1 行が `BRANCH_FF_RESULT {"ok":bool,"result":"<語>","via":"owner|fix-worktree|none"}`。値は固定語彙だけ
#       （パス・ブランチ名・git の出力を入れない。診断は標準エラーへ）。結果を出せたときは、失敗を含めて exit 0。
#       ok:true の result は synced（ff した）と already-synced（先端が既に --sha）の 2 語だけ。
#       ok:false の result: list-failed / branch-missing / fix-commit-missing / not-fast-forward / ancestry-unknown /
#         fix-head-mismatch / fix-worktree-dirty / fix-worktree-missing / fix-worktree-not-detached / owner-main / owner-not-allowed /
#         owner-dirty / owner-unobservable / checkout-failed / ff-failed / verify-mismatch
# 終了コード: 0 結果の行を出力した / 2 使い方の誤り（結果の行は出さない）/ 3 git が無い・lib を読めない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT
# 環境から継承した git の対象の指定で、別のリポジトリ・別の作業ツリーを操作しない（worktree-remove.sh と同じ）
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE

command -v git >/dev/null 2>&1 || { echo "branch-ff: git が無い" >&2; exit 3; }
script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 3
# shellcheck source=lib/worktree-remove-lib.sh
. "${script_dir}/lib/worktree-remove-lib.sh" || exit 3

usage() {
  echo "使い方: branch-ff.sh --branch BRANCH --sha SHA [--fix-worktree PATH] [--allow PATH]..." >&2
  [ $# -eq 0 ] || echo "branch-ff: $1" >&2
  exit 2
}

branch=""
sha=""
fix_wt=""
allows=()
while [ $# -gt 0 ]; do
  case "$1" in
    --branch | --sha | --fix-worktree | --allow)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --branch) branch=$2 ;;
        --sha) sha=$2 ;;
        --fix-worktree)
          wr_valid_path "$2" || usage "--fix-worktree の形が不正"
          fix_wt=$2
          ;;
        --allow)
          wr_valid_path "$2" || usage "--allow の形が不正"
          allows+=("$2")
          ;;
      esac
      shift 2
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done
[ -n "${branch}" ] && wr_valid_branch "${branch}" || usage "--branch は必須で、ブランチ名の形"
git check-ref-format "refs/heads/${branch}" || usage "--branch が git の ref 名として不正"
wr_valid_head "${sha}" || usage "--sha は 40 桁の小文字 16 進"

VIA=none
emit() { # $1 = ok（true / false）、$2 = result の語
  printf 'BRANCH_FF_RESULT {"ok":%s,"result":"%s","via":"%s"}\n' "$1" "$2" "${VIA}"
  exit 0
}
fail() { # $1 = result の語、$2 = 標準エラーへの診断
  echo "branch-ff: $2" >&2
  emit false "$1"
}

# 追跡ファイルの未コミットの変更（staged を含む）が無いか。0 = 無い、1 = ある、2 = 観測できない
tracked_clean() { # $1 = worktree のパス
  local out
  out=$(git -C "$1" status --porcelain --untracked-files=no 2>/dev/null) || return 2
  [ -z "${out}" ] || return 1
  return 0
}

# 1. ブランチの先端
tip=$(git rev-parse --verify -q "refs/heads/${branch}^{commit}" 2>/dev/null) || tip=""
wr_valid_head "${tip}" || fail branch-missing "ブランチの先端を読めない"
[ "${tip}" != "${sha}" ] || emit true already-synced

# 2. fix のコミットと祖先関係
got=$(git rev-parse --verify -q "${sha}^{commit}" 2>/dev/null) || got=""
[ "${got}" = "${sha}" ] || fail fix-commit-missing "fix のコミットがリポジトリに無い"
arc=0
git merge-base --is-ancestor "${tip}" "${sha}" >/dev/null 2>&1 || arc=$?
case "${arc}" in
  0) ;;
  1) fail not-fast-forward "ブランチの先端が fix のコミットの祖先でない（fix の後にブランチが別の操作で動いた）" ;;
  *) fail ancestry-unknown "祖先関係を確かめられない" ;;
esac

# 3. fix の worktree（登録されていれば HEAD と汚れを確かめる）
list=$(git worktree list --porcelain 2>/dev/null) || fail list-failed "git worktree list を読めない"
fix_registered=0
if [ -n "${fix_wt}" ]; then
  wr_find_entry "${list}" "${fix_wt}"
else
  WR_REGISTERED=0
fi
if [ "${WR_REGISTERED}" = 1 ] && [ "${WR_MAIN}" != 1 ]; then
  fix_registered=1
  fix_head=$(git -C "${fix_wt}" rev-parse --verify -q HEAD 2>/dev/null) || fix_head=""
  [ "${fix_head}" = "${sha}" ] || fail fix-head-mismatch "fix の worktree の HEAD が申告された sha と違う"
  trc=0
  tracked_clean "${fix_wt}" || trc=$?
  [ "${trc}" = 0 ] || fail fix-worktree-dirty "fix の worktree に未コミットの変更がある・観測できない"
fi

# 4. ブランチを checkout している worktree（メインを含めて探す）
owner=""
owner_idx=0
idx=0
cur=""
while IFS= read -r line; do
  case "${line}" in
    'worktree '*)
      cur=${line#worktree }
      idx=$((idx + 1))
      ;;
    'branch refs/heads/'*)
      if [ -z "${owner}" ] && [ "${line#branch refs/heads/}" = "${branch}" ]; then
        owner=${cur}
        owner_idx=${idx}
      fi
      ;;
  esac
done <<<"${list}"

if [ -n "${owner}" ]; then
  VIA=owner
  [ "${owner_idx}" != 1 ] || fail owner-main "ブランチをメイン worktree が checkout している（メイン worktree には触れない）"
  allowed=0
  owner_real=$(wr_real "${owner}")
  for a in "${allows[@]+"${allows[@]}"}"; do
    if wr_same_path "${owner}" "${owner_real}" "${a}" "$(wr_real "${a}")" 0; then
      allowed=1
      break
    fi
  done
  [ "${allowed}" = 1 ] || fail owner-not-allowed "ブランチを checkout している worktree が許可リストに無い（別のラン・人の作業中の worktree には触れない）"
  orc=0
  tracked_clean "${owner}" || orc=$?
  case "${orc}" in
    0) ;;
    1) fail owner-dirty "ブランチを checkout している worktree に未コミットの変更がある" ;;
    *) fail owner-unobservable "ブランチを checkout している worktree の状態を観測できない" ;;
  esac
  mrc=0
  git -C "${owner}" merge --ff-only -q "${sha}" </dev/null >&2 || mrc=$?
  [ "${mrc}" = 0 ] || fail ff-failed "fast-forward に失敗した"
else
  VIA=fix-worktree
  [ "${fix_registered}" = 1 ] || fail fix-worktree-missing "ブランチを checkout している worktree が無く、fix の worktree も登録されていない"
  git -C "${fix_wt}" symbolic-ref -q HEAD >/dev/null 2>&1 && fail fix-worktree-not-detached "fix の worktree が detached HEAD でない"
  crc=0
  git -C "${fix_wt}" checkout -q "${branch}" -- </dev/null >&2 || crc=$?
  [ "${crc}" = 0 ] || fail checkout-failed "fix の worktree でブランチを checkout できない"
  mrc=0
  git -C "${fix_wt}" merge --ff-only -q "${sha}" </dev/null >&2 || mrc=$?
  if [ "${mrc}" != 0 ]; then
    # fix のコミットが worktree の HEAD からたどれなくならないよう、fix のコミットへ戻す
    git -C "${fix_wt}" checkout -q --detach "${sha}" </dev/null >&2 || true
    fail ff-failed "fast-forward に失敗した（fix の worktree は fix のコミットへ戻した）"
  fi
fi

# 5. ブランチが fix のコミットへ進んだか
now=$(git rev-parse --verify -q "refs/heads/${branch}^{commit}" 2>/dev/null) || now=""
[ "${now}" = "${sha}" ] || fail verify-mismatch "ff の後もブランチの先端が fix のコミットと違う"
emit true synced
