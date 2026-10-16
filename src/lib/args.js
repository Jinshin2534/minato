// コマンドライン引数の解釈。純粋関数。
const COMMANDS = ['list', 'conflicts', 'suggest', 'who', 'live', 'help', 'version']
const BOOL = new Set(['json', 'all', 'no-live', 'no-color', 'no-probe', 'help', 'version', 'next'])
const ALIAS = { h: 'help', v: 'version', n: 'count', a: 'all' }

export function parseArgs(argv) {
  const opts = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    let m = a.match(/^--([\w-]+)(?:=(.*))?$/) || a.match(/^-([a-zA-Z])$/)
    if (!m) { positional.push(a); continue }
    const key = ALIAS[m[1]] ?? m[1]
    if (BOOL.has(key)) { opts[key] = true; continue }
    const val = m[2] ?? argv[++i]
    if (val === undefined) throw new Error(`--${key} に値がない`)
    opts[key] = val
  }
  let command = positional[0] ?? 'list'
  if (opts.help) command = 'help'
  if (opts.version) command = 'version'
  if (/^\d+$/.test(command)) { positional.unshift('who'); command = 'who' } // `minato 5173` = who
  if (!COMMANDS.includes(command)) throw new Error(`知らないコマンド: ${command}(minato help を参照)`)

  const out = { command, json: !!opts.json, all: !!opts.all, live: !opts['no-live'], color: !opts['no-color'], probe: !opts['no-probe'], next: !!opts.next }
  if (opts.roots) out.roots = String(opts.roots).split(':').filter(Boolean)
  if (opts.range) {
    const r = String(opts.range).match(/^(\d+)\s*-\s*(\d+)$/)
    if (!r || Number(r[1]) > Number(r[2]) || Number(r[2]) > 65535) throw new Error(`--range は 5000-5999 の形で: ${opts.range}`)
    out.range = [Number(r[1]), Number(r[2])]
  }
  for (const k of ['count', 'step', 'near', 'depth']) {
    if (opts[k] === undefined) continue
    const n = Number(opts[k])
    if (!Number.isInteger(n) || n < (k === 'near' ? 1 : 1)) throw new Error(`--${k} は正の整数で: ${opts[k]}`)
    out[k] = n
  }
  if (command === 'who') {
    const p = Number(positional[1])
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('minato who <ポート番号>')
    out.port = p
  }
  return out
}
