// 端末向けの整形。純粋関数だけ(色の有無や home は引数で受ける)。

// 全角は幅2で数える(表の桁をそろえるため)
export function strWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
        ? 2
        : 1
  }
  return w
}

export const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - strWidth(s)))

export function tildify(p, home) {
  if (!p) return ''
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

export function makePaint(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s))
  return { red: wrap('31'), yellow: wrap('33'), green: wrap('32'), cyan: wrap('36'), dim: wrap('2'), bold: wrap('1') }
}

export function table(rows, headers) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) => Math.max(...all.map((r) => strWidth(stripAnsi(r[i] ?? '')))))
  return all
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c ?? '' : padAnsi(c ?? '', widths[i]))).join('  ').trimEnd())
    .join('\n')
}

// 開発サーバーは手で 10000 未満を選ぶのがふつう。それ以上は OS に任せた番号(エフェメラル)とみなす。
export const HIGH_PORT = 10000
export const isHighPort = (port) => port >= HIGH_PORT

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
const padAnsi = (s, n) => String(s) + ' '.repeat(Math.max(0, n - strWidth(stripAnsi(s))))

const KIND = { dev: 'dev', preview: 'preview', env: '.env', code: 'コード' }
const kindLabel = (kinds) => kinds.map((k) => KIND[k] ?? k).join('+')
const CONF = { declared: '', fallback: '既定値', guess: '推定', implicit: '暗黙' }

// 台帳の行を「アプリ×ポート×種類」でまとめる(同じアプリの別ワークツリーは1行に)
export function groupRows(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = `${r.port}|${r.app}`
    if (!map.has(key)) map.set(key, { ...r, kinds: [r.kind], dirs: [r.dir], lives: r.live ? [r.live] : [] })
    else {
      const g = map.get(key)
      if (!g.kinds.includes(r.kind)) g.kinds.push(r.kind)
      if (!g.dirs.includes(r.dir)) g.dirs.push(r.dir)
      if (r.live && !g.lives.some((l) => l.pid === r.live.pid)) g.lives.push(r.live)
      g.strict ||= r.strict
    }
  }
  return [...map.values()]
}

export function describeLive(live, paint) {
  if (!live) return ''
  if (live.by === 'self') return paint.green(`● ${live.command ?? '?'} (pid ${live.pid})`)
  if (live.by === 'other-app') return paint.red(`● ${live.name} が使用中 (pid ${live.pid})`)
  return paint.yellow(`● ${live.command ?? '?'} が使用中 (pid ${live.pid})`)
}

export function formatLedger(rows, { home, paint, conflictPorts = new Set() }) {
  const groups = groupRows(rows.filter((r) => r.confidence !== 'implicit'))
  const body = groups.map((g) => {
    const loc = g.file ? `${tildify(g.dir, home)}/${g.file}${g.line ? ':' + g.line : ''}` : tildify(g.dir, home)
    const extra = g.dirs.length > 1 ? paint.dim(` +${g.dirs.length - 1} ワークツリー`) : ''
    const conf = CONF[g.confidence] ? paint.dim(`(${CONF[g.confidence]})`) : ''
    const port = conflictPorts.has(g.port) ? paint.red(`${g.port}!`) : String(g.port)
    const live = g.lives.map((l) => describeLive(l, paint)).join(' ')
    return [port, `${kindLabel(g.kinds)}${g.strict ? ' 固定' : ''}`, `${g.name} ${conf}`.trim(), loc + extra, live]
  })
  return table(body, ['PORT', '種類', 'アプリ', '書いてある場所', '稼働'].map((h) => paint.dim(h)))
}

export function formatConflicts(conflicts, { home, paint }) {
  if (!conflicts.length) return paint.green('✓ 衝突なし: 同じポートを宣言している別アプリはない')
  const lines = [paint.red(paint.bold(`⚠ 衝突 ${conflicts.length} 件`) + ' — 同じポートを別のアプリが宣言している')]
  for (const c of conflicts) {
    const tag = c.sure ? '' : paint.dim(' (推定を含む)')
    lines.push(`  ${paint.red(String(c.port))}${tag}`)
    for (const e of c.entries) {
      const r = e.rows[0]
      const loc = r.file ? `${tildify(r.dir, home)}/${r.file}${r.line ? ':' + r.line : ''}` : tildify(r.dir, home)
      const notes = []
      if (!e.strict && e.rows.some((x) => x.kind === 'dev' || x.kind === 'preview')) notes.push('strictPort なし→黙ってずれる')
      if (e.confidence !== 'declared') notes.push(CONF[e.confidence])
      if (e.worktrees.length > 1) notes.push(`${e.worktrees.length} ワークツリー`)
      lines.push(`    - ${pad(e.name, 18)} ${loc}${notes.length ? paint.dim('  ' + notes.join(' / ')) : ''}`)
    }
  }
  return lines.join('\n')
}

export function formatImplicit(groups, { paint }) {
  const lines = []
  for (const g of groups) {
    const names = [...new Set(g.apps.map((a) => a.name))]
    const kind = g.apps[0]?.kind === 'preview' ? 'vite preview' : 'vite'
    if (g.apps[0]?.kind === 'preview') {
      lines.push(paint.dim(`△ ${kind} のポート未指定 ${names.length} 件 → 既定 ${g.port}(--all で一覧)`))
    } else {
      lines.push(paint.yellow(`△ ポート未指定(Vite 既定 ${g.port})${names.length} 件: `) + names.join(', '))
      lines.push(paint.dim('    同時に起動すると、後から起動したほうが黙って次の番号へずれる'))
    }
  }
  return lines.join('\n')
}

export function formatImplicitAll(groups, { paint }) {
  return groups
    .map((g) => `△ 既定 ${g.port}(${g.apps[0]?.kind}): ` + [...new Set(g.apps.map((a) => a.name))].join(', '))
    .map((s) => paint.yellow(s))
    .join('\n')
}

export function formatUnlisted(unlisted, { home, paint, all = false }) {
  const shown = all ? unlisted : unlisted.filter((l) => !isHighPort(l.port))
  const hidden = unlisted.length - shown.length
  const lines = []
  if (shown.length) lines.push(paint.yellow(`● 台帳外で稼働中 ${shown.length} 件 — プロジェクトの中で動いているのに、設定ファイルにそのポートが書かれていない`))
  if (hidden) lines.push(paint.dim(`  (ほかに 10000 以上の番号での待ち受けが ${hidden} 件。補助プロセスが OS に任せて取った番号とみて警告しない。--all で表示)`))
  for (const l of shown) {
    lines.push(`    ${pad(l.port, 6)}${pad(l.name, 18)} ${l.command ?? '?'} (pid ${l.pid})  ${paint.dim(tildify(l.dir, home))}`)
  }
  return lines.join('\n')
}

export function formatForeign(foreign, { paint }) {
  if (!foreign.length) return ''
  return foreign
    .map((l) => `    ${pad(l.port, 6)}${pad(l.command ?? '?', 22)} pid ${l.pid}  ${paint.dim(l.hosts.join(' '))}`)
    .join('\n')
}

// minato who <port>
export function formatWho(port, { rows, listeners }, { home, paint }) {
  const lines = []
  const decl = rows.filter((r) => r.port === port)
  const live = listeners.filter((l) => l.port === port)
  if (!decl.length) lines.push(`${port}: 台帳には載っていない(どのプロジェクトの設定にも書かれていない)`)
  for (const g of groupRows(decl)) {
    const loc = g.file ? `${tildify(g.dir, home)}/${g.file}${g.line ? ':' + g.line : ''}` : tildify(g.dir, home) + paint.dim(' (ポート未指定・Vite 既定)')
    lines.push(`宣言: ${g.name} [${kindLabel(g.kinds)}${g.strict ? ' 固定' : ''}] ${loc}${g.dirs.length > 1 ? paint.dim(` +${g.dirs.length - 1} ワークツリー`) : ''}`)
  }
  if (live.length === 0) lines.push('稼働: なし(lsof で見える範囲では誰も待ち受けていない)')
  for (const l of live) {
    const who = l.name ? `${l.name} (${tildify(l.dir, home)})` : paint.dim('プロジェクト外')
    lines.push(`稼働: ${l.command ?? '?'} pid ${l.pid} — ${who}`)
    if (l.cmdline) lines.push(paint.dim(`      ${l.cmdline.length > 140 ? l.cmdline.slice(0, 140) + '…' : l.cmdline}`))
  }
  return lines.join('\n')
}
