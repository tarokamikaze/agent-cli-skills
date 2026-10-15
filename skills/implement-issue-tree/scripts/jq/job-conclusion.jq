# actions/runs/<run-id>/jobs の応答から、名前が $job の job の結論を出す（job 名は --arg で値として渡す）。
# 使い方: gh api repos/OWNER/REPO/actions/runs/<run-id>/jobs | jq -r --arg job '<job 名>' -f <このファイル>
.jobs[] | select(.name == $job) | .conclusion
