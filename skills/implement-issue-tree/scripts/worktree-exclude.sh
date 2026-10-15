#!/usr/bin/env bash
# worktree-exclude.sh — Write ツールで書く一時ファイルのパターンを git の除外設定（info/exclude）に載せるスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる。カレントディレクトリの作業ツリーが対象）:
#   bash worktree-exclude.sh
#
# 一時ファイル（.implement-issue-tree-<nonce>.md・<状態ファイル>.patch-<nonce>.json・<状態ファイル>.sweep-<nonce>.json）は
# 同梱スクリプトが読んで消すが、スクリプトを起動できなかった経路（hook の拒否・中断）では残る。git add の前に消す手順は
# agent がプロンプトに従うことと、カレントディレクトリが作業ツリーのルートであることに依存し、サブディレクトリで
# git add -A すると残ったファイルが stage される。除外設定に載せて、git add がどこから実行されても拾わないようにする
# （Issue #21）。
#
# 書く先: git rev-parse --git-path info/exclude が示すファイル。linked worktree でも、git が読む info/exclude は共有の
# $GIT_COMMON_DIR/info/exclude だけで（worktree ごとの $GIT_DIR/info/exclude は読まれない。git 2.51 で確認）、
# --git-path はその共有のファイルを返す。1 回書けば、メイン worktree とすべての linked worktree（あとから作るものを含む）
# に効く。リポジトリにコミットされる .gitignore は変えない。
#
# 書いた行はランのあとも残り、利用者の全 worktree に効き続ける。そのため、実際に作られる名前の形だけに絞る:
#   - /_/issue-trees/*.json.patch-*.json・/_/issue-trees/*.json.sweep-*.json: ホストの STATE_FILE は
#     `_/issue-trees/${parent}.json`（作業ツリーのルートからの相対パス）で、patch・sweep はその後ろに .patch-<nonce>.json・
#     .sweep-<nonce>.json を付けた名前（statePatchSteps・state-write.sh・worktree-cleanup.sh）。場所が決まっているので
#     ルートにアンカーする（release.patch-notes.json のような利用者のファイルを巻き込まない）
#   - .implement-issue-tree-*.md: agent が「カレントディレクトリ」に書く（writtenFileOf・pw_written_path）。カレント
#     ディレクトリが作業ツリーのルートである保証は無いので、アンカーしない（名前の接頭辞がこのスキル固有なので、
#     利用者のファイルに当たることは実質ない）
#
# 冪等: 既にある行（行全体の一致）は足さない。末尾に改行の無い既存のファイルには改行を補ってから足す。
# 並列の agent が同時に実行すると、確認と追記の間に割り込まれて同じブロックが重複して追記されうる（原子的でない）。
# 重複した行は git には無害なので許容し、ロックは取らない。
# 書いたあと、各パターンに当たる見本の名前を、作業ツリーのルートで git check-ignore --no-index に掛けて確かめる
# （.gitignore の否定パターンなどで除外されないなら失敗）。
#
# 出力: 成功は標準出力に OK の 1 行。失敗は標準エラーに FAILED: <理由> で、標準出力には何も出さない。
# 終了コード:
#   0  除外設定に載っていることを確かめた
#   1  git の作業ツリーの外・書き込みの失敗・確かめた結果が除外されない
#   2  使い方の誤り（引数がある）。何もしない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
LC_ALL=C
export LC_ALL

[ $# -eq 0 ] || {
  echo "使い方: worktree-exclude.sh（引数なし）" >&2
  exit 2
}

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

# パターンと、それに当たる見本の名前（同じ順）。ホストの writtenFileOf・statePatchSteps・sweep の名前の形と合わせる
patterns=('.implement-issue-tree-*.md' '/_/issue-trees/*.json.patch-*.json' '/_/issue-trees/*.json.sweep-*.json')
samples=('.implement-issue-tree-0.md' '_/issue-trees/1.json.patch-0.json' '_/issue-trees/1.json.sweep-0.json')

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "git の作業ツリーの外で実行された"
top=$(git rev-parse --show-toplevel) || fail "作業ツリーのルートを求められない"
[ -n "${top}" ] || fail "作業ツリーのルートが空"
path=$(git rev-parse --git-path info/exclude) || fail "info/exclude の場所を求められない"
[ -n "${path}" ] || fail "info/exclude の場所が空"
mkdir -p -- "$(dirname -- "${path}")" || fail "info/ を作れない（${path}）"

missing=()
for p in "${patterns[@]}"; do
  if [ ! -f "${path}" ] || ! grep -qxF -- "${p}" "${path}"; then
    missing+=("${p}")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  {
    # 末尾に改行の無い既存の行と、足す行がつながらないようにする
    if [ -s "${path}" ] && [ -n "$(tail -c 1 -- "${path}")" ]; then
      echo
    fi
    echo '# implement-issue-tree: Write ツールで書く一時ファイル（同梱スクリプトが読んで消す。コミットに含めない）'
    for p in "${missing[@]}"; do
      printf '%s\n' "${p}"
    done
  } >>"${path}" || fail "info/exclude に書けない（${path}）"
fi

for s in "${samples[@]}"; do
  git -C "${top}" check-ignore -q --no-index -- "${s}" || fail "書いたあとも ${s} が除外されない（.gitignore の否定パターンなど）"
done
echo OK
