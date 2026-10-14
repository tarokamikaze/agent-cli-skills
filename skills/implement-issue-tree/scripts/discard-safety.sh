#!/usr/bin/env bash
# discard-safety.sh — Recover の破棄（worktree の削除）の前に、未コミットの変更と先行コミット数を観測する読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリはメイン worktree）:
#   bash discard-safety.sh <worktree の絶対パス | -> <ブランチ名 | -> <ベースブランチ>
#   （- は「無い」。パスはホストの sanitizeWorktreePath、ブランチはホストの isValidBranchName を通ったもの）
#
# 旧プロンプトは安全確認の agent（discard-safety:#N）に p=... と git -C "$p" status --porcelain、b=...・base=...・
# git rev-list --count を 1 回の呼び出しでつながせていた。利用側の PreToolUse の hook が拒否しうる形（3 本以上の連結）に
# 当たるため、このスクリプトへ移した。観測の手順と値の決め方は旧プロンプトと同じ:
#   1. パスが無い → WORKTREE_MISSING true・DIRTY false
#   2. git worktree list --porcelain の worktree 行に無い → WORKTREE_MISSING true・DIRTY false。
#      ある → git -C <パス> status --porcelain の出力が 1 行でもあれば DIRTY true、空なら false、失敗なら true（安全側）
#   3. ブランチがあれば git rev-list --count origin/<ベース>..refs/heads/<ブランチ> を AHEAD に。無い・失敗・整数でなければ -1
# 旧手順が書いていなかった git worktree list の失敗は、確認できなかったものとして WORKTREE_MISSING false・DIRTY true にする
# （安全側。ホストは dirty が true なら削除しない）。
#
# 出力（標準出力。この順で 3 行）:
#   WORKTREE_MISSING <true|false>
#   DIRTY <true|false>
#   AHEAD <整数（-1 は取得できなかった）>
# 終了コード: 0 = 上の 3 行を出した。2 = 使い方の誤り（引数の数・形式。何も出さない）
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（読み取りだけ。自分で作った一時ファイルは終了時に消す）。

set -u
LC_ALL=C
export LC_ALL

usage() {
  echo "使い方: discard-safety.sh worktreeのパス|- ブランチ|- ベースブランチ" >&2
  exit 2
}

# ホストの sanitizeWorktreePath と同じ規則
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

# ホストの isValidBranchName と同じ規則
valid_branch() {
  case "$1" in
    '' | *..* | *[!A-Za-z0-9/_.-]*) return 1 ;;
    [A-Za-z0-9]*) return 0 ;;
  esac
  return 1
}

[ $# -eq 3 ] || usage
p=$1
b=$2
base=$3
[ "${p}" = - ] || valid_wt_path "${p}" || usage
[ "${b}" = - ] || valid_branch "${b}" || usage
valid_branch "${base}" || usage

missing=false
dirty=false
if [ "${p}" = - ]; then
  missing=true
else
  work=$(mktemp -d) || exit 1
  trap 'rm -rf -- "${work}"' EXIT
  if ! git worktree list --porcelain >"${work}/porcelain"; then
    dirty=true
  elif ! awk '/^worktree /{sub(/^worktree /,""); print}' "${work}/porcelain" | grep -qxF -- "${p}"; then
    missing=true
  elif ! git -C "${p}" status --porcelain >"${work}/status"; then
    dirty=true
  elif [ -s "${work}/status" ]; then
    dirty=true
  fi
fi

ahead=-1
if [ "${b}" != - ]; then
  if n=$(git rev-list --count "origin/${base}".."refs/heads/${b}" 2>/dev/null); then
    case "${n}" in
      '' | *[!0-9]*) ;;
      *) ahead=${n} ;;
    esac
  fi
fi

echo "WORKTREE_MISSING ${missing}"
echo "DIRTY ${dirty}"
echo "AHEAD ${ahead}"
exit 0
