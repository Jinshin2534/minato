// lsof の出力を読む。純粋関数だけ。
//
// 人間向けの表形式は OS や版で列幅・コマンド名の切り詰め(既定9文字)・"\x20" のエスケープが変わるので、
// 主に機械向けの -F 形式(1行1フィールド、先頭1文字が種別)を読む。表形式は -F が使えないときの保険。

// "127.0.0.1:5173" / "*:5850" / "[::1]:5173" / "localhost:http-alt" / "*:5173 (LISTEN)" → { host, port }
export function parseAddress(name) {
  if (typeof name !== 'string') return null
  const s = name.replace(/\s*\(.*\)\s*$/, '').trim()
  if (s.includes('->')) return null // 接続中のソケット(相手先つき)は待ち受けではない
  const m = s.match(/^(\[[^\]]*\]|[^\s]*?):(\d+)$/)
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1].replace(/^\[|\]$/g, '') || '*', port }
}

// `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` の出力 → [{ pid, command, host, port }]
export function parseLsofF(text) {
  const out = []
  let pid = null
  let command = null
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      pid = Number(val)
      command = null
    } else if (tag === 'c') {
      command = val
    } else if (tag === 'n' && pid != null) {
      const addr = parseAddress(val)
      if (addr) out.push({ pid, command, ...addr })
    }
    // f(fd) / t(type) / T(TCP状態) などは使わない
  }
  return dedupeListeners(out)
}

// 表形式(`lsof -nP -iTCP -sTCP:LISTEN`)の保険用パーサ。
// COMMAND に空白が入る版があるので、列を左から数えずに「PID は最初の数字列」「NAME は (LISTEN) の手前」で取る。
export function parseLsofTable(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || /^COMMAND\s/.test(line)) continue
    const m = line.match(/^(.+?)\s+(\d+)\s+\S+\s+.*?\s(\S+:\S+)(?:\s+\(LISTEN\))?\s*$/)
    if (!m) continue
    const addr = parseAddress(m[3])
    if (!addr) continue
    out.push({ pid: Number(m[2]), command: unescapeCommand(m[1]), ...addr })
  }
  return dedupeListeners(out)
}

// lsof は空白などを "\x20" と書く
export function unescapeCommand(s) {
  return String(s).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

// 同じプロセスが IPv4 と IPv6 で同じポートを開くと2行になる。1つにまとめ、ホストは並べて残す。
export function dedupeListeners(list) {
  const map = new Map()
  for (const l of list) {
    const key = `${l.pid}:${l.port}`
    const cur = map.get(key)
    if (cur) {
      if (!cur.hosts.includes(l.host)) cur.hosts.push(l.host)
    } else {
      map.set(key, { pid: l.pid, command: l.command, port: l.port, hosts: [l.host] })
    }
  }
  return [...map.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
}

// `lsof -a -d cwd -p 1,2,3 -Fpn` の出力 → Map(pid → cwd)
export function parseCwdF(text) {
  const map = new Map()
  let pid = null
  let fd = null
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') { pid = Number(val); fd = null }
    else if (tag === 'f') fd = val
    else if (tag === 'n' && pid != null && (fd === 'cwd' || fd === null)) map.set(pid, val)
  }
  return map
}

// `ps -o pid=,command=` の出力 → Map(pid → コマンドライン全体)
export function parsePs(text) {
  const map = new Map()
  for (const raw of String(text).split('\n')) {
    const m = raw.match(/^\s*(\d+)\s+(.*?)\s*$/)
    if (m) map.set(Number(m[1]), m[2])
  }
  return map
}
