// ポートの台帳づくりと衝突検出。純粋関数だけ(ファイルもプロセスも触らない)。
import {
  extractVite,
  extractPackageJson,
  extractEnv,
  extractCode,
  VITE_DEFAULT_DEV,
  VITE_DEFAULT_PREVIEW,
} from './extract.js'

// ファイルの種類をパスから決める
export function fileType(relPath) {
  const base = relPath.split('/').pop()
  if (base === 'package.json') return 'package'
  if (/^vite\.config\.[cm]?[jt]s$/.test(base)) return 'vite'
  if (/^\.env(\..+)?$/.test(base) && !/\.example$|\.sample$|\.template$/.test(base)) return 'env'
  if (/\.[cm]?[jt]s$/.test(base)) return 'code'
  return null
}

// 1プロジェクト分のファイル群 → 宣言の一覧
// project: { dir, repo, files: [{ path(相対), text }] }
export function declarationsOf(project) {
  const decls = []
  let name = null
  let usesVite = { dev: false, preview: false }
  for (const f of project.files) {
    const type = fileType(f.path)
    const add = (list) => {
      for (const d of list) decls.push({ ...d, file: f.path })
    }
    if (type === 'package') {
      const r = extractPackageJson(f.text)
      if (f.path === 'package.json') {
        name = r.name
        usesVite = r.usesVite
      }
      add(r.decls)
    } else if (type === 'vite') {
      add(extractVite(f.text))
    } else if (type === 'env') {
      add(extractEnv(f.text))
    } else if (type === 'code') {
      add(extractCode(f.text))
    }
  }
  // Vite を使っているのにポートをどこにも書いていない → 既定値を「暗黙」として載せる
  for (const kind of ['dev', 'preview']) {
    if (!usesVite[kind]) continue
    if (decls.some((d) => d.kind === kind && d.confidence !== 'guess')) continue
    decls.push({
      port: kind === 'dev' ? VITE_DEFAULT_DEV : VITE_DEFAULT_PREVIEW,
      kind,
      line: null,
      strict: false,
      confidence: 'implicit',
      note: 'ポート未指定(Vite の既定値)',
      file: null,
    })
  }
  return { name, decls }
}

// 同じアプリの別ワークツリーは衝突とみなさない。
// 「同じ git リポジトリ」かつ「同じ package 名(なければフォルダ名)」なら同じアプリ。
// (app-ideas のように1つのリポジトリにブランチ別の別アプリが同居することがあるので、リポジトリだけでは決めない)
export function appIdOf(project, name) {
  const label = name || project.dir.split('/').filter(Boolean).pop()
  return `${project.repo || project.dir}#${label}`
}

const RANK = { declared: 0, fallback: 1, guess: 2, implicit: 3 }

// projects → 台帳の行 [{ port, kind, confidence, strict, note, app, name, dir, file, line }]
export function buildLedger(projects) {
  const rows = []
  for (const p of projects) {
    const { name, decls } = declarationsOf(p)
    const app = appIdOf(p, name)
    const label = name || p.dir.split('/').filter(Boolean).pop()
    // 同じプロジェクト内で同じポート・同じ種類を何か所にも書いていたら1行にまとめる(いちばん確かなものを残す)
    const byKey = new Map()
    for (const d of decls) {
      const key = `${d.port}:${d.kind === 'code' || d.kind === 'env' ? 'any' : d.kind}`
      const cur = byKey.get(key)
      if (!cur || RANK[d.confidence] < RANK[cur.confidence]) {
        byKey.set(key, { ...d, strict: d.strict || cur?.strict || false })
      } else if (d.strict) cur.strict = true
    }
    // dev / preview として宣言済みのポートを、コードや .env から重ねて拾っていたら落とす
    const named = new Set([...byKey.values()].filter((d) => d.kind === 'dev' || d.kind === 'preview').map((d) => d.port))
    for (const d of byKey.values()) {
      if ((d.kind === 'code' || d.kind === 'env') && named.has(d.port)) continue
      rows.push({
        port: d.port,
        kind: d.kind,
        confidence: d.confidence,
        strict: Boolean(d.strict),
        note: d.note ?? null,
        app,
        name: label,
        dir: p.dir,
        file: d.file,
        line: d.line,
      })
    }
  }
  return rows.sort((a, b) => a.port - b.port || a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
}

// 衝突: 同じポートを別アプリが宣言している。暗黙(Vite 既定)は別枠で数える。
export function findConflicts(rows) {
  const byPort = new Map()
  for (const r of rows) {
    if (r.confidence === 'implicit') continue
    if (!byPort.has(r.port)) byPort.set(r.port, [])
    byPort.get(r.port).push(r)
  }
  const conflicts = []
  for (const [port, list] of byPort) {
    const apps = new Map()
    for (const r of list) {
      if (!apps.has(r.app)) apps.set(r.app, [])
      apps.get(r.app).push(r)
    }
    if (apps.size < 2) continue
    const entries = [...apps.values()].map((rs) => ({
      app: rs[0].app,
      name: rs[0].name,
      rows: rs,
      worktrees: [...new Set(rs.map((r) => r.dir))],
      strict: rs.some((r) => r.strict),
      confidence: rs.reduce((best, r) => (RANK[r.confidence] < RANK[best] ? r.confidence : best), 'implicit'),
    }))
    // コードからの推定(guess)が絡む重なりは「たぶん」。設定や環境変数の既定値どうしなら確定。
    const sure = entries.filter((e) => e.confidence === 'declared' || e.confidence === 'fallback').length >= 2
    conflicts.push({ port, sure, entries })
  }
  return conflicts.sort((a, b) => a.port - b.port)
}

// ポート未指定で Vite 既定に任せているアプリ(同時に起動すると片方が黙って 5174 にずれる)
export function implicitApps(rows) {
  const map = new Map()
  for (const r of rows) {
    if (r.confidence !== 'implicit') continue
    const key = `${r.port}`
    if (!map.has(key)) map.set(key, new Map())
    map.get(key).set(r.app, r)
  }
  return [...map.entries()].map(([port, apps]) => ({ port: Number(port), apps: [...apps.values()] }))
}

// cwd またはコマンドラインに含まれるパスから、待ち受けプロセスがどのプロジェクトかを決める(いちばん深い一致)。
export function projectForProcess(proc, projects) {
  const candidates = [proc.cwd, ...(String(proc.cmdline || '').match(/\/[^\s'"]+/g) || [])].filter(Boolean)
  let best = null
  for (const p of projects) {
    const dir = p.dir.endsWith('/') ? p.dir : p.dir + '/'
    for (const c of candidates) {
      const path = c.endsWith('/') ? c : c + '/'
      if (path.startsWith(dir) && (!best || p.dir.length > best.dir.length)) best = p
    }
  }
  return best
}

// 待ち受け中のプロセスを台帳と突き合わせる。
// listeners: [{ pid, command, port, hosts, cwd?, cmdline? }]
// 返り値: { rows(台帳に live を付けたもの), unlisted(プロジェクト内で動いているが台帳にないポート), foreign(プロジェクト外) }
export function attachLive(rows, listeners, projects) {
  const appOfDir = new Map()
  for (const r of rows) appOfDir.set(r.dir, { app: r.app, name: r.name })
  const enriched = listeners.map((l) => {
    const p = projectForProcess(l, projects)
    if (!p) return { ...l, app: null, name: null, dir: null }
    const known = appOfDir.get(p.dir)
    const { name } = declarationsOf(p)
    return { ...l, app: known?.app ?? appIdOf(p, name), name: known?.name ?? (name || p.dir.split('/').pop()), dir: p.dir }
  })
  const byPort = new Map()
  for (const l of enriched) {
    if (!byPort.has(l.port)) byPort.set(l.port, [])
    byPort.get(l.port).push(l)
  }
  const outRows = rows.map((r) => {
    const live = byPort.get(r.port) || []
    if (!live.length) return { ...r, live: null }
    const mine = live.find((l) => l.dir === r.dir) || live.find((l) => l.app === r.app)
    const l = mine || live[0]
    return {
      ...r,
      live: {
        pid: l.pid,
        command: l.command,
        by: mine ? 'self' : l.app ? 'other-app' : 'outside',
        name: l.name,
        dir: l.dir,
      },
    }
  })
  const declaredByApp = new Set(rows.map((r) => `${r.app}:${r.port}`))
  const unlisted = enriched.filter((l) => l.app && !declaredByApp.has(`${l.app}:${l.port}`))
  const foreign = enriched.filter((l) => !l.app)
  return { rows: outRows, unlisted, foreign, listeners: enriched }
}

export const DEFAULT_RANGE = [5000, 5999]
// macOS の AirPlay 受信(ControlCenter)が 5000 と 7000 を握る。Vite の既定 5173 / 4173 も避ける。
export const ALWAYS_AVOID = [5000, 7000, VITE_DEFAULT_DEV, VITE_DEFAULT_PREVIEW]

// 空いているポートを提案する。台帳にも載っておらず、いま待ち受けもされていない番号。
// Vite は strictPort なしだと衝突時に +1, +2… へずれるので、宣言済みポートのすぐ上(+1〜+margin)も避ける。
export function suggestPorts(rows, listeners, opts = {}) {
  const [lo, hi] = opts.range || DEFAULT_RANGE
  const step = opts.step ?? 10
  const count = opts.count ?? 3
  const margin = opts.margin ?? 2
  const taken = new Set(ALWAYS_AVOID)
  for (const r of rows) {
    taken.add(r.port)
    if (!r.strict) for (let k = 1; k <= margin; k++) taken.add(r.port + k)
  }
  for (const l of listeners) taken.add(l.port)
  const start = Math.ceil(lo / step) * step
  const out = []
  const near = opts.near
  const candidates = []
  for (let p = start; p <= hi; p += step) candidates.push(p)
  if (near != null) candidates.sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b)
  for (const p of candidates) {
    if (out.length >= count) break
    if (!taken.has(p)) out.push(p)
  }
  return out
}

// いちばん大きい宣言済みポートの次の区切り(量産で「次の番号」を払い出す使い方)
export function nextAfterMax(rows, listeners, opts = {}) {
  const [lo, hi] = opts.range || DEFAULT_RANGE
  const step = opts.step ?? 10
  const inRange = rows.filter((r) => r.port >= lo && r.port <= hi && r.confidence !== 'implicit').map((r) => r.port)
  if (!inRange.length) return suggestPorts(rows, listeners, { ...opts, count: 1 })[0] ?? null
  const max = Math.max(...inRange)
  const from = Math.floor(max / step) * step + step
  return suggestPorts(rows, listeners, { ...opts, range: [from, hi], count: 1 })[0] ?? null
}
