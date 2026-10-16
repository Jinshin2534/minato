// いま待ち受けているポートを lsof で調べる。測れないときは測れないと返す(空の一覧で「全部空き」とは言わない)。
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { parseLsofF, parseLsofTable, parseCwdF, parsePs } from '../lib/lsof.js'

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }) }
  } catch (e) {
    // lsof は「該当なし」でも終了コード 1 を返す。出力があればそれを使う。
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: `${cmd} が見つからない` }
    if (typeof e.stdout === 'string' && e.status === 1) return { ok: true, out: e.stdout }
    return { ok: false, error: String(e.stderr || e.message).trim().split('\n')[0] }
  }
}

export function readListeners() {
  // +c 0: コマンド名を切り詰めない(既定は9文字)
  let r = run('lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  let listeners
  if (r.ok) listeners = parseLsofF(r.out)
  else if (!r.missing) {
    // -F に対応しない版の保険
    r = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
    if (r.ok) listeners = parseLsofTable(r.out)
  }
  if (!listeners) return { available: false, reason: r.error || 'lsof を実行できない', listeners: [] }
  const pids = [...new Set(listeners.map((l) => l.pid))]
  if (pids.length) {
    const cwd = run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpfn'])
    const cwds = cwd.ok ? parseCwdF(cwd.out) : new Map()
    const ps = run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')])
    const cmds = ps.ok ? parsePs(ps.out) : new Map()
    for (const l of listeners) {
      l.cwd = cwds.get(l.pid) ?? null
      l.cmdline = cmds.get(l.pid) ?? null
    }
  }
  return {
    available: true,
    // lsof は他ユーザー(root など)のプロセスを見られないことがある。提案時は実際に bind して確かめる。
    caveat: process.getuid?.() === 0 ? null : '自分のユーザーのプロセスだけを見ている(root のものは見えないことがある)',
    listeners,
  }
}

// 実際に bind できるかで空きを確かめる。lsof に見えないプロセスがいても、ここで弾ける。
export function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', (e) => resolve({ port, host, free: false, code: e.code }))
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve({ port, host, free: true })))
  })
}

export async function probeFree(port) {
  const results = await Promise.all([probePort(port, '127.0.0.1'), probePort(port, '::')])
  // IPv6 が無い環境(EAFNOSUPPORT / EADDRNOTAVAIL)は IPv4 の結果だけで決める
  const relevant = results.filter((r) => r.free || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(r.code))
  return relevant.length > 0 && relevant.every((r) => r.free)
}
