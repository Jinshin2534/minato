import { describe, it, expect } from 'vitest'
import { stripComments, extractVite, extractPackageJson, extractEnv, extractCode } from '../src/lib/extract.js'

describe('stripComments', () => {
  it('行コメントとブロックコメントを消し、行数は保つ', () => {
    const src = "a // port: 1\n/* port: 2\n */ b"
    const out = stripComments(src)
    expect(out).not.toMatch(/port/)
    expect(out.split('\n')).toHaveLength(3)
  })
  it('文字列の中の // は残す', () => {
    expect(stripComments("const u = 'http://x:1234' // c")).toContain('http://x:1234')
  })
})

describe('extractVite', () => {
  it('server.port を dev として拾い、行番号を返す', () => {
    const d = extractVite("import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  server: { port: 5410 },\n});")
    expect(d).toEqual([{ port: 5410, kind: 'dev', line: 4, strict: false, confidence: 'declared' }])
  })
  it('preview.port と strictPort を拾う', () => {
    const d = extractVite('export default {\n  server: { port: 5850, strictPort: true, host: true },\n  preview: { port: 5850, strictPort: true },\n}')
    expect(d.map((x) => [x.kind, x.port, x.strict])).toEqual([['dev', 5850, true], ['preview', 5850, true]])
  })
  it('複数行の server ブロックでも strictPort を見つける', () => {
    const d = extractVite('export default {\n  server: {\n    host: true,\n    port: 5650,\n    strictPort: true,\n  },\n}')
    expect(d).toMatchObject([{ port: 5650, kind: 'dev', line: 4, strict: true }])
  })
  it('strictPort は別ブロックのものを拾わない', () => {
    const d = extractVite('export default { server: { port: 5400 }, preview: { port: 5400, strictPort: true } }')
    expect(d.find((x) => x.kind === 'dev').strict).toBe(false)
    expect(d.find((x) => x.kind === 'preview').strict).toBe(true)
  })
  it('hmr.port は数えない', () => {
    expect(extractVite('export default { server: { hmr: { port: 24678 }, port: 5300 } }').map((x) => x.port)).toEqual([5300])
  })
  it('server の外の port(test など)は数えない', () => {
    expect(extractVite('export default { test: { port: 9999 } }')).toEqual([])
  })
  it('コメントアウトされた port は数えない', () => {
    expect(extractVite('export default { server: {\n // port: 5000,\n port: 5100 } }').map((x) => x.port)).toEqual([5100])
  })
  it('環境変数つきの式は既定値(fallback)として拾う', () => {
    const d = extractVite('export default { server: { port: Number(process.env.PORT) || 5555 } }')
    expect(d).toMatchObject([{ port: 5555, confidence: 'fallback' }])
  })
  it('キーが引用符つきでも拾う', () => {
    expect(extractVite('export default { "server": { "port": 5600 } }').map((x) => x.port)).toEqual([5600])
  })
  it('文字列の中の { } で入れ子を数え違えない', () => {
    expect(extractVite("export default { define: { x: '{' }, server: { port: 5700 } }").map((x) => x.kind)).toEqual(['dev'])
  })
  it('1行に詰めた設定でも拾う', () => {
    const d = extractVite("import{defineConfig}from'vite';export default defineConfig({server:{port:5820,strictPort:true}})")
    expect(d).toMatchObject([{ port: 5820, line: 1, strict: true }])
  })
})

describe('extractPackageJson', () => {
  const pkg = (scripts, name = 'app') => JSON.stringify({ name, scripts }, null, 2)
  it('--port と --strictPort を拾い、script 名で dev / preview を分ける', () => {
    const r = extractPackageJson(pkg({ dev: 'vite --port 5380 --strictPort', build: 'vite build', preview: 'vite preview --port 5380' }))
    expect(r.name).toBe('app')
    expect(r.decls.map((d) => [d.kind, d.port, d.strict, d.script])).toEqual([
      ['dev', 5380, true, 'dev'],
      ['preview', 5380, false, 'preview'],
    ])
  })
  it('--port=N / -p N / PORT=N の書き方', () => {
    const r = extractPackageJson(pkg({ a: 'vite --port=5001', b: 'next dev -p 3020', c: 'PORT=3030 node server.js' }))
    expect(r.decls.map((d) => d.port)).toEqual([5001, 3020, 3030])
  })
  it('script の行番号を返す', () => {
    const r = extractPackageJson(pkg({ dev: 'vite --port 5300' }))
    expect(r.decls[0].line).toBe(4)
  })
  it('vite を使っているか(dev / preview 別)を返す', () => {
    expect(extractPackageJson(pkg({ dev: 'vite', build: 'vite build', preview: 'vite preview' })).usesVite).toEqual({ dev: true, preview: true })
    expect(extractPackageJson(pkg({ build: 'vite build' })).usesVite).toEqual({ dev: false, preview: false })
    expect(extractPackageJson(pkg({ dev: 'vite --host' })).usesVite).toEqual({ dev: true, preview: false })
  })
  it('壊れた JSON でも落ちない', () => {
    expect(extractPackageJson('{ nope').decls).toEqual([])
  })
  it('ポートっぽくない数字は拾わない', () => {
    expect(extractPackageJson(pkg({ dev: 'vite --port 99999' })).decls).toEqual([])
  })
})

describe('extractEnv', () => {
  it('PORT / *_PORT を拾い、コメント行は無視する', () => {
    const d = extractEnv('# PORT=1\nPORT=3000\nexport API_PORT="8080"\nHOST=x\n')
    expect(d.map((x) => [x.port, x.line, x.note])).toEqual([[3000, 2, 'PORT'], [8080, 3, 'API_PORT']])
  })
})

describe('extractCode', () => {
  it('process.env.X_PORT ?? N を既定値として拾う', () => {
    const d = extractCode('export const config = {\n  port: Number(process.env.YOBAN_PORT ?? 5460),\n}')
    expect(d).toMatchObject([{ port: 5460, line: 2, confidence: 'fallback', kind: 'code' }])
  })
  it('|| でも拾う', () => {
    expect(extractCode('const port = process.env.PORT || 5730').map((d) => d.port)).toEqual([5730])
  })
  it('.listen(N) の直書きは推定として拾う', () => {
    expect(extractCode('server.listen(4000)')).toMatchObject([{ port: 4000, confidence: 'guess' }])
  })
  it('1024 未満やコメントの中は拾わない', () => {
    expect(extractCode('app.listen(80)\n// app.listen(3000)')).toEqual([])
  })
})
