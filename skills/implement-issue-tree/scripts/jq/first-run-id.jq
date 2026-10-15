# gh run list --json databaseId の出力（配列）から、先頭の run の ID を出す。
# 使い方: gh run list --branch main --workflow <workflow-file> --json databaseId,conclusion --limit 1 | jq -r -f <このファイル>
.[0].databaseId
