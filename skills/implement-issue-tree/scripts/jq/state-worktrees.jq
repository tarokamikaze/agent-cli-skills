# 状態ファイル（_/issue-trees/<親イシュー番号>.json）から、イシューごとの worktree パスを出す。
# 使い方: jq -c -f <このファイル> _/issue-trees/<親イシュー番号>.json
.items | to_entries[] | {issue: .key, worktree: .value.worktree}
