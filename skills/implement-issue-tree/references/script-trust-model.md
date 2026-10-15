# スクリプト実行の信頼モデル

本書は implement-issue-tree スキルの一部。全体は ../SKILL.md 参照。

決定的な手順（`gh` / `git` / `du` 等のコマンド列と分類規則）をプロンプトの文章から切り出し、スキル同梱のスクリプトにして、サブエージェントには「コマンドを実行して出力を転記する」ことだけをさせる設計（Issue #603）の、**何を防ぎ、何を防がないか**を書く。第 1 弾の対象は読み取り専用の測定 2 本（残置 worktree のバイト測定・実ディスク空き容量）で、安全判定（マージ・push・削除）を含まない。安全判定を含むスクリプトを足す弾は、本書の前提を満たすか、満たさない部分を別の機構で補うことを、その弾の PR で示す。

## 構成

| 要素 | 役割 |
|------|------|
| `args.skillDir` | スキルディレクトリ（`scripts/` の 1 つ上）の絶対パス。人間（起動手順）が渡す。形式だけをホストが検証する |
| `scripts/run-verified.sh` | 実行前にスクリプトの SHA-256 を照合する launcher。`bash "<skillDir>/scripts/run-verified.sh" <sha256> <name>.sh …` で起動する（実行ビットに依存しない） |
| `scripts/measure-residual-bytes.sh` / `measure-free-disk.sh` | 測定本体。入力はパスの一覧（標準入力）または 1 件（引数）。出力は 1 行の封筒 |
| `scripts/lib/signed-output.sh` | 封筒の組み立て（`so_emit`）。sha256 の入力の定義はここと `verifySignedOutput` が共有する |
| 生成物 `implement-issue-tree.js` の `SCRIPT_SHA256` | ビルダーが埋め込む期待ハッシュ。開発ファイルには置換前の目印を書き、`build-workflow.mjs` が置換する |
| `verifySignedOutput`（ホスト） | 転記された封筒を再計算して照合する |

実行の流れ: ホストが nonce を決めてコマンドを組み立てる → サブエージェントが 1 回の Bash 呼び出しで実行する → launcher が期待ハッシュと照合して起動する → スクリプトが `{nonce, payload, sha256}` を 1 行で出す → エージェントがそれを StructuredOutput へ転記する → ホストが nonce と sha256 を再計算して照合し、通ったときだけ payload を使う。

封筒の `sha256` は `SHA-256(nonce + "\n" + payload の正規形)`。正規形はキー昇順・空白なしの JSON で、payload は整数と ASCII の固定文字列だけにする（`jq` の数値表記やエスケープの差に依存しないため、スクリプトは `printf` で直接組み立てる）。

payload には**入力の束縛** `inputSha256` を入れる。残置バイトは標準入力のパス列（末尾の改行 1 つを除く）、空き容量は対象パスの SHA-256 で、ホストは自分が送った値（`sha256Hex(パス列)`）から再計算して `verifySignedOutput` の第 3 引数で照合する。nonce は「どの呼び出しの出力か」を、`inputSha256` は「ホストが送った入力を測った出力か」を結び付ける。nonce は `boundaryNonce` に**呼び出し連番**を含めて作り、同じ対象を何度測っても呼び出し・再試行ごとに異なる（連番を含めないと同じパスの測定は同じ nonce になり、前回の封筒を流用しても受理される。PR #611 codex P1）。

## 何を防ぐか

| 事象 | 検出の仕組み |
|------|-------------|
| エージェントの**転記ミス**（数値の取り違え・桁落ち・項目の脱落） | ホストの sha256 再計算が一致しない → 破棄して有界に再測定（既存の「転記失敗は別エージェントで再測定」と同じ扱い） |
| **別の呼び出しの出力の流用**（前回の結果の使い回し） | nonce は呼び出しごとにホストが決める。流用した封筒は nonce が一致しない |
| **測定を実行せず値を推測で作った**（sha256 を合わせずに返した） | 値を作っても sha256 が一致しない（計算するには nonce と payload の正規形を使った SHA-256 が要る。うっかり省いた・推測で埋めた場合を検出する。意図して計算する者は下の「防がない」） |
| **送った入力と違うものを測った**（コマンド中のパスを 1 文字打ち間違えた・一部を省いた） | payload の `inputSha256` がホストの送った入力の SHA-256 と一致しない。件数が同じでも拒否される（`count` 照合だけでは過小な値が通った穴） |
| **Workflow とスクリプトの版ずれ**（同期が片方だけ届いた・古いコピーが残った） | launcher が期待ハッシュと不一致で起動しない（exit 3）。出力が無いので上と同じ測定失敗になる |
| スクリプトの**書き換え**（スキルディレクトリ内） | 同上。スクリプト本体と `scripts/lib/*.sh` のバイト列を対象にするので lib の書き換えも検出する |
| **入力のシェル再評価**（パスに `$(…)`・`;`・バッククォート） | スクリプトは `eval` を使わず、変数をすべてクォートし、許可文字集合（英数字・`/`・`-`・`_`・`.`・半角スペース）外のパスは `du` に渡さず `err` に数える |
| **実行場所の取り違え**（相対パスが worktree 内のコピーに解決される） | ホストが組み立てるコマンドの実行場所は `args.skillDir`（絶対パス）で決まり、相対パスの `skillDir` は受理しない。launcher は自分と同じディレクトリから名前だけでスクリプトを解決し、パス区切りと `..` を含む名前を拒否する。これは**ホストが正しいコマンドを渡す**ことと、**エージェントがそれをそのまま実行する**ことを前提にした設計上の取り決めであり、エージェントが別の場所の launcher を実行する行為そのものは止めない（下の「防がない」） |

## 何を防がないか

- **悪意のあるエージェント**は防げない。nonce と `inputSha256` の元になる入力はホストがプロンプトに書くので、エージェントは両方を知っている。`sha256sum` を自分で回せば、捏造した payload にも正しい sha256 と `inputSha256` を付けられる。nonce・sha256・`inputSha256` の照合は、**事故（転記ミス・使い回し・入力の打ち間違い・うっかりの未実行）の検出**であって、敵対的な改竄への認証ではない。
- **コマンドを組み直して別の launcher・別のスクリプトを実行すること**は止められない。ホストが検証するのは封筒の中身だけで、どのファイルを実行したかは見えない。エージェントが `bash` で別の場所の `run-verified.sh` や自作のスクリプトを起動し、同じ形式の封筒を出力して転記すれば、ホストはそれを区別できない（launcher のハッシュ照合は、正しい launcher を経由したときの版ずれ・書き換えを止めるだけである）。「スクリプトを実行せず自己流で進めた」ことの検出は、値を推測で作って sha256 を合わせなかった場合に限る。
- **StructuredOutput 経由の値は、転記の時点で自己申告になる。** スクリプトの出力そのものはホストから見えず、ホストが見るのはエージェントが返した封筒だけである。ホストは「この封筒は、この nonce に対してこの payload から計算できる sha256 を持つ」ことまでしか確かめられない。`args.repo` の先例（PR #443）と同じく、エージェントの自己申告値を**マージ・push・削除の判定には使わない**。
- **スキルディレクトリへ書き込める者**は防げない。launcher 自身は照合の対象外で、期待ハッシュを持つ生成物も同じスキルディレクトリ（またはその同期元）にある。信頼の根はスキルディレクトリであり、そこを書き換えられる者は launcher とハッシュを一緒に書き換えられる。これは `merge-guard-hook.sh` が同じディレクトリにあることと同じ前提で、本書の対象外。
- **照合から起動までの間の差し替え（TOCTOU）** は防がない。launcher はハッシュを計算してから `exec` するまでにファイルを読み直す。メイン作業ディレクトリは他のエージェントが書き込む前提の場所ではなく（実装系のエージェントは隔離 worktree で作業する）、この競合を悪用するにはスキルディレクトリへの書き込みが要るため、上の項目に含まれる。
- **`du` / `df` 自体が返す値の正しさ**は測れない（ファイルシステム上の実値を信じる）。`du` の実失敗は `err` に数え、0 に畳み込まずに測定失敗として扱う。
- **sha256sum / shasum が無い環境**では検証できない。launcher は exit 4 で起動せず、スクリプトも exit 3 で封筒を出さない。検証できないまま通すことはしない。

## 測定値の使い方（なぜこの弾の自己申告で足りるか）

残置バイト・空き容量の測定値は、**新規着手を止めるか（ディスク枯渇の防止）**、および**次回ラン開始時の 1 worktree あたり予約見積りの下限（クランプ済みの高水位）**にだけ使う。マージ可否・push・worktree の削除・PR/issue への書き込みの判定には使わない。偽の小さい値は着手を許す側に働き得るが、それが損なうのはローカルのディスク容量の保護で、リポジトリの内容・マージ・認証には影響しない。逆に偽の大きい値は着手を止める側（安全側）に働く。したがって、この弾の信頼水準は「事故を検出できる」で足りる。**悪意のあるエージェントがディスク枯渇防止の弁を迂回できる**ことは受け入れた制約である（件数軸の元になる `git worktree list` の転記も同じ自己申告である）。

安全判定を含むスクリプト（G0・マージ実行・opt-in ゲート・`verifyDiscardSafety`・base 取り込み）を切り出す弾では、この水準では足りない。出力の用途がマージ可否に及ぶ場合は、(a) ホスト側の独立な再取得、(b) サーバー側強制（ruleset の実測）、(c) 自己申告値を判定に使わない設計、のいずれかで補うこと。nonce と sha256 の照合は補強にならない。

## ハッシュ埋め込みと鮮度

- 開発ファイル（`implement-issue-tree.src.js`）には、スクリプトごとの期待ハッシュの代わりに置換前の目印（`SCRIPT_SHA256` の値）を書く。`build-workflow.mjs` は**コメント除去とトークン照合より前に**、同じディレクトリのスクリプトの `bundleSha256`（スクリプト本体 + `scripts/lib/*.sh` のバイト列連結の SHA-256）へ置換する。置換後の文字列を「開発ファイル」としてトークン照合に使うので、照合の定義（種類・値・開始行）は変わらない。生成物に目印が残らない。
- スクリプトまたは lib を書き換えると生成物の内容が変わる。`--check`（鮮度ゲート）と `tests/build-workflow.test.mjs` は、スクリプトだけが変わって生成物が再生成されていない状態を検出する。
- スクリプトが無い・目印の書式が不正（置換されずに残る）ならビルドは生成物を書かずに中止する。
- `launcher` と `bundleSha256` の定義の一致（sha256sum 経路・shasum 経路の両方）は `tests/script-launcher.test.mjs` が検証する。

## 運用

- `args.skillDir` は呼び出し側（起動手順）が渡す。配布後、既存の呼び出し手順は更新が必要になる。第 2 弾で状態ファイルの読み書きとツリー取得もスクリプトへ移したため、未指定は全ランで起動時エラーで停止する（`dryRun`・`maxResidualWorktreeBytes: 0` でも）。
- 同期で届くのはスキルディレクトリ全体（Workflow とスクリプトを同じコミットで）なので、通常は版ずれは起きない。`run-verified.sh` が exit 3 を出したときは、スキルの同期が途中か、スクリプトがローカルで変更されている。同期し直す。
- 新しいスクリプトを足すとき: `scripts/` 直下に `*.sh`（小文字・数字・`-`・`.`）で置き、`SCRIPT_SHA256` に目印を足し、`bash <skillDir>/scripts/run-verified.sh` 経由で起動する（ホストは `scriptCommand` で組み立てる）。測定値のように自己申告の転記を照合する手段が他に無い出力は封筒で返し、旧プロンプトの出力をホストが既に照合している手順（第 2 弾）は旧出力と同じ形式で返す。共通の関数は `scripts/lib/*.sh`（source 専用。全スクリプトのハッシュに入る）に置く。冒頭コメントに入力・出力・終了コードを書く。`bash 3.2`（macOS）と GNU の両方で動く書き方に限る（`paste`・`bc`・GNU 専用フラグ・`date -d`・`sed -i`・`mapfile`・連想配列を使わない）。

## 第 2 弾: 状態ファイル・GitHub の読み書き

エージェントがその場で組み立てるシェル（関数定義・`$(...)` の入れ子・`{}` と引用符を含む jq の式・`;` / `&&` / `|` の連結・HEREDOC）は、書き方が毎回変わり、Claude Code の権限確認（auto mode の分類器・展開による難読化の検査）がランのたびに出て、人が答えるまでランが止まった。そこで次の手順を同梱スクリプトへ移し、エージェントには `bash '<skillDir>/scripts/run-verified.sh' <sha256> <name>.sh <引数>` の 1 コマンドだけを実行させる。引数はホストが検証した整数・状態ファイルのパス・nonce・ハッシュだけで、`{}` と引用符を含めない。

| スクリプト | 置き換えた手順 | 出力 |
|------------|----------------|------|
| `state-verify.sh` | `state:load-verify` の 1 行のシェル | 旧コマンドとバイト単位で同じ（`KEYS` 行・高水位の行・`<キー> <sha256>` 行・`NOFILE`。行範囲の分割実行も同じ） |
| `state-read.sh` | `state:load` の読み込み・`state:load-fill` の jq | `summary`（`NOFILE` / `PARSE_ERROR` / `OK <件数> <高水位> <版>`）・`range`・`keys`（旧 jq と同じ値） |
| `state-write.sh` | 状態ファイルの全書き込み（初期作成・項目マージ・blocked の一括マージ・worktree のクリア・pending の一括初期化・高水位の更新 2 種） | 成功は `OK`、失敗は標準エラーの `FAILED: <理由>` と exit 1。jq の式・一時ファイル + `mv` の置き換え・`.updatedAt` の更新は旧手順と同じ |
| `fetch-tree.sh` | Tree フェーズのツリー取得と opt-in マーカー抽出 | `NODE` 行・`OPTIN` 行・`DONE <件数>`。件数が `total` と合わなければ取り直し、なお合わなければ `MISMATCH` と exit 1 |
| `probe-declared-deps.sh` / `probe-prereqs.sh` | 依存宣言・ツリー外前提の `for` ループ | 旧コマンドと同じ 1 行の JSON（`sig` 付き）と `FAILED #<番号>`。レート制限の判定もスクリプトが行い、確認できたときだけ `RATE_LIMIT` 行を出す |
| `fetch-root-ancestors.sh` | 祖先チェーンの GraphQL | 旧コマンドと同じ配列 |
| `detect-external-checks.sh` | 外部チェック観測のパイプライン（`xargs`・`sh -c`） | App slug を 1 行に 1 つ |

信頼の水準は旧プロンプトと同じで、変えていない: 出力は封筒にせず、エージェントが転記した値をホストが従来どおり照合する（状態ファイルは `keysSha256`・`keysCount`・項目ごとの `hashes`、依存とツリー外前提は `sig`、ツリーは `subIssuesTotal` との件数照合）。スクリプトにしたことで変わるのは「エージェントが毎回シェルを書き間違える・書き方が変わる」余地が無くなることと、launcher のハッシュ照合で版ずれ・書き換えを起動前に止められることである。悪意のあるエージェントが別のコマンドを実行することを止められない点は、第 1 弾と同じ（上の「何を防がないか」）。

`state-write.sh` は書き込みを伴うため、次を固定する。

- 書き込み先は引数の状態ファイルだけ。パスは英数字・`_`・`.`・`/`・`-` だけで、`.json` で終わり、`..` と `//` を含まないものに限る（不正は exit 2 で何も書かない）
- 未信頼の自由文を含む patch（`merge-item`・`merge-groups`）はコマンド行にも HEREDOC にも載せない。エージェントが Write ツールで `<状態ファイル>.patch-<nonce>.json` へ書き、スクリプトは nonce・束縛先・内容（末尾の改行を除く）から計算した照合値（下の束縛付きの定義）がホストの渡した値と一致するときだけ `jq --slurpfile` で読む。不一致・欠落は書かずに失敗する（写し間違いを状態ファイルへ書き込む前に止める。悪意のある書き換えへの認証ではない）。patch ファイルは成否に関わらず消す。消すのは `<状態ファイル>.patch-<nonce>.json` の形のファイルだけ
- 失敗時は状態ファイルを変えず、一時ファイルを残さない（旧手順は失敗時の一時ファイルを残し得た）
- patch の照合値は `SHA-256(nonce + 改行 + 束縛先 + 改行 + patch)`（束縛先は `merge-item` なら issue 番号、`merge-groups` なら `groups`。ホストの `statePatchSha256` と同じ定義）。別の呼び出し・別の issue 向けの patch を流用しても一致しない。照合と読み込みはスクリプトが自分の一時ファイルへ写したものに対して行う（照合のあとで元ファイルが差し替えられても、照合していない内容を読まない）
- 引数の形式の誤り（exit 2）でも、nonce の形式を確かめたあとなら patch ファイルを消す
- `create` は置き先を `ln`（既にあれば失敗する）で作り、同時に初期化しても既存のファイルを上書きしない

旧出力と違う点（互換性の注記）:

- `fetch-tree.sh` の `NODE` 行のタイトルは jq の `@tsv` でエスケープされる（タブ・改行・CR・`\` が `\t`・`\n`・`\r`・`\\` になる）。旧手順は agent が API の値をそのまま写していたため、これらの文字を含むタイトルは `nodes[].title` の文字列が旧と異なりうる。タイトルはログの表示と、agent への説明（非信頼データとして囲んで渡す）にだけ使い、ホストの照合・依存・実行順・ブランチ名には使わないため、判定は変わらない（タブ・改行を含むタイトルは agent への説明でエスケープ表記のまま見える）
- `probe-declared-deps.sh` のレート制限は旧手順の判定どおりで、`resetAt`・`waitSeconds` は core が枯渇したときだけ返す（それ以外は `-`。ホストが固定の短い待機をする）
- `state-write.sh` の `create` は置き先を `ln`（ハードリンク）で作るため、ハードリンク非対応のファイルシステム（exFAT・一部のネットワークマウントなど）に `_/issue-trees/` があると初期作成が失敗する（fail-closed。状態ファイルを作れずランは開始時に停止する。旧手順はリダイレクトで書いていたので失敗しなかった）

## 第 3 弾: CI 監視・マージ実行の読み取り（Issue #11 の範囲 A）

利用側では、PreToolUse の Bash の hook で次の 4 つの形を拒否することを想定している。hook は Workflow の agent とほかの agent を区別できないので、プロンプトがこの形のコマンドを agent に実行させると、利用側でランが止まる。

- (a) `cd <dir>` の後に `&&`・`;` で別のコマンドをつなぐ（`$(...)` の中も含む）
- (b) ファイルの中身を読む `sed -n`・`cat <file>`・`head <file>`・`tail <file>`（パイプの右側で標準入力を読む形・ヒアドキュメントは対象外）
- (c) `;`・`&&` で 3 本以上のコマンドをつなぐ（for / while / if の中のコマンド、変数の代入も 1 本と数える）
- (d) `gh` の `--jq`・`-q` の式に `{`・`[`・`|` を含む

毎回のランで当たっていた読み取りだけの手順を、第 2 弾と同じ形（`run-verified.sh` 経由の 1 コマンド。引数はホストが検証した整数・sha・App slug・URL エンコード済みのブランチ名と、agent が 40 桁の sha に置き換える `<HEAD sha>` などの目印だけ）へ移した。単独のコマンドで済むもの（PR 作成の `git rev-parse --verify`、Implement・recover-implement・fix の `git fetch` と `git checkout`）は、スクリプトにせず「1 回の Bash 呼び出しで 1 本ずつ」と書いた文面にした。

| スクリプト | 置き換えた手順 | 出力 |
|------------|----------------|------|
| `nonce-seed.sh` | 境界トークンの seed（`head -c 32 /dev/urandom \| od -An -tx1 \| tr -d ' \n'`） | 旧コマンドと同じ（小文字 16 進 64 桁・改行なし） |
| `checks-total.sh` | monitor 手順 2・push 後の CI 起動確認のチェック総数（`--jq '.total_count'` と `--jq '.statuses \| length'` の 2 本と、agent の暗算） | 合計の整数 1 個。どちらかの取得に失敗したら何も出さず非 0（0 件と区別する） |
| `compare-files.sh` | monitor 手順 1b の compare（`--jq '{status:...,files:[...]}'`） | 旧コマンドとバイト単位で同じ JSON |
| `external-check-runs.sh` | monitor 4a・4x、merge-exec 4b の外部チェック App の check-run（ページごとの `group_by` と agent の合算） | `<値> <件数>` の行（全ページを合算済み）。0 件は出力なし、取得失敗は非 0 |
| `required-context-missing.sh` | autoMerge のランの monitor 手順 3g（`REQ`・`CR`・`ST`・`HAVE` の代入と jq を `&&` で 5 本つないだ 1 行） | 不足件数の整数 1 個（旧コマンドと同じ値）。required context と HEAD 上の context の取得は `lib/gh-read.sh` にあり、G0 の (v) と共用できる |
| `unresolved-threads.sh` | monitor 手順 5・merge-exec 手順 4 の GraphQL の疑似ループ | 一覧は未解決スレッド 1 件につき 1 行の JSON と `TOTAL <件数>`、`--count` は件数だけ。クエリは旧プロンプトと同じで、`--count` はコメントを取得しない。途中のページの失敗は何も出さず非 0 |
| `checks-state-counts.sh` | merge-exec 手順 3 の `gh pr checks --json state --jq '[.[].state] \| group_by(.) ...'` | `<状態> <件数>` の行。終了コードは `gh pr checks` のものをそのまま返す（旧コマンドと同じ） |
| `review-state-counts.sh` | merge-exec 4b のレビュー状態の集計（`--jq "[.[] \| select(.user.login == ...)] \| group_by(.) ..."` と agent の合算） | `<state> <件数>` の行（全ページを合算済み）。レビュー本文は出さない |

信頼の水準は旧プロンプトと同じで、変えていない。merge-exec の手順 3・4・4b の出力はマージ可否の判定に使われるが、判定するのは旧手順と同じ merge-exec の agent で、読む値（状態 enum ごとの件数・未解決スレッドの件数）も同じである。スクリプトにしたことで変わるのは、ページの合算を agent の暗算でなくスクリプトが行うことと、取得の失敗を 0 件と区別して非 0 で返すことだけで、マージの実強制は従来どおり G0 で実測するサーバー側の強制（ruleset の required status checks・レビュースレッド解消の必須化・`--match-head-commit`）が持つ（上の「測定値の使い方」の (b)）。

出力の形式で旧手順と違う点（互換性の注記）:

- `external-check-runs.sh`・`review-state-counts.sh`・`checks-state-counts.sh` は、旧コマンドがページごとに出していた JSON の配列（`[{"v":..., "count":...}]`）ではなく、全ページを合算した `<値> <件数>` の行を出す。どの値も agent が読むだけで、ホストの照合・スキーマには渡らない
- `unresolved-threads.sh` の一覧は、旧手順の GraphQL の生の応答ではなく、未解決スレッドだけの行（`threadId`・`path`・`url`・`author`・`body`）を出す。`body` は `<untrusted-data source="review-comment">` で囲む（ホストの `untrusted()` と同じく、本文中の境界タグに似た文字列は `(untrusted-data)` に置き換える）。agent が返す `unresolvedComments` の形は変えていない

回帰防止は 2 つのテストで行う。`tests/ci-scripts.test.mjs` は、旧プロンプトのコマンドを固定文字列で持ち、偽の gh（fixture に本物の jq を適用する。複数ページも再現する）で同じ入力に対してスクリプトと旧コマンドを実行し、値が一致することを確かめる。`tests/agent-command-shapes.test.mjs` は、開発ファイルの目印 `cmd('...')` が組み立てたコマンドと、プロンプト全文から拾ったコマンドの断片・複数行の塊を `tests/lib/command-shape.mjs`（引用符・`$( )`・ヒアドキュメントを解釈する純 JS の検査器）で検査し、(a)〜(d) に当たるものが、理由付きの既知の例外（範囲 B〜D。マージの安全判定・書き込み・削除で、別の PR で直す）にしか無いことを確かめる。既知の例外は直した PR で消し、最後の PR で空にする（範囲 D は第 4 弾、範囲 B は第 5 弾、範囲 C は第 6 弾で消し、一覧は空になった）。

## 第 4 弾: worktree・ブランチの削除と終了時の処理（Issue #11 の範囲 D）

第 3 弾と同じ 4 つの形に当たっていた削除まわりの手順を、削除の安全判定ごと同梱スクリプトへ移した。判定の結果と順序は旧プロンプトの手順と変えていない。単独のコマンドで済むもの（Recover の WIP の退避、クローズ検証のコメントとクローズ）は、スクリプトにせず「1 回の Bash 呼び出しで 1 本ずつ」と書いた文面にした。

| スクリプト・コマンド | 置き換えた手順 | 出力 |
|------------|----------------|------|
| `worktree-cleanup.sh remove '<パス>'` | `state:cleanup` の worktree の削除（`git worktree list --porcelain` での登録の確認・`remove --force`・`unlock` して再試行・`$(cd "$p" && pwd -P)` で実パスを確かめてからの `rm -rf`・`git worktree prune`） | `REMOVED` / `ABSENT`（登録されていない・もう無い）で終了コード 0。`REFUSED`（メイン worktree かその配下）/ `FAILED` で 1 |
| `worktree-cleanup.sh delete-branch <ブランチ>` | Recover の破棄のブランチ削除（`git branch --list` と `b=...; git branch -D -- "$b"`） | `DELETED` / `ABSENT` で 0、`FAILED` で 1 |
| `worktree-cleanup.sh sweep <状態ファイル> <nonce> <sha256>` | ラン末尾のスイープ（`retain_file=$(mktemp)` と jq、`git worktree list --porcelain \| awk \| tail -n +2`、候補のヒアドキュメント、`while read` のループ、実パスの確認、`rm -rf`、`git worktree prune`） | 候補ごとに `REMOVED <パス>` か `SKIPPED <理由> <パス>`、保持対象ごとに `RETAINED <パス>`、最後に `DONE <件数>`。照合の失敗・状態ファイルを読めない・worktree の一覧を取れないときは何も消さず 1 |
| `discard-safety.sh <パス\|-> <ブランチ\|-> <ベース>` | `verifyDiscardSafety` の観測（`p=...`・`git -C "$p" status --porcelain`・`b=...`・`base=...`・`git rev-list --count`） | `WORKTREE_MISSING`・`DIRTY`・`AHEAD` の 3 行（値の決め方は旧手順と同じ） |
| `fetch-tree.sh <番号>`（第 2 弾のものを流用） | `closePrompt` の `gh api --paginate .../sub_issues` の再帰 | 第 2 弾と同じ。クローズ検証の agent は自分以外の `NODE` 行の state がすべて closed かを見る。終了コードが 0 以外・`DONE` 行が無いときは確認できないので閉じない |

信頼の水準と、削除を含むスクリプトを入れる条件（上の「測定値の使い方」）について:

- 削除の安全判定（登録済みの worktree か・メイン worktree とその配下でないか・状態ファイルの保持対象でないか）は、スクリプトが削除の直前に git と状態ファイルから自分で取り直して行い、agent が転記した値を使わない（「測定値の使い方」の (c)）。旧手順では agent が同じ判定をその場で組み立てたシェルで行っていたので、判定を agent の書き方に依存させない分だけ強くなる
- スクリプトに渡すのは、ホストが `sanitizeWorktreePath`・`isValidBranchName` で検証したパスとブランチ名だけで、スクリプトも同じ規則で検査し直す（不正は exit 2 で何も消さない）。パスは半角スペースを許すため単一引用符で包む（引用符・展開の文字は検証で除外済み）
- スイープの候補一覧は、agent が Write ツールで `<状態ファイル>.sweep-<nonce>.json` に書き、スクリプトが `SHA-256(nonce + 改行 + sweep + 改行 + 内容)`（ホストの `statePatchSha256(nonce, 'sweep', 一覧)`）を照合してから使う。写し間違い・別の呼び出しの一覧の流用は、何かを消す前に止まる。候補ファイルは成否・引数の誤りに関わらず消す
- 迷ったら消さない: `git rev-parse --show-toplevel` が失敗したら `rm -rf` しない、`git worktree list` を取れなければ何も消さない、`discard-safety.sh` は `git worktree list` が失敗したら `DIRTY true`（ホストは削除しない）
- agent が転記する値（`REMOVED` の行・`dirty`）の扱いは旧手順と同じ。`dirty` は Recover の `wipCommitted` の申告とあわせた 2 層の削除ゲートの片方で、旧手順でも agent の観測の転記だった。スクリプトにしたことで、観測のコマンドを agent が書き間違える余地が無くなる
- 独立した検証として、`tests/cleanup-scripts.test.mjs` が実際の git で一時リポジトリと worktree を作り、旧プロンプトのシェル（テスト内に固定文字列で持つ）とスクリプトを同じ構成のリポジトリに流して、残ったファイル・`git worktree list`・ブランチが一致することを確かめる。対象は通常・locked・`.git` が壊れて `rm -rf` へ進むもの・未登録・実体の無い登録・メイン worktree の配下・実パスがメイン worktree になるシンボリックリンク・未コミットの変更・半角スペースを含むパス・状態ファイルの保持対象（failed / blocked / monitoring）。ホストが組み立てたコマンド（引用・照合値）をそのままスクリプトが受け付けることも同じテストで流して確かめる

旧手順と違う点（どれも「消さない」側。消す場合の判定は変えていない）:

- `state:cleanup` で、対象がメイン worktree 自身だったとき・`rm -rf` の前の確認でメイン worktree かその配下と分かったとき・`rm -rf` が失敗したときは、終了コード 1 を返し、agent は `ok: false` を返す。旧手順は「警告を残して中断する」「警告を残して継続する（非致命）」と書くだけで、`ok` の値を決めていなかった。ホストは `ok: false` を「削除未完」として扱い、削除できたことの記録（バイト軸の実測し直しの対象）に入れない
- `state:cleanup` のメイン worktree のパスは、旧手順の `awk '{print $2; exit}'`（空白で切れる）ではなく、スイープと同じ `worktree ` の接頭辞の除去で読む。メイン worktree のパスに空白があっても実パスの比較が働く
- スイープの出力に `SKIPPED <理由> <パス>` の行を足した（agent が読むだけで、ホストには渡らない）

## 第 5 弾: マージ実行の G0 とマージのコマンド（Issue #11 の範囲 B）

merge-exec の手順 2b（G0 ゲート: ベースブランチのサーバー側強制の実測）は、`gh api ... | jq` の多段・`{}` と `|` を含む `--jq`・`HEAD_SHA` / `REQ` / `RSC` / `APP_ID_<SLUG>` の代入を「1 回の Bash 実行でまとめて」流させていた。手順 5 のマージも `HEAD_SHA="<sha>"; gh pr merge ... --match-head-commit "$HEAD_SHA"` だった。どちらも上の (c)・(d) に当たる。

| 置き換えた手順 | 新しい形 | 出力 |
|----------------|----------|------|
| 手順 2b (i)〜(v-b) | `g0-check.sh <URL エンコード済みのベースブランチ名> <HEAD sha> [<slug>:<エンコード済みの context>...]` | 判定ごとの `<判定名> <値>` の行（固定の 9 種。値は件数・`true` / `false`・取得や計算に失敗したら `error`）と、最後の `verdict <pass / classic-unsupported / server-enforcement-missing / issuer-unbound / checks-not-green>`。終了コードは pass のときだけ 0 |
| 手順 5 | `gh pr merge <N> --squash --delete-branch --match-head-commit <HEAD sha>`（手順 2 で固定した 40 桁の sha を値として直接書く単独のコマンド） | `gh pr merge` のまま |

- 判定の jq の式・判定の順序・辞退の reason は旧プロンプトと同じ。旧手順と同じく、不合格（取得の失敗を含む）になった判定でそれより後の判定を行わずに終わる。required context の式は `lib/gh-read.sh` の `gr_required_contexts_of_pages` を monitor 手順 3g の `required-context-missing.sh` と共用する
- (iv) の context は任意の文字列（空白・引用符・`{}` を含みうる）なので、ホストが英数字・`.`・`_`・`-` 以外の全バイトを `%XX`（大文字、UTF-8 のバイト単位）にして渡し（`g0ContextArg`）、スクリプトが元に戻して `jq --arg` に値で渡す。コマンド行に引用符と `{}` は載らない。制御文字（`%00`〜`%1F`・`%7F`）・小文字の 16 進・slug の形式違いは使い方の誤り（exit 2）
- 信頼の水準は旧プロンプトと同じで、変えていない。G0 を判定して辞退するかを決めるのは旧手順と同じ merge-exec の agent で、読む値（件数・真偽値）も同じ。スクリプトにしたことで変わるのは、jq の式・取得の失敗の扱い・判定の順序を agent が書き間違える余地が無くなることと、launcher のハッシュ照合で版ずれ・書き換えを起動前に止められることである。マージの実強制は従来どおり、G0 が実測するサーバー側の強制（ruleset の required status checks・レビュースレッド解消の必須化・`--match-head-commit`）が持つ（上の「測定値の使い方」の (b)）

旧手順と違う点（互換性の注記）:

- ルール（`rules/branches`）と HEAD sha 上の check-run は 1 回ずつだけ取得し、各判定で使い回す。旧手順は判定ごとに同じ API を取り直していた。取り直しの間に ruleset や check-run が変わった場合の値は旧手順と違いうるが、1 回の取得に揃えたほうが判定どうしの前提が食い違わない
- 取得の失敗の判定の割り当てを明記した。(i) の失敗は classic-unsupported（旧手順の「(i) が 0 件またはエラー」）、(v-b) の 2 つ目の値の計算の失敗は issuer-unbound（旧手順は「1 つ目が 1 以上・取得不能・RSC の取得失敗」を issuer-unbound としていて、2 つ目の取得不能の行き先を明記していなかった。合格にも一過性の checks-not-green にも倒さない側にした）
- verdict 行が無い・値が想定外・`run-verified.sh` の照合失敗は、merge-exec が server-enforcement-missing として辞退する

回帰防止は `tests/g0-check.test.mjs` で行う。旧プロンプトのコマンドを固定文字列で持ち、偽の gh（`tests/lib/fake-gh.sh`。ruleset と App ID の応答も返す）で同じ入力に対して旧コマンドを実行し、旧プロンプトの判定の手順どおりに読んだ行と verdict が、スクリプトの出力とバイト単位で一致することを、合格・各判定の不合格・各取得の失敗・引用符と非 ASCII を含む context の各場合で確かめる。`/bin/bash`（3.2）と Homebrew の bash の両方で走る。

## 第 6 弾: PR 本文・コメント・resolve の書き込み（Issue #11 の範囲 C）

PR 作成・fix・Low 指摘のコメント・opt-in 記録の確認の agent に書かせていた、PR 本文（未信頼の自由文）を扱うシェル（`f=$(mktemp)`・`grep || { echo; echo; echo; }`・`grep -avE ... ; rc=$?; ... && mv`・`pass=$(grep -cxF ...); rc=$?`・HEREDOC・`gh pr edit --body-file`）と、`{}` と引用符が同居する resolve の mutation を、同梱スクリプトへ移した。

| スクリプト | 置き換えた手順 | 出力 |
|------------|----------------|------|
| `pr-body-edit.sh ensure` | PR 作成の手順 1c（既存 PR の再利用時の本文の補正: Closes 行・対象外節・opt-in 記録節。PR の head・base をホストの知るブランチ名・ベース名と照合してから書く） | `OK`、失敗は標準エラーの `FAILED: <理由>` と exit 1 |
| `pr-body-edit.sh optin` | fix の手順 4b（opt-in 記録節の書き直し） | 同上 |
| `pr-body-edit.sh oos-append` | fix の手順 6（対象外の指摘の記録） | 同上 |
| `optin-record-count.sh` | マージ前の opt-in 記録の確認（本文の正規化と `grep -cxF` の 3 本） | `HEAD <sha>` と `COUNT <index> <pass> <nonPass>` の行（旧手順と同じ件数）。取得失敗は何も出さず exit 1 |
| `pr-comment.sh` | 最終 Review の Low 指摘のコメント（`--body "$(cat <<'LOWEOF' ...)"`） | `gh pr comment` の出力 |
| `resolve-thread.sh` | fix の手順 5（resolve の GraphQL mutation） | `gh api graphql` の出力と終了コード |
| `worktree-exclude.sh` | （新設。旧手順に無い）コミットを作る手順の `git add` の前に、Write ツールで書く一時ファイルのパターンを `info/exclude` に載せる | `OK`、失敗は標準エラーの `FAILED: <理由>` と exit 1 |

未信頼の自由文の扱い:

- コマンド行にも HEREDOC にも載せない。ホストが内容を知っている自由文（Low 指摘のコメント本文・PR 作成時の対象外節）は、`state-write.sh` の patch と同じ形にした。agent が Write ツールでカレントディレクトリの `.implement-issue-tree-<nonce>.md` に書き、スクリプトが自分の一時ファイルへ写してから `SHA-256(nonce + 改行 + 束縛先 + 改行 + 内容〔末尾の改行を除く〕)` をホストの渡した値と照合し、一致したときだけ使う（束縛先はコメントなら PR 番号、対象外節なら issue 番号）。ファイルは成否に関わらず消す。nonce は内容から導出し（`fileNonce`）、プロンプトでのデータ境界のトークンにも使う（内容に自分自身のハッシュを含めることはできないので、境界を偽装できない）
- fix が自分で書く対象外の行は、ホストが内容を知らないので照合値が無い。`oos-append` は代わりに行の形（`- [threadId: <threadId>] <本文>`・20 行以内・1 行 2000 バイト以内）と、threadId がホストの渡した未解決スレッドの一覧にあることを確かめる。GitHub の closing keyword の形（`close` / `fix` / `resolve` の活用形の後に、任意の空白・コロン・開き括弧〔`(`・`<`・`[`〕を挟んで `#N`・`owner/repo#N`・`GH-N`・Issue の URL。大文字小文字を問わない）を含む行は書き込まない（PR のマージ時に無関係な Issue を閉じさせられるため）。GitHub が閉じると確かめた形より広く、拒否する側に倒している。検査の `grep` の終了コードは 1（一致しない）のときだけ通し、2 以上（エラー）は検査できないとして失敗にする
- ホストは照合値と nonce を、スクリプトと同じく内容の末尾の改行を除いてから計算する（除かないと、末尾が改行になる内容〔指摘が空のコメントなど〕は必ず不一致になる）
- agent が Write したあとにスクリプトを起動できなかった経路（hook の拒否・中断）では、`.implement-issue-tree-<nonce>.md` が worktree のルートに残りうる。コミットを作る手順（Implement・recover-implement・fix と、PR 作成・fix の base 取り込みの解消）は、`git add` の前に `rm -f -- .implement-issue-tree-*.md` で消してからコミットする（`WRITTEN_FILE_COMMIT_GUARD`）。この消去は agent が手順に従うことと、カレントディレクトリが作業ツリーのルートであることに依存するため、同じ手順の前に `worktree-exclude.sh` が `.implement-issue-tree-*.md`・`*.patch-*.json`・`*.sweep-*.json` を `git rev-parse --git-path info/exclude` の示すファイルへ書き、サブディレクトリの `git add -A` でも stage されないようにする。git が読む `info/exclude` は linked worktree でも共有の `$GIT_COMMON_DIR/info/exclude` だけで（worktree ごとの `$GIT_DIR/info/exclude` は読まれない）、`--git-path` はその共有のファイルを返すので、1 回書けばすべての worktree に効く。worktree はランタイムが作り、ホストはファイルシステムに触れないため、コミットを作る agent が起動する。失敗してもコミットは止めない（消去の手順が残る）
- PR 作成の手順 1c の `<番号>` は agent が手順 1b の結果から置き換える値で、写し間違えると無関係な PR の本文に `Closes #<issue>` と対象外節を足しうる。ホストは作業ブランチ名とベースブランチ名を URL エンコードして `ensure` に渡し、スクリプトは本文を取得する前に `gh pr view <番号> --json headRefName,baseRefName` と照合する。一致しない・取得に失敗した・項目が無いときは `gh pr edit` を呼ばずに失敗する
- 既存の PR 本文はスクリプトの中だけで扱い、agent のコンテキストに入れない。opt-in テストのコマンドは空白を `%20` にして引数で渡す（ホストの許可文字集合に引用符・`$`・`%` は無い）

本文の全文を置き換える書き戻しは fail-closed にした: 取得の失敗・補正後が空・取得した本文にあった `Closes #` の行や対象外の見出しが補正後に無い、のいずれかなら `gh pr edit` を呼ばない。書き戻したあとは本文を取り直し、足したもの（Closes 行・対象外の見出しと各 threadId・記録節の各マーカー行）があることを確かめ、無ければ失敗を返す。

信頼の水準は旧プロンプトと同じで、変えていない。照合値は写し間違い・流用の検出であって、悪意のある agent への認証ではない（第 2 弾と同じ）。マージ前の opt-in 記録の判定は、旧手順と同じくホストの `classifyOptinRecordGate` と `combineOptinRecordGate`（ホストが保持する直近の fix の実測を重ねる）が行う。

旧手順と違う点（互換性の注記）:

- opt-in 記録節の書き直しで、除去後に空白以外の文字が残らない本文も失敗にした（旧手順は `[ -s "$g" ]` だけで、`gh` の出力の末尾の改行が残るため、記録節だけの本文を空行 1 つに置き換え得た）
- PR 作成の手順 1c の取得は `--jq '.body // ""'` にした（旧手順は `--jq .body` で、本文が null のとき `null` の文字列を本文として扱い得た）。null 以外では同じ
- PR 作成の手順 1c も、書き戻したあとに反映を確かめる（旧手順は fix の手順 4b・6 だけが確かめていた）
- 対象外節の追記は旧手順では agent に任せていた形を、`ensure` は空行 1 つと節、`oos-append` は節の末尾（次の見出しの手前）への行の追加に固定した
- `resolve-thread.sh` は threadId を `-f`（文字列）で渡す（旧手順の `-F` は数値・真偽値に見える値を型変換する）。mutation は同じ

回帰防止: `tests/write-scripts.test.mjs` が、旧プロンプトのコマンドを固定文字列で持ち、偽の gh（`pr edit` は `--body-file` の内容で本文を置き換え、`pr comment` は本文を記録する）で同じ入力に対して旧コマンドとスクリプトを実行し、書き戻した本文・投稿した本文・件数・mutation が一致することと、照合・fail-closed の分岐を確かめる。ホストのプロンプトから Write する内容とコマンドを取り出して流す確認も含む。PR の head・base の照合（不一致・取得失敗で `gh pr edit` を呼ばない）、closing keyword の広げた形と `grep` のエラーも同じファイルで確かめる。`tests/temp-file-exclude.test.mjs` は、実際の git リポジトリと linked worktree で `worktree-exclude.sh` を実行し、共有の `info/exclude` に全パターンが載ることと、サブディレクトリの `git add -A` が一時ファイルを stage しないことを確かめる。

## 関連

- `./automerge-design.md` — G0 とサーバー側強制（安全判定の信頼境界）
- `./verification.md` — 起動可否契約とサイズ予算
- `../../../.claude/rules/security.md` — OWASP A03（インジェクション）・A08（整合性）の観点
