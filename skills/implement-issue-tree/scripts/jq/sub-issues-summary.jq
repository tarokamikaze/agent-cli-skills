# sub_issues API の応答（gh api --paginate はページごとに配列を出す）から、子の番号・状態・その子の子の総数を 1 件ずつ出す。
# 使い方: gh api --paginate "repos/{owner}/{repo}/issues/<parent>/sub_issues?per_page=100" | jq -c -f <このファイル>
# total > 0 の子は、同じ呼び出しで配下を辿る（total が 0 のノードだけが leaf）。
.[] | {number, state, total: .sub_issues_summary.total}
