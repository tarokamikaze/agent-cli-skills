// Workflow の agent に実行させるコマンドの「形」の検査器（Issue #11）。npm の依存を持たない純 JS。
// ファイル名が `*.test.mjs` に一致しないため node --test の glob には拾われない（テストが import するライブラリ）。
//
// 利用側は PreToolUse の Bash の hook で次の 4 つの形を拒否することを想定している。hook は Workflow の agent とほかの agent を
// 区別できないので、プロンプトがこの形のコマンドを agent に実行させると、利用側でランが止まる:
//   (a) cd <dir> の後に && ・ ; で別のコマンドをつなぐ（$(...) の中も含む）
//   (b) ファイルの中身を読む sed -n・cat <file>・head <file>・tail <file>（パイプの右側で標準入力を読む形・ヒアドキュメントは対象外）
//   (c) ; ・ && で 3 本以上のコマンドをつなぐ（for / while / if で書いた複数のコマンド、変数の代入も 1 本と数える）
//   (d) gh の --jq・-q の式に { [ | を含む
//
// 構文の読み方（シェルの完全な実装ではなく、上の 4 つを判定するのに要る範囲）:
//   - 単一引用符・二重引用符・バックスラッシュを解釈して語に分ける。引用符の中の ; && | はコマンドの区切りにしない
//   - ; && || | & 改行 でコマンドを区切る。| でつないだものは 1 本のパイプラインとして数える（c の数え方）
//   - $( ) とバッククォートの中は、別のコマンド列として同じ判定をする（$(( )) の算術式は除く）
//   - ヒアドキュメント（<< / <<-）の本文はコマンドとして読まない
//   - <...> の目印（agent が値に置き換える部分。例: <HEAD sha>）は 1 語として扱う
//   - 閉じていない引用符・括弧は、入力の終わりで閉じたものとして扱う（プロンプトの文中から切り出した断片も読めるように）

const PLACEHOLDER_RE = /<(?![<\s'"(&=])[^<>\n'"]{1,80}>/g

// 文の先頭に来て、後ろの語がコマンドになる予約語
const LEADING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(', 'time'])

const HEAD_TAIL_VALUE_OPTIONS = new Set(['-n', '-c', '-b'])

function newSegment() {
  return { words: [], redirs: [], heredoc: false, subshell: false }
}

// 二重引用符の中を読む（i は開き " の次）。語の値を word に足し、$( ) とバッククォートの中のコマンド列を subLists に足す。
// 返り値は閉じ " の次の位置（閉じていなければ入力の終わり）
function readDouble(s, i, word, subLists) {
  while (i < s.length && s[i] !== '"') {
    const c = s[i]
    if (c === '\\') {
      word.value += s[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      const r = parseList(s, i + 2, ')')
      subLists.push(r.list, ...r.subLists)
      word.value += '$(...)'
      i = r.end
      continue
    }
    if (c === '`') {
      const r = parseList(s, i + 1, '`')
      subLists.push(r.list, ...r.subLists)
      word.value += '`...`'
      i = r.end
      continue
    }
    word.value += c
    i++
  }
  return Math.min(i + 1, s.length)
}

// 対応する閉じ括弧の位置（open は開き括弧の位置）。引用符の中は数えない
function matchingClose(s, open, openCh, closeCh) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      i = j < 0 ? s.length : j
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return s.length - 1
}

// ヒアドキュメントの本文を飛ばす（i は本文の 1 行目の先頭）。返り値は最後の区切り行の次の位置
function skipHeredocBodies(s, i, pending) {
  for (const h of pending) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i)
      const line = s.slice(i, nl < 0 ? s.length : nl)
      i = nl < 0 ? s.length : nl + 1
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
    }
  }
  return i
}

/**
 * コマンド列を読む。closer は $( ) の中なら ')'、バッククォートの中なら '`'、最上位なら null。
 * 返り値: { list: { segments, connectors }, subLists, end }。segments[k] と segments[k + 1] の間の区切りが connectors[k]。
 */
function parseList(s, i, closer) {
  const segments = []
  const connectors = []
  const subLists = []
  let cur = newSegment()
  let word = null
  let pendingRedir = null // 次の語がリダイレクト先になる演算子
  let pendingHeredocDelim = null // 次の語がヒアドキュメントの区切りになる（{ strip }）
  let heredocs = []
  const ensureWord = () => {
    if (!word) word = { value: '', raw: '', start: i }
  }
  const flushWord = () => {
    if (!word) return
    if (pendingHeredocDelim) {
      heredocs.push({ delim: word.value, strip: pendingHeredocDelim.strip })
      pendingHeredocDelim = null
    } else if (pendingRedir) {
      cur.redirs.push({ op: pendingRedir, target: word.value })
      pendingRedir = null
    } else {
      cur.words.push(word)
    }
    word = null
  }
  const endSegment = (op) => {
    flushWord()
    segments.push(cur)
    connectors.push(op)
    cur = newSegment()
  }
  while (i < s.length) {
    const c = s[i]
    if (closer && c === closer) {
      i++
      break
    }
    if (c === '\n') {
      endSegment('\n')
      i++
      if (heredocs.length) {
        i = skipHeredocBodies(s, i, heredocs)
        heredocs = []
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flushWord()
      i++
      continue
    }
    if (c === '#' && !word) {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2
        continue
      }
      ensureWord()
      word.value += s[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'") {
      ensureWord()
      const j = s.indexOf("'", i + 1)
      const end = j < 0 ? s.length : j
      word.value += s.slice(i + 1, end)
      word.quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      ensureWord()
      word.quoted = true
      i = readDouble(s, i + 1, word, subLists)
      continue
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      // 算術式 $(( ))。コマンドは含まない
      ensureWord()
      const end = matchingClose(s, i + 1, '(', ')')
      word.value += s.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (c === '$' && s[i + 1] === '(') {
      ensureWord()
      const r = parseList(s, i + 2, ')')
      subLists.push(r.list, ...r.subLists)
      word.value += '$(...)'
      i = r.end
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      ensureWord()
      const end = matchingClose(s, i + 1, '{', '}')
      word.value += s.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (c === '`') {
      ensureWord()
      const r = parseList(s, i + 1, '`')
      subLists.push(r.list, ...r.subLists)
      word.value += '`...`'
      i = r.end
      continue
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      // プロセス置換 <( ) >( )。中のコマンド列を別に判定する
      ensureWord()
      const r = parseList(s, i + 2, ')')
      subLists.push(r.list, ...r.subLists)
      word.value += `${c}(...)`
      i = r.end
      continue
    }
    if (c === '(' && !word) {
      // サブシェル ( ... )。中のコマンド列を別に判定し、外側では 1 本のコマンドとして数える
      const r = parseList(s, i + 1, ')')
      subLists.push(r.list, ...r.subLists)
      cur.subshell = true
      i = r.end
      continue
    }
    if (c === '&' && s[i + 1] === '&') {
      endSegment('&&')
      i += 2
      continue
    }
    if (c === '|' && s[i + 1] === '|') {
      endSegment('||')
      i += 2
      continue
    }
    if (c === ';' && s[i + 1] === ';') {
      endSegment(';;')
      i += 2
      continue
    }
    if (c === ';') {
      endSegment(';')
      i++
      continue
    }
    if (c === '|') {
      // |& は標準エラーも渡すパイプ。区切りとしては | と同じ
      endSegment('|')
      i += s[i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '&' && s[i + 1] !== '>') {
      endSegment('&')
      i++
      continue
    }
    // リダイレクト: [n]< [n]> >> <<< << <<- >& <& &> >| <>
    const redir = c === '<' || c === '>' || c === '&' ? /^(<<<|<<-|<<|>>|>&|<&|>\||<>|&>>|&>|<|>)/.exec(s.slice(i, i + 3)) : null
    if (redir) {
      // 直前の語が数字だけ（2>&1 の 2）なら、それは fd なので語にしない
      if (word && /^[0-9]+$/.test(word.value) && !word.quoted) word = null
      flushWord()
      const op = redir[1]
      i += redir[0].length
      if (op === '<<' || op === '<<-') {
        pendingHeredocDelim = { strip: op === '<<-' }
        cur.heredoc = true
      } else if ((op === '>&' || op === '<&') && /^[0-9-]/.test(s[i] ?? '')) {
        // 2>&1 のような fd の複製。読み飛ばす
        while (i < s.length && /[0-9-]/.test(s[i])) i++
      } else {
        pendingRedir = op
      }
      continue
    }
    ensureWord()
    word.value += c
    i++
  }
  flushWord()
  segments.push(cur)
  return { list: { segments, connectors }, subLists, end: i }
}

/** 1 本のコマンド文字列を読み、最上位と、$( )・バッククォート・サブシェルの中のコマンド列をすべて返す */
export function parseCommandLists(command) {
  const s = String(command).replace(PLACEHOLDER_RE, 'PLACEHOLDER')
  const r = parseList(s, 0, null)
  return [r.list, ...r.subLists]
}

// 変数の代入（NAME=値）。名前の部分が引用符で始まる語（"A=b"）は代入ではないが、プロンプトに現れないので区別しない
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)

function segmentInfo(seg) {
  const words = seg.words
  let k = 0
  while (k < words.length && LEADING_KEYWORDS.has(words[k].value)) k++
  while (k < words.length && isAssignment(words[k])) k++
  const program = words[k] ? words[k].value.replace(/^.*\//, '') : null
  return {
    program,
    args: words.slice(k + 1).map((w) => w.value),
    empty: words.length === 0 && seg.redirs.length === 0 && !seg.heredoc && !seg.subshell,
    text: words.map((w) => w.value).join(' '),
  }
}

// head / tail のファイルの引数（オプションとその値を除いたもの）
function headTailOperands(args) {
  const out = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') {
      out.push(...args.slice(k + 1))
      break
    }
    if (HEAD_TAIL_VALUE_OPTIONS.has(a)) {
      k++
      continue
    }
    if (a.startsWith('-') && a !== '-') continue
    if (a === '-') continue
    out.push(a)
  }
  return out
}

function catOperands(args) {
  const out = []
  let opts = true
  for (const a of args) {
    if (opts && a === '--') {
      opts = false
      continue
    }
    if (opts && a.startsWith('-') && a !== '-') continue
    if (a === '-') continue
    out.push(a)
  }
  return out
}

// sed: -n（--quiet / --silent）があり、ファイルの引数を持つか
function sedReadsFileQuietly(args) {
  let quiet = false
  let scriptGiven = false
  const operands = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--quiet' || a === '--silent') {
      quiet = true
      continue
    }
    if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
      scriptGiven = true
      k++
      continue
    }
    if (a.startsWith('--expression=') || a.startsWith('--file=')) {
      scriptGiven = true
      continue
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes('n')) quiet = true
      if (/[ef]$/.test(a)) {
        scriptGiven = true
        k++
      }
      continue
    }
    if (a.startsWith('-') && a !== '-') continue
    operands.push(a)
  }
  const files = scriptGiven ? operands : operands.slice(1)
  return quiet && files.filter((f) => f !== '-').length > 0
}

function ghJqExpressions(args) {
  const out = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--jq' || a === '-q') {
      if (k + 1 < args.length) out.push(args[k + 1])
      k++
    } else if (a.startsWith('--jq=')) {
      out.push(a.slice(5))
    } else if (/^-q./.test(a)) {
      out.push(a.slice(2))
    }
  }
  return out
}

const CHAINING = new Set([';', '&&', '\n'])

function checkList(list) {
  const found = []
  const infos = list.segments.map(segmentInfo)
  // (a) cd の後に && ; （と改行・||）で別のコマンドをつなぐ
  infos.forEach((info, k) => {
    if (info.program !== 'cd') return
    const op = list.connectors[k]
    if (!op || op === '|' || op === '&') return
    if (infos.slice(k + 1).some((x) => !x.empty)) found.push({ rule: 'a', text: info.text })
  })
  // (b) ファイルを読む cat / head / tail / sed -n
  infos.forEach((info, k) => {
    const seg = list.segments[k]
    const inputFile = seg.redirs.some((r) => r.op === '<' || r.op === '<>')
    let reads = false
    if (info.program === 'cat') reads = catOperands(info.args).length > 0 || inputFile
    else if (info.program === 'head' || info.program === 'tail') reads = headTailOperands(info.args).length > 0 || inputFile
    else if (info.program === 'sed') reads = sedReadsFileQuietly(info.args) || (inputFile && sedReadsFileQuietly([...info.args, 'stdin-file']))
    if (reads) found.push({ rule: 'b', text: info.text })
  })
  // (c) ; && で 3 本以上（| でつないだものは 1 本のパイプラインとして数える）
  let pipelines = 0
  let chained = false
  let open = false
  infos.forEach((info, k) => {
    if (!info.empty && !open) {
      pipelines++
      open = true
    }
    const op = list.connectors[k]
    if (op !== '|') open = false
    if (CHAINING.has(op) && infos.slice(k + 1).some((x) => !x.empty) && infos.slice(0, k + 1).some((x) => !x.empty)) chained = true
  })
  if (pipelines >= 3 && chained) found.push({ rule: 'c', text: infos.map((x) => x.text).filter(Boolean).join(' ; ') })
  // (d) gh の --jq / -q に { [ |
  for (const info of infos) {
    if (info.program !== 'gh') continue
    for (const expr of ghJqExpressions(info.args)) {
      if (/[{[|]/.test(expr)) found.push({ rule: 'd', text: info.text })
    }
  }
  return found
}

/**
 * 1 回の Bash 呼び出しで実行するコマンド文字列を検査し、当たった形の一覧を返す（当たらなければ空配列）。
 * 要素は { rule: 'a' | 'b' | 'c' | 'd', text }（text は当たったコマンドの語を空白でつないだもの。診断用）。
 */
export function checkCommand(command) {
  return parseCommandLists(command).flatMap(checkList)
}

// 静的な走査で拾うコマンドの先頭語（Issue #11 の受け入れ条件の一覧）
export const SCAN_PROGRAMS = ['git', 'gh', 'jq', 'grep', 'awk', 'sed', 'cat', 'head', 'tail', 'tr', 'rm', 'mv', 'cd', 'mktemp']
const SCAN_PROGRAM_RE = new RegExp(`(?:^|[\\s($|;&\`])(?:${SCAN_PROGRAMS.join('|')})(?=[\\s)\`;|&]|$)`)
const SCAN_START_TOKEN_RE = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=|(?:\\$\\(|\\(|\`)*(?:${SCAN_PROGRAMS.join('|')})(?:[)\`;]|$)|(?:for|while|if|until)$)`)

/**
 * プロンプトの文から、コマンドに見える断片を切り出す（静的な走査）。行ごとに、日本語などの非 ASCII 文字で区切った
 * ASCII の連なりのうち、上の先頭語を含むものを取り、最初の「先頭語・変数の代入・for / while / if」の語から連なりの
 * 終わりまでを 1 つの断片にする。<...> の目印（中に日本語を含んでよい）は先に 1 語へ置き換える。
 * 文中の英単語を拾うことがあるので、呼び出し側は理由付きの許可リストで扱う。
 */
export function extractCommandCandidates(text) {
  const out = []
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(PLACEHOLDER_RE, 'PLACEHOLDER')
    for (const run of line.split(/[^\x20-\x7e\t]+/)) {
      if (!SCAN_PROGRAM_RE.test(run)) continue
      const tokRe = /\S+/g
      let t
      let start = -1
      while ((t = tokRe.exec(run))) {
        if (SCAN_START_TOKEN_RE.test(t[0])) {
          start = t.index
          break
        }
      }
      if (start < 0) continue
      const snippet = run.slice(start).replace(/[\s,:]+$/, '')
      if (!SCAN_PROGRAM_RE.test(snippet)) continue
      out.push(snippet)
    }
  }
  return out
}

/**
 * プロンプトの中の複数行のコマンドの塊を切り出す（静的な走査の補助）。4 文字以上字下げした行のうち、ASCII だけの行と
 * # で始まる行（シェルのコメント）が続く範囲を 1 つの塊とし、コメント以外の行が 2 行以上あり、上の先頭語を含むものを返す
 * （行をまたいで 1 回の Bash 呼び出しで実行させる手順を、1 行ずつの走査では (c) として数えられないため）。
 * 塊が 1 回の呼び出しで実行されるかどうかは文脈によるので、呼び出し側は検出を理由付きの一覧で扱う。
 */
export function extractCommandBlocks(text) {
  const out = []
  let block = []
  const flush = () => {
    const commands = block.filter((l) => !l.trim().startsWith('#'))
    if (commands.length >= 2 && commands.some((l) => SCAN_PROGRAM_RE.test(l))) out.push(block.map((l) => l.trim()).join('\n'))
    block = []
  }
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(PLACEHOLDER_RE, 'PLACEHOLDER')
    const inBlock = /^ {4,}\S/.test(line) && (/^[\x20-\x7e\t]*$/.test(line) || line.trim().startsWith('#'))
    if (inBlock) block.push(line)
    else flush()
  }
  flush()
  return out
}
