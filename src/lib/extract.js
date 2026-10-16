// 設定ファイルの中身(文字列)からポートの宣言を拾う。ファイルは読まない。純粋関数だけ。
//
// 返す宣言の形:
//   { port, kind, line, strict, confidence, note }
//   kind:       'dev' | 'preview' | 'server' | 'env' | 'code'
//   confidence: 'declared'(設定に数字で書いてある) | 'fallback'(環境変数が無いときの既定値) | 'guess'(コードから推定)

export const VITE_DEFAULT_DEV = 5173
export const VITE_DEFAULT_PREVIEW = 4173

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535

// 文字列の中身は残したまま、// と /* */ のコメントだけを空白に置き換える(行番号は保つ)。
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length

// vite.config.* の server.port / preview.port を拾う。
// 中かっこの入れ子を数えて、port がどのキー(server / preview)の中にあるかを決める。
export function extractVite(text) {
  const src = stripComments(text)
  const found = []
  const stack = [] // 開いている { ごとに、その直前のキー名
  let quote = null
  const blocks = [] // { key, start, end } — strictPort を同じブロック内で探すため
  const open = []
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    // "port": のように引用符つきのキーは、文字列として読み飛ばす前に port として扱う
    const quotedPort = (c === '"' || c === "'") && src.startsWith(c + 'port' + c, i)
    if (!quotedPort && (c === '"' || c === "'" || c === '`')) { quote = c; continue }
    if (quotedPort) i++
    if (c === '{') {
      const before = src.slice(Math.max(0, i - 80), i)
      const m = before.match(/([A-Za-z_$][\w$]*)['"]?\s*:\s*$/)
      stack.push(m ? m[1] : null)
      open.push(i)
      continue
    }
    if (c === '}') {
      const key = stack.pop()
      const start = open.pop()
      if (key !== undefined) blocks.push({ key, start, end: i })
      continue
    }
    if ((quotedPort || c === 'p') && src.startsWith('port', i) && !/[\w$]/.test(src[i - 1] ?? '')) {
      const rest = src.slice(i + 4)
      const m = rest.match(/^['"]?\s*:\s*([^,}\n]*)/)
      if (!m) continue
      const expr = m[1]
      const nums = [...expr.matchAll(/\b(\d{2,5})\b/g)].map((x) => Number(x[1])).filter(isPort)
      if (!nums.length) continue
      const port = nums[nums.length - 1]
      const keys = stack.filter(Boolean)
      const kind = keys.includes('preview') ? 'preview' : keys.includes('server') ? 'dev' : null
      if (!kind) continue // hmr.port など、開発サーバー本体ではないポートは数えない
      if (keys.includes('hmr') || keys.includes('proxy')) continue
      const fromEnv = /env|process\.|import\.meta/.test(expr)
      found.push({
        port,
        kind,
        line: lineAt(src, i),
        index: i,
        depth: stack.length,
        strict: false,
        confidence: fromEnv ? 'fallback' : 'declared',
        note: fromEnv ? '環境変数が無いときの既定値' : undefined,
      })
    }
  }
  // strictPort: true が同じブロックにあるか
  for (const f of found) {
    const block = blocks
      .filter((b) => b.start < f.index && f.index < b.end)
      .sort((a, b) => b.start - a.start)[0]
    if (block && /strictPort\s*:\s*true/.test(src.slice(block.start, block.end))) f.strict = true
    delete f.index
    delete f.depth
    if (f.note === undefined) delete f.note
  }
  return found
}

// vite.config.* に server / preview のポート指定が無いか(= Vite の既定に任せているか)
export function viteHasPort(text, kind) {
  return extractVite(text).some((d) => d.kind === kind)
}

// package.json の scripts から --port / -p / PORT= を拾う。
export function extractPackageJson(text) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return { name: null, decls: [], usesVite: false, error: 'package.json を JSON として読めない' }
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {}
  const lines = text.split('\n')
  const decls = []
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== 'string') continue
    const ports = new Set()
    for (const m of cmd.matchAll(/(?:--port[=\s]+|(?:^|\s)-p\s+|\bPORT=)(\d{2,5})\b/g)) {
      const n = Number(m[1])
      if (isPort(n)) ports.add(n)
    }
    const lineIdx = lines.findIndex((l) => l.includes(JSON.stringify(name) + ':') || l.includes(`"${name}"`))
    for (const port of ports) {
      decls.push({
        port,
        kind: /preview/.test(name) ? 'preview' : 'dev',
        line: lineIdx >= 0 ? lineIdx + 1 : 1,
        strict: /--strictPort\b/.test(cmd),
        confidence: 'declared',
        script: name,
      })
    }
  }
  const usesVite = (kind) =>
    Object.entries(scripts).some(([name, cmd]) => {
      if (typeof cmd !== 'string' || !/(^|[\s;&|])vite(\s|$)/.test(cmd)) return false
      const isPreview = /(^|\s)vite\s+preview\b/.test(cmd)
      if (kind === 'preview') return isPreview
      return !isPreview && !/(^|\s)vite\s+build\b/.test(cmd)
    })
  return {
    name: typeof pkg?.name === 'string' ? pkg.name : null,
    decls,
    usesVite: { dev: usesVite('dev'), preview: usesVite('preview') },
  }
}

// .env 系: FOO_PORT=1234 / PORT=1234
export function extractEnv(text) {
  const decls = []
  text.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*(?:export\s+)?([A-Z0-9_]*PORT)\s*=\s*['"]?(\d{2,5})['"]?\s*(?:#.*)?$/)
    if (!m) return
    const port = Number(m[2])
    if (!isPort(port)) return
    decls.push({ port, kind: 'env', line: i + 1, strict: false, confidence: 'declared', note: m[1] })
  })
  return decls
}

// ソースコードから推定する: `process.env.X_PORT ?? 5460`、`.listen(3000)` など。
// 設定ファイルに書かれていないポートを拾うための網。確度は低いので 'guess' / 'fallback' で返す。
export function extractCode(text) {
  const src = stripComments(text)
  const decls = []
  const seen = new Set()
  const push = (port, index, confidence, note) => {
    if (!isPort(port) || port < 1024) return
    const line = lineAt(src, index)
    const key = `${port}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    decls.push({ port, kind: 'code', line, strict: false, confidence, note })
  }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$.]*PORT)\b[^\n;]{0,40}?(?:\?\?|\|\|)\s*['"]?(\d{2,5})\b/g)) {
    push(Number(m[2]), m.index, 'fallback', `${m[1].split('.').pop()} が無いときの既定値`)
  }
  for (const m of src.matchAll(/\.listen\(\s*(\d{2,5})\b/g)) {
    push(Number(m[1]), m.index, 'guess', '.listen() に直書き')
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(?:PORT|port|DEFAULT_PORT)\s*=\s*(\d{2,5})\b/g)) {
    push(Number(m[1]), m.index, 'guess', '定数')
  }
  return decls
}
