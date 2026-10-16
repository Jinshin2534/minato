#!/usr/bin/env node
// 港 (minato) — localhost のポートを、どのプロジェクトのどの開発サーバーかで一覧し、衝突を警告して空きを提案する。
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { parseArgs } from '../src/lib/args.js'
import { buildLedger, findConflicts, implicitApps, attachLive, suggestPorts, nextAfterMax, DEFAULT_RANGE } from '../src/lib/ledger.js'
import {
  formatLedger, formatConflicts, formatImplicit, formatImplicitAll, formatUnlisted, formatForeign, formatWho, makePaint, tildify, pad, isHighPort,
} from '../src/lib/format.js'
import { scanProjects, defaultRoots, expandHome } from '../src/io/scan.js'
import { readListeners, probeFree } from '../src/io/live.js'

const HELP = `港 (minato) — localhost のポートを、どのプロジェクトのどの開発サーバーかで一覧する

つかいかた:
  minato                     台帳(設定に書かれたポート)+ 稼働状況 + 衝突 + 空き候補
  minato conflicts           衝突だけ(あれば終了コード 1。CI やフックに)
  minato suggest [-n 3]      空いているポートを提案(実際に bind して確かめる)
  minato suggest --next      いちばん大きい番号の次の区切りを1つ(量産の払い出し用)
  minato who <port>          そのポートを宣言しているアプリと、いま使っているプロセス
  minato <port>              who の短縮
  minato live [--all]        いま待ち受けているポート(プロジェクト外も --all で)

オプション:
  --roots a:b      走査するフォルダ(既定 ~/ranzo_project:~/orca/workspaces、環境変数 MINATO_ROOTS でも可)
  --range 5000-5999  提案の範囲      --step 10   提案の刻み     --near 5400  近い番号から
  --all            暗黙(Vite 既定)の内訳やプロジェクト外のプロセスも出す
  --json           機械向けの JSON      --no-live  lsof を呼ばない     --no-color
`

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`minato: ${e.message}`)
    return 2
  }
  if (args.command === 'help') { process.stdout.write(HELP); return 0 }
  if (args.command === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return 0
  }
  const home = os.homedir()
  const paint = makePaint(args.color && !args.json && process.stdout.isTTY && !process.env.NO_COLOR)
  const roots = (args.roots ?? defaultRoots()).map(expandHome)
  const projects = scanProjects(roots, { maxDepth: args.depth })
  if (!projects.length && args.command !== 'live' && args.command !== 'who') {
    // 何も読めていないのに「衝突なし」とは言わない
    console.error(`minato: 走査ルートに package.json のあるフォルダが見つからない: ${roots.map((r) => tildify(r, home)).join(', ')}`)
    console.error('        --roots か環境変数 MINATO_ROOTS で走査するフォルダを指定して')
    return 3
  }
  const ledger = buildLedger(projects)
  const live = args.live ? readListeners() : { available: false, reason: '--no-live', listeners: [] }
  const { rows, unlisted, foreign, listeners } = attachLive(ledger, live.listeners, projects)
  const conflicts = findConflicts(rows)
  const implicit = implicitApps(rows)
  const ctx = { home, paint }

  if (args.command === 'conflicts') {
    if (args.json) console.log(JSON.stringify({ conflicts }, null, 2))
    else console.log(formatConflicts(conflicts, ctx))
    return conflicts.length ? 1 : 0
  }

  if (args.command === 'who') {
    if (args.json) console.log(JSON.stringify({ port: args.port, declared: rows.filter((r) => r.port === args.port), listening: listeners.filter((l) => l.port === args.port) }, null, 2))
    else {
      console.log(formatWho(args.port, { rows, listeners }, ctx))
      if (!live.available) console.log(paint.yellow(`(稼働状況は測れていない: ${live.reason})`))
    }
    return 0
  }

  if (args.command === 'live') {
    if (!live.available) { console.error(`minato: 稼働状況を測れない — ${live.reason}`); return 3 }
    if (args.json) { console.log(JSON.stringify({ listeners: args.all ? listeners : listeners.filter((l) => l.app) }, null, 2)); return 0 }
    const mine = listeners.filter((l) => l.app && (args.all || !isHighPort(l.port)))
    const hidden = listeners.filter((l) => l.app).length - mine.length
    console.log(paint.bold(`プロジェクトの中で待ち受け中 ${mine.length} 件`) + (hidden ? paint.dim(`(10000 以上の ${hidden} 件は --all で)`) : ''))
    for (const l of mine) {
      const declared = rows.some((r) => r.port === l.port && r.app === l.app)
      console.log(`    ${pad(l.port, 6)}${pad(l.name, 18)} ${l.command} (pid ${l.pid})  ${paint.dim(tildify(l.dir, home))}${declared ? '' : paint.yellow('  台帳外')}`)
    }
    if (args.all) {
      console.log(paint.bold(`\nプロジェクト外 ${foreign.length} 件`))
      console.log(formatForeign(foreign, ctx))
    } else if (foreign.length) console.log(paint.dim(`ほかにプロジェクト外のプロセスが ${foreign.length} 件(--all で表示)`))
    if (live.caveat) console.log(paint.dim(`注: ${live.caveat}`))
    return 0
  }

  if (args.command === 'suggest') return suggest(args, rows, listeners, live, paint)

  // list
  if (args.json) {
    console.log(JSON.stringify({ roots, projects: projects.length, live: { available: live.available, reason: live.reason ?? null }, ledger: rows, conflicts, implicit, unlisted }, null, 2))
    return conflicts.length ? 1 : 0
  }
  const declaredPorts = new Set(rows.filter((r) => r.confidence !== 'implicit').map((r) => r.port))
  console.log(
    paint.bold('港 minato') +
      paint.dim(` — ${projects.length} プロジェクト / 台帳 ${declaredPorts.size} ポート / `) +
      (live.available ? paint.dim(`稼働中 ${listeners.filter((l) => l.app).length}(プロジェクト内)`) : paint.yellow(`稼働状況は測れていない: ${live.reason}`)),
  )
  console.log(paint.dim(`走査: ${roots.map((r) => tildify(r, home)).join(', ')}\n`))
  console.log(formatLedger(rows, { ...ctx, conflictPorts: new Set(conflicts.map((c) => c.port)) }))
  console.log('')
  console.log(formatConflicts(conflicts, ctx))
  const implicitText = args.all ? formatImplicitAll(implicit, ctx) : formatImplicit(implicit, ctx)
  if (implicitText) console.log('\n' + implicitText)
  const unlistedText = formatUnlisted(unlisted, { ...ctx, all: args.all })
  if (unlistedText) console.log('\n' + unlistedText)
  const free = suggestPorts(rows, listeners, { count: 3 })
  const next = nextAfterMax(rows, listeners, {})
  console.log(`\n空き候補: ${paint.green(free.join('  '))}   次の番号: ${paint.green(next ?? 'なし')}  ${paint.dim('(minato suggest で bind して確かめる)')}`)
  return conflicts.length ? 1 : 0
}

async function suggest(args, rows, listeners, live, paint) {
  const opts = { range: args.range ?? DEFAULT_RANGE, step: args.step ?? 10, near: args.near }
  // lsof に見えないプロセス(root のものなど)もあるので、候補は実際に bind して確かめる。多めに取ってふるう。
  const wanted = args.next ? 1 : args.count ?? 3
  let candidates = args.next ? [nextAfterMax(rows, listeners, opts)].filter(Boolean) : suggestPorts(rows, listeners, { ...opts, count: wanted + 10 })
  const checked = []
  for (const p of candidates) {
    if (checked.filter((c) => c.ok).length >= wanted) break
    const ok = args.probe ? await probeFree(p) : null
    checked.push({ port: p, ok: ok !== false, probed: ok !== null })
  }
  const result = checked.filter((c) => c.ok).slice(0, wanted)
  const busy = checked.filter((c) => !c.ok)
  if (args.json) {
    console.log(JSON.stringify({ suggestions: result.map((c) => c.port), rejectedByBind: busy.map((c) => c.port), liveAvailable: live.available }, null, 2))
    return result.length ? 0 : 1
  }
  if (!result.length) { console.error('minato: 範囲内に空きが見つからない(--range / --step を変えてみて)'); return 1 }
  for (const c of result) console.log(String(c.port))
  const notes = []
  notes.push(`範囲 ${opts.range.join('-')}・${opts.step} 刻み。台帳の番号、strictPort なしの宣言の +1〜+2、5000/7000(AirPlay)、5173/4173(Vite 既定)を避けた`)
  if (args.probe) notes.push(busy.length ? `bind できず除外: ${busy.map((c) => c.port).join(', ')}(lsof に見えないプロセスがいる)` : '127.0.0.1 と :: で実際に bind できることを確かめた')
  else notes.push('bind での確認はしていない(--no-probe)')
  if (!live.available) notes.push(`稼働状況は測れていない: ${live.reason}`)
  else if (live.caveat) notes.push(live.caveat)
  for (const n of notes) console.error(paint.dim(n))
  return 0
}

const code = await main()
process.exitCode = code
