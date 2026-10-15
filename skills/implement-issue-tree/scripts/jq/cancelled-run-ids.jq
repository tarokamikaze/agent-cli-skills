# actions/runs の応答（gh api --paginate はページごとにオブジェクトを出す）から、結論が cancelled の run の ID を 1 行ずつ出す。
# 使い方: gh api --paginate "repos/OWNER/REPO/actions/runs?head_sha=<sha>&per_page=100" | jq -r -f <このファイル>
.workflow_runs[] | select(.conclusion == "cancelled") | .id
