#!/usr/bin/env bash
# state-write.sh — 状態ファイル（_/issue-trees/<parent>.json）への書き込みを 1 コマンドで行うスクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash state-write.sh create          <状態ファイル> <parent> <baseBranch> <parallel> <高水位の版>
#   bash state-write.sh merge-item      <状態ファイル> <issue> <nonce> <patch の sha256>
#   bash state-write.sh merge-groups    <状態ファイル> <nonce> <groups の sha256>
#   bash state-write.sh clear-worktree  <状態ファイル> <issue>
#   bash state-write.sh init-pending    <状態ファイル> <issue>:<implement|verify-close>...
#   bash state-write.sh high-water-max  <状態ファイル> <バイト数> <版>
#   bash state-write.sh high-water-set  <状態ファイル> <バイト数> <版>
#
# 旧プロンプトはエージェントに mktemp・jq・mv を && / ; でつないだシェル（$(...) と、{} と引用符を含む jq の式が同居）を
# 書かせていた。Claude Code の権限確認がランのたびに出るため、書き込みの手順をこのスクリプトへ移した。jq の式・
# 一時ファイル + mv による原子的な置き換え・.updatedAt の更新は旧プロンプトの手順と同じ（lib/state-file.sh の
# sf_jq_write）。
#
# 未信頼データを含む patch（merge-item・merge-groups）はコマンド行に載せない。エージェントが Write ツールで
# <状態ファイル>.patch-<nonce>.json へ 1 行の JSON を書き、このスクリプトがそれを読む。ホストは自分が渡した JSON の
# SHA-256 を引数で渡し、ファイルの内容（末尾の改行を除く）がそれと一致するときだけ書き込む（転記の誤り・別の呼び出しの
# patch の流用を書き込む前に止める）。patch ファイルは成否に関わらず消す。
#
# サブコマンドの意味:
#   create          ファイルが無いときだけ親ディレクトリを作り、初期 JSON（items は空）を書く。既にあれば失敗
#   merge-item      .items["<issue>"] = ((.items["<issue>"] // {}) + patch)
#   merge-groups    patch は [{numbers: [...], patch: {...}}, ...]。各グループの patch を numbers の全番号へマージする
#   clear-worktree  .items["<issue>"].worktree を "" にする（項目が無ければ作る）
#   init-pending    .items に無い番号だけ {type, status: "pending", pr: 0, branch: "", worktree: "", fixCount: 0, note: ""} を足す
#   high-water-max  版が <版> でなければ無条件に、そうでなければ現在値より大きいときだけ高水位を <バイト数> にし、版を <版> にする
#   high-water-set  高水位を <バイト数>、版を <版> に無条件で書く
#   いずれも create 以外は .updatedAt を現在時刻（UTC）にする。
# 出力: 成功は標準出力に OK の 1 行。失敗は標準エラーに FAILED: <理由> の 1 行で、標準出力には何も出さない。
# 終了コード:
#   0  書き込んだ（OK を出した）
#   1  書き込めなかった（ファイルが無い・JSON として読めない・patch の不一致・jq / mv の失敗）。状態ファイルは変えない
#   2  使い方の誤り（未知のサブコマンド・引数の形式不正）。何も書かない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 2
# shellcheck source=lib/state-file.sh
. "${script_dir}/lib/state-file.sh" || exit 2

usage() {
  echo "使い方: state-write.sh {create|merge-item|merge-groups|clear-worktree|init-pending|high-water-max|high-water-set} 状態ファイル 引数..." >&2
  exit 2
}

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

done_ok() {
  echo OK
  exit 0
}

[ $# -ge 2 ] || usage
cmd=$1
f=$2
shift 2
sf_valid_state_path "${f}" || usage

# patch ファイル（<状態ファイル>.patch-<nonce>.json）の内容の SHA-256 を期待値と照合する。一致すれば patch_file に
# パスを入れて 0。不一致・欠落はファイルを消して FAILED で終了する。$1 = nonce、$2 = 期待する sha256。
# 一致したファイルは呼び出し側が jq --slurpfile で読んでから消す（旧プロンプトと同じく --slurpfile で読む。
# コマンド行の長さの上限に patch の大きさを依存させない）。
patch_file=''
verify_patch() {
  local p="${f}.patch-$1.json" actual
  [ -f "${p}" ] || fail "patch ファイルが無い（${p}）"
  # $(...) は末尾の改行をすべて除く（Write ツールが末尾に改行を足しても同じ内容として扱う）
  actual=$(printf '%s' "$(cat -- "${p}")" | so_sha256) || {
    rm -f -- "${p}"
    fail "patch の SHA-256 を計算できない"
  }
  if [ "${actual}" != "$2" ]; then
    rm -f -- "${p}"
    fail "patch の内容がホストの渡したものと一致しない（期待 $2・実測 ${actual}）"
  fi
  patch_file=${p}
}

valid_sha() {
  case "$1" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

case "${cmd}" in
  create)
    [ $# -eq 4 ] || usage
    parent=$1
    base=$2
    parallel=$3
    version=$4
    sf_valid_pos_int "${parent}" || usage
    sf_valid_pos_int "${parallel}" || usage
    sf_valid_nonneg_int "${version}" || usage
    case "${base}" in
      '' | -* | *..* | *[!A-Za-z0-9._/+@-]*) usage ;;
    esac
    [ -e "${f}" ] && fail "既にファイルがある（${f}）"
    mkdir -p -- "$(dirname -- "${f}")" || fail "ディレクトリを作れない"
    tmp=$(mktemp "${f}.XXXXXX") || fail "一時ファイルを作れない"
    if jq -n --argjson parent "${parent}" --arg base "${base}" --argjson parallel "${parallel}" --argjson v "${version}" \
      '{parent: $parent, baseBranch: $base, parallel: $parallel, updatedAt: "", perWorktreeByteReserveHighWater: 0, perWorktreeByteReserveHighWaterVersion: $v, items: {}}' \
      >"${tmp}" && mv -f "${tmp}" "${f}"; then
      done_ok
    fi
    rm -f "${tmp}"
    fail "初期 JSON を書けない"
    ;;
  merge-item)
    [ $# -eq 3 ] || usage
    sf_valid_pos_int "$1" || usage
    sf_valid_nonce "$2" || usage
    valid_sha "$3" || usage
    issue=$1
    verify_patch "$2" "$3"
    if sf_jq_write "${f}" --slurpfile patch "${patch_file}" --arg n "${issue}" --arg ts "$(sf_now)" \
      '.items[$n] = ((.items[$n] // {}) + $patch[0]) | .updatedAt = $ts'; then
      rm -f -- "${patch_file}"
      done_ok
    fi
    rm -f -- "${patch_file}"
    fail "jq / mv に失敗（${f}）"
    ;;
  merge-groups)
    [ $# -eq 2 ] || usage
    sf_valid_nonce "$1" || usage
    valid_sha "$2" || usage
    verify_patch "$1" "$2"
    if sf_jq_write "${f}" --slurpfile groups "${patch_file}" --arg ts "$(sf_now)" \
      'reduce $groups[0][] as $g (.; reduce $g.numbers[] as $n (.; .items[($n|tostring)] = ((.items[($n|tostring)] // {}) + $g.patch))) | .updatedAt = $ts'; then
      rm -f -- "${patch_file}"
      done_ok
    fi
    rm -f -- "${patch_file}"
    fail "jq / mv に失敗（${f}）"
    ;;
  clear-worktree)
    [ $# -eq 1 ] || usage
    sf_valid_pos_int "$1" || usage
    sf_jq_write "${f}" --arg n "$1" --arg ts "$(sf_now)" \
      '.items[$n] = ((.items[$n] // {}) + {"worktree": ""}) | .updatedAt = $ts' || fail "jq / mv に失敗（${f}）"
    done_ok
    ;;
  init-pending)
    # 0 件も受理する（.updatedAt だけを更新する。旧プロンプトで空の配列を渡したときと同じ）
    entries=''
    for e in "$@"; do
      n=${e%%:*}
      t=${e#*:}
      sf_valid_pos_int "${n}" || usage
      case "${t}" in
        implement | verify-close) ;;
        *) usage ;;
      esac
      entries="${entries}${entries:+,}{\"number\":${n},\"type\":\"${t}\"}"
    done
    sf_jq_write "${f}" --argjson entries "[${entries}]" --arg ts "$(sf_now)" \
      'reduce $entries[] as $e (.; if .items[($e.number|tostring)] == null then .items[($e.number|tostring)] = {"type":$e.type,"status":"pending","pr":0,"branch":"","worktree":"","fixCount":0,"note":""} else . end) | .updatedAt = $ts' \
      || fail "jq / mv に失敗（${f}）"
    done_ok
    ;;
  high-water-max)
    [ $# -eq 2 ] || usage
    sf_valid_pos_int "$1" || usage
    sf_valid_nonneg_int "$2" || usage
    sf_jq_write "${f}" --argjson hw "$1" --argjson v "$2" --arg ts "$(sf_now)" \
      'if ((.perWorktreeByteReserveHighWaterVersion // 0) != $v) or ((.perWorktreeByteReserveHighWater // 0) < $hw) then .perWorktreeByteReserveHighWater = $hw | .perWorktreeByteReserveHighWaterVersion = $v else . end | .updatedAt = $ts' \
      || fail "jq / mv に失敗（${f}）"
    done_ok
    ;;
  high-water-set)
    [ $# -eq 2 ] || usage
    sf_valid_nonneg_int "$1" || usage
    sf_valid_nonneg_int "$2" || usage
    sf_jq_write "${f}" --argjson hw "$1" --argjson v "$2" --arg ts "$(sf_now)" \
      '.perWorktreeByteReserveHighWater = $hw | .perWorktreeByteReserveHighWaterVersion = $v | .updatedAt = $ts' \
      || fail "jq / mv に失敗（${f}）"
    done_ok
    ;;
  *) usage ;;
esac
