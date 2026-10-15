# actions/runs/<run-id>/jobs の応答から、job 名を 1 行ずつ出す。
# 使い方: gh api --paginate "repos/OWNER/REPO/actions/runs/<run-id>/jobs?per_page=100" | jq -r -f <このファイル>
.jobs[].name
