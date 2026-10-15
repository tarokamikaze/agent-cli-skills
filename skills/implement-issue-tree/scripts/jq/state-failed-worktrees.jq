# 状態ファイル（_/issue-trees/<親イシュー番号>.json）から、status が failed のイシューの worktree パスを出す。
# 使い方: jq -c -f <このファイル> _/issue-trees/<親イシュー番号>.json
.items | to_entries[] | select(.value.status == "failed") | {issue: .key, worktree: .value.worktree}
