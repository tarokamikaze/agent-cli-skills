#!/usr/bin/env bash
# issue-jq.sh — イシューの機械取得に使う jq フィルタの定義（source 専用）
#
# 呼び出し元: probe-declared-deps.sh / probe-prereqs.sh（利用側のリポジトリで観測した権限確認によるランの停止への対応）。旧版は同じフィルタを
#             implement-issue-tree.src.js の定数（DECLARED_DEPS_JQ・DECLARED_DEPS_SIG_JQ・OUT_OF_TREE_STATE_SIG_JQ）に持ち、
#             エージェントへ渡すコマンド行に埋め込んでいた。{} と引用符がコマンド行に同居して Claude Code の権限確認が
#             出るため、フィルタをこのファイルへ移した。値は旧定数と同じ文字列（tests/ が抽出結果と sig の一致を検証する）。
# 契約: 変数を定義するだけ。set -e / set -u / trap / exit は置かない。二重 source は無害。
# 互換: macOS（bash 3.2）と Linux（GNU）。
#
# このファイルは単体実行しない。run-verified.sh のハッシュ照合は scripts/lib/*.sh も対象に含む。

[[ -n "${ISSUE_JQ_LIB_LOADED:-}" ]] && return 0
ISSUE_JQ_LIB_LOADED=1

# 本文の依存宣言の機械抽出（整数配列へ正規化する）。抽出対象・除外対象の詳細は
# implement-issue-tree.src.js の「本文の依存宣言の機械抽出」節。単一引用符を含めない（\u0027 で表す）。
DECLARED_DEPS_JQ='def refs: [scan("#([0-9]+)") | .[0] | tonumber]; def run: "(#[0-9]+(?:(?:[ \t,、/]|and|および|及び)+#[0-9]+)*)"; def inline: gsub("(?i)(?:\\b(?:not|no longer|never)\\b|n\u0027t)(?:[ \t]+[A-Za-z]+)?[ \t]+(?:depends on|blocked by)[ \t]*:?[ \t]*" + run; "") | [scan("(?i)(?:depends on|blocked by)[ \t]*:?[ \t]*" + run) | .[0] | refs[]]; def neg: test("(?i)関連|参考|参照|任意|なし|不要|\\b(related|see also|optional|none|no longer|not|never|unnecessary)\\b|n\u0027t"); def fenceof: (capture("^[ ]{0,3}(?<f>\u0060{3,}|~{3,})") | .f) // null; def stripcode: . as $s | [match("\u0060+"; "g") | {o: .offset, l: .length}] as $r | def go($i): if $i >= ($r | length) then [] else (first(range($i + 1; $r | length) | select($r[.].l == $r[$i].l)) // null) as $j | if $j == null then go($i + 1) else [[$r[$i].o, $r[$j].o + $r[$j].l]] + go($j + 1) end end; go(0) as $c | reduce ($c | reverse[]) as $x ($s; .[:$x[0]] + ($s[$x[0]:$x[1]] | gsub("[^\n]"; "")) + .[$x[1]:]); def linehead: [scan("^[ \t]*(?:(?:[-*+]|[0-9]+[.)])[ \t]+)?(?:\\[[ xX]\\][ \t]+)?" + run) | .[0] | refs[]]; def extract($t): (if .in and ($t | neg | not) then .d += ($t | linehead) else . end) | .d += ($t | inline); def flush: if (.buf | length) == 0 then . else (.buf | join("\n") | stripcode | split("\n")) as $ls | reduce $ls[] as $t (.; extract($t)) | .buf = [] end; (.body // "") | split("\n") | (reduce .[] as $raw ({in: false, fence: null, buf: [], d: []}; ($raw | sub("\r$"; "")) as $l | ($l | fenceof) as $f | if .fence != null then (if $f != null and ($f[0:1] == .fence[0:1]) and (($f | length) >= (.fence | length)) and ($l | test("^[ ]{0,3}[\u0060~]+[ \t]*$")) then .fence = null else . end) elif $f != null then flush | .fence = $f elif ($l | test("^[ ]{0,3}>")) or ($l | test("^[ \t]*$")) then flush elif ($l | test("^[ ]{0,3}#{1,6}([ \t]|$)")) then flush | .in = ($l | stripcode | test("^[ ]{0,3}#{1,6}[ \t]*(依存|依存関係|前提|Depends on|Dependencies|Blocked by)[ \t]*:?[ \t]*$"; "i")) | .d += ($l | stripcode | inline) elif ($l | test("^[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]")) then flush | .buf = [$l] else .buf += [$l] end) | flush) | .d | map(select(. > 0)) | unique'

# 依存宣言の転記の検査値。ホストの declaredDepsChecksum と同じ式・同じ法。
DECLARED_DEPS_SIG_JQ='.sig = ((((.number * 7919) % 1000000007) + ([.deps | to_entries[] | (((.key + 1) * .value * 104729) % 1000000007)] | add // 0)) % 1000000007)'

# ツリー外の前提イシューの state の転記の検査値。ホストの outOfTreeStateChecksum と同じ式・同じ法。
OUT_OF_TREE_STATE_SIG_JQ='.sig = (((.number * 7919) + (({"OPEN": 1, "CLOSED": 2, "MERGED": 3}[.state] // 0) * 104729)) % 1000000007)'
