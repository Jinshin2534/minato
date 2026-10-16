import { describe, it, expect } from 'vitest'
import {
  fileType, declarationsOf, appIdOf, buildLedger, findConflicts, implicitApps,
  projectForProcess, attachLive, suggestPorts, nextAfterMax,
} from '../src/lib/ledger.js'

const pkg = (name, scripts) => ({ path: 'package.json', text: JSON.stringify({ name, scripts }, null, 2) })
const vite = (body) => ({ path: 'vite.config.js', text: `export default {\n  ${body}\n}` })
const proj = (dir, files, repo = dir + '/.git') => ({ dir, repo, files })

const viteApp = (dir, name, port, extra = {}) =>
  proj(dir, [pkg(name, { dev: 'vite', preview: 'vite preview' }), vite(`server: { port: ${port}${extra.strict ? ', strictPort: true' : ''} },`)], extra.repo)

describe('fileType', () => {
  it.each([
    ['package.json', 'package'],
    ['vite.config.ts', 'vite'],
    ['vite.config.mjs', 'vite'],
    ['.env', 'env'],
    ['.env.local', 'env'],
    ['.env.example', null],
    ['server.js', 'code'],
    ['README.md', null],
  ])('%s → %s', (p, t) => expect(fileType(p)).toBe(t))
})

describe('declarationsOf', () => {
  it('ポートを書いていない Vite アプリは既定値を「暗黙」として載せる', () => {
    const { decls } = declarationsOf(proj('/r/a', [pkg('a', { dev: 'vite', preview: 'vite preview' })]))
    expect(decls.map((d) => [d.port, d.kind, d.confidence])).toEqual([[5173, 'dev', 'implicit'], [4173, 'preview', 'implicit']])
  })
  it('dev を書いていれば dev の暗黙は載せない', () => {
    const { decls } = declarationsOf(viteApp('/r/a', 'a', 5300))
    expect(decls.filter((d) => d.confidence === 'implicit').map((d) => d.kind)).toEqual(['preview'])
  })
  it('vite を使っていない Node サーバーには暗黙を載せない', () => {
    const { decls } = declarationsOf(proj('/r/s', [pkg('s', { start: 'node server.js' }), { path: 'server.js', text: 'const PORT = process.env.PORT || 5730' }]))
    expect(decls).toMatchObject([{ port: 5730, kind: 'code', confidence: 'fallback', file: 'server.js' }])
  })
  it('サブフォルダの package.json の name でアプリ名を上書きしない', () => {
    const { name } = declarationsOf(proj('/r/a', [pkg('a', {}), { path: 'web/package.json', text: '{"name":"web"}' }]))
    expect(name).toBe('a')
  })
})

describe('buildLedger', () => {
  it('同じアプリ内で同じポートを vite.config と package.json の両方に書いていたら1行', () => {
    const p = proj('/r/a', [pkg('a', { dev: 'vite --port 5400 --strictPort' }), vite('server: { port: 5400 },')])
    const rows = buildLedger([p])
    expect(rows.filter((r) => r.kind === 'dev')).toMatchObject([{ port: 5400, strict: true }])
  })
  it('dev として宣言済みのポートをコードからも拾っていたら重ねない', () => {
    const p = proj('/r/a', [viteApp('/r/a', 'a', 5400).files[0], vite('server: { port: 5400 },'), { path: 'server.js', text: 'app.listen(5400)' }])
    expect(buildLedger([p]).filter((r) => r.port === 5400)).toHaveLength(1)
  })
  it('ポート順・名前順に並ぶ', () => {
    const rows = buildLedger([viteApp('/r/b', 'b', 5500), viteApp('/r/a', 'a', 5300)]).filter((r) => r.confidence !== 'implicit')
    expect(rows.map((r) => r.name)).toEqual(['a', 'b'])
  })
  it('package 名が無ければフォルダ名を使う', () => {
    const rows = buildLedger([proj('/r/kemuri-so', [{ path: 'package.json', text: '{"scripts":{"dev":"vite --port 5410"}}' }])])
    expect(rows[0].name).toBe('kemuri-so')
  })
})

describe('findConflicts', () => {
  it('別アプリが同じポートを宣言していたら衝突', () => {
    const rows = buildLedger([viteApp('/r/maai', 'maai', 5380, { strict: true }), viteApp('/r/sora', 'sora-shirabe', 5380)])
    const c = findConflicts(rows)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ port: 5380, sure: true })
    expect(c[0].entries.map((e) => [e.name, e.strict])).toEqual([['maai', true], ['sora-shirabe', false]])
  })
  it('同じアプリの別ワークツリー(同じリポジトリ・同じ名前)は衝突ではない', () => {
    const rows = buildLedger([
      viteApp('/r/sokomi', 'sokomi', 5730, { repo: '/r/sokomi/.git' }),
      viteApp('/w/sokomi/feat', 'sokomi', 5730, { repo: '/r/sokomi/.git' }),
    ])
    expect(findConflicts(rows)).toEqual([])
  })
  it('同じリポジトリでも別アプリ(app-ideas のブランチ別ワークツリー)なら衝突', () => {
    const repo = '/r/app-ideas/.git'
    const rows = buildLedger([viteApp('/w/app-ideas/a', 'a', 5900, { repo }), viteApp('/w/app-ideas/b', 'b', 5900, { repo })])
    expect(findConflicts(rows).map((c) => c.port)).toEqual([5900])
  })
  it('暗黙(Vite 既定)どうしは衝突に数えず、別枠で返す', () => {
    const a = proj('/r/a', [pkg('a', { dev: 'vite' })])
    const b = proj('/r/b', [pkg('b', { dev: 'vite' })])
    const rows = buildLedger([a, b])
    expect(findConflicts(rows)).toEqual([])
    expect(implicitApps(rows)).toMatchObject([{ port: 5173, apps: [{ name: 'a' }, { name: 'b' }] }])
  })
  it('明示的に 5173 を宣言したアプリと暗黙のアプリは衝突にしない(暗黙側は別枠で警告)', () => {
    const rows = buildLedger([viteApp('/r/maze', 'maze', 5173), proj('/r/x', [pkg('x', { dev: 'vite' })])])
    expect(findConflicts(rows)).toEqual([])
  })
  it('コードからの推定が絡むと sure=false', () => {
    const s = proj('/r/s', [pkg('s', {}), { path: 'server.js', text: 'srv.listen(5600)' }])
    const rows = buildLedger([s, viteApp('/r/v', 'v', 5600)])
    expect(findConflicts(rows)).toMatchObject([{ port: 5600, sure: false }])
  })
  it('環境変数の既定値と設定の宣言なら sure=true', () => {
    const s = proj('/r/denpa', [pkg('denpa', {}), { path: 'server.js', text: 'const PORT = process.env.PORT || 5730' }])
    expect(findConflicts(buildLedger([s, viteApp('/r/sokomi', 'sokomi', 5730)]))[0].sure).toBe(true)
  })
})

describe('appIdOf', () => {
  it('リポジトリ+名前', () => {
    expect(appIdOf({ dir: '/w/x', repo: '/r/x/.git' }, 'x')).toBe('/r/x/.git#x')
    expect(appIdOf({ dir: '/w/x', repo: null }, null)).toBe('/w/x#x')
  })
})

describe('projectForProcess', () => {
  const projects = [proj('/r/app', []), proj('/r/app/web', []), proj('/r/other', [])]
  it('cwd のいちばん深い一致', () => {
    expect(projectForProcess({ cwd: '/r/app/web/src' }, projects).dir).toBe('/r/app/web')
    expect(projectForProcess({ cwd: '/r/app' }, projects).dir).toBe('/r/app')
  })
  it('名前の前方一致だけでは一致にしない(/r/app と /r/apple)', () => {
    expect(projectForProcess({ cwd: '/r/apple' }, projects)).toBeNull()
  })
  it('cwd が / でもコマンドラインのパスから当てる', () => {
    expect(projectForProcess({ cwd: '/', cmdline: 'node /r/other/node_modules/.bin/vite' }, projects).dir).toBe('/r/other')
  })
})

describe('attachLive', () => {
  const projects = [viteApp('/r/maai', 'maai', 5380), viteApp('/r/sora', 'sora', 5380), viteApp('/r/kibun', 'kibun', 5420)]
  const rows = buildLedger(projects)
  it('自分のプロセス / 別アプリのプロセス / プロジェクト外を見分ける', () => {
    const { rows: out, foreign } = attachLive(rows, [
      { pid: 1, command: 'node', port: 5380, hosts: ['*'], cwd: '/r/sora' },
      { pid: 2, command: 'Python', port: 5420, hosts: ['*'], cwd: '/' },
      { pid: 3, command: 'Notion', port: 64124, hosts: ['127.0.0.1'], cwd: '/' },
    ], projects)
    const by = (name, port) => out.find((r) => r.name === name && r.port === port)?.live
    expect(by('sora', 5380)).toMatchObject({ by: 'self', pid: 1 })
    expect(by('maai', 5380)).toMatchObject({ by: 'other-app', name: 'sora' })
    expect(by('kibun', 5420)).toMatchObject({ by: 'outside' })
    expect(foreign.map((f) => f.pid)).toEqual([2, 3])
  })
  it('プロジェクト内で台帳にないポートを待ち受けていたら unlisted', () => {
    const { unlisted } = attachLive(rows, [{ pid: 9, command: 'node', port: 3000, hosts: ['*'], cwd: '/r/maai' }], projects)
    expect(unlisted).toMatchObject([{ port: 3000, name: 'maai' }])
  })
})

describe('suggestPorts', () => {
  const rows = [
    { port: 5010, strict: true },
    { port: 5020, strict: false },
  ]
  it('台帳・稼働中・常に避ける番号を飛ばし、刻みで返す', () => {
    expect(suggestPorts(rows, [{ port: 5030 }], { range: [5000, 5100], count: 3 })).toEqual([5040, 5050, 5060])
  })
  it('strictPort なしの宣言は +1〜+2 も避ける(刻み1のとき)', () => {
    expect(suggestPorts(rows, [], { range: [5018, 5026], step: 1, count: 10 })).toEqual([5018, 5019, 5023, 5024, 5025, 5026])
  })
  it('strictPort ありはすぐ上を使ってよい', () => {
    expect(suggestPorts(rows, [], { range: [5010, 5012], step: 1, count: 5 })).toEqual([5011, 5012])
  })
  it('5173 や 5000 は避ける', () => {
    expect(suggestPorts([], [], { range: [5000, 5000], count: 1 })).toEqual([])
    expect(suggestPorts([], [], { range: [5173, 5173], step: 1, count: 1 })).toEqual([])
  })
  it('--near で近い順', () => {
    expect(suggestPorts(rows, [], { range: [5000, 5999], near: 5500, count: 3 })).toEqual([5500, 5490, 5510])
  })
  it('空きが無ければ空配列', () => {
    expect(suggestPorts([{ port: 5100, strict: true }], [], { range: [5100, 5100] })).toEqual([])
  })
})

describe('nextAfterMax', () => {
  it('範囲内でいちばん大きい宣言の次の区切り', () => {
    const rows = [{ port: 5940, strict: true, confidence: 'declared' }, { port: 5960, strict: true, confidence: 'declared' }, { port: 8087, strict: false, confidence: 'declared' }]
    expect(nextAfterMax(rows, [], {})).toBe(5970)
  })
  it('次の区切りが稼働中なら、その次', () => {
    expect(nextAfterMax([{ port: 5960, strict: true, confidence: 'declared' }], [{ port: 5970 }], {})).toBe(5980)
  })
  it('暗黙(5173)は最大値に数えない', () => {
    expect(nextAfterMax([{ port: 5300, strict: true, confidence: 'declared' }, { port: 5173, confidence: 'implicit', strict: false }], [], {})).toBe(5310)
  })
})
