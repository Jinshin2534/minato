import { describe, it, expect } from 'vitest'
import { strWidth, pad, tildify, groupRows, formatConflicts, formatUnlisted, formatWho, makePaint, table, stripAnsi } from '../src/lib/format.js'
import { parseArgs } from '../src/lib/args.js'

const paint = makePaint(false)
const ctx = { home: '/Users/me', paint }

describe('format', () => {
  it('全角は幅2', () => {
    expect(strWidth('ab')).toBe(2)
    expect(strWidth('港a')).toBe(3)
    expect(pad('港', 4)).toBe('港  ')
  })
  it('tildify はフォルダ境界でだけ置き換える', () => {
    expect(tildify('/Users/me/x', '/Users/me')).toBe('~/x')
    expect(tildify('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
  })
  it('table は日本語を含んでも桁をそろえる', () => {
    const out = table([['港', 'x'], ['ab', 'y']], ['名', 'v']).split('\n')
    expect(out.map((l) => strWidth(l.split(/\s+/)[0]) + (l.length - l.trimStart().length))).toBeTruthy()
    expect(strWidth(out[1].slice(0, out[1].indexOf('x')))).toBe(strWidth(out[2].slice(0, out[2].indexOf('y'))))
  })
  it('色なしなら ANSI を含まない', () => {
    expect(stripAnsi(paint.red('x'))).toBe('x')
    expect(paint.red('x')).toBe('x')
    expect(makePaint(true).red('x')).toBe('\x1b[31mx\x1b[0m')
  })
  it('groupRows は同じアプリの dev+preview と別ワークツリーを1行にまとめる', () => {
    const base = { port: 5850, app: 'r#a', name: 'a', strict: true, confidence: 'declared', file: 'vite.config.js', line: 4, live: null }
    const g = groupRows([{ ...base, kind: 'dev', dir: '/w/a' }, { ...base, kind: 'preview', dir: '/w/a' }, { ...base, kind: 'dev', dir: '/w/a2' }])
    expect(g).toHaveLength(1)
    expect(g[0].kinds).toEqual(['dev', 'preview'])
    expect(g[0].dirs).toEqual(['/w/a', '/w/a2'])
  })
  it('衝突なしなら一行で言い切る', () => {
    expect(formatConflicts([], ctx)).toMatch(/衝突なし/)
  })
  it('衝突は場所と strictPort なしの注意を出す', () => {
    const r = (name, strict) => ({ dir: `/Users/me/p/${name}`, file: 'vite.config.js', line: 4, kind: 'dev', strict })
    const text = formatConflicts([{ port: 5410, sure: true, entries: [
      { name: 'kemuri-ate', rows: [r('kemuri-ate', false)], strict: false, confidence: 'declared', worktrees: ['x'] },
      { name: 'kemuri-so', rows: [r('kemuri-so', true)], strict: true, confidence: 'declared', worktrees: ['y'] },
    ] }], ctx)
    expect(text).toContain('5410')
    expect(text).toContain('~/p/kemuri-ate/vite.config.js:4')
    expect(text.split('\n').filter((l) => l.includes('strictPort なし'))).toHaveLength(1)
  })
  it('台帳外は 10000 以上を既定で隠し、件数だけ言う', () => {
    const l = (port) => ({ port, name: 'a', command: 'bun', pid: 1, dir: '/Users/me/a' })
    const text = formatUnlisted([l(3000), l(61308)], ctx)
    expect(text).toContain('台帳外で稼働中 1 件')
    expect(text).toContain('10000 以上の番号での待ち受けが 1 件')
    expect(formatUnlisted([l(61308)], { ...ctx, all: true })).toContain('61308')
  })
  it('who は宣言も稼働も無ければそう言う', () => {
    const text = formatWho(5999, { rows: [], listeners: [] }, ctx)
    expect(text).toMatch(/台帳には載っていない/)
    expect(text).toMatch(/稼働: なし/)
  })
})

describe('parseArgs', () => {
  it('引数なしは list', () => {
    expect(parseArgs([])).toMatchObject({ command: 'list', json: false, live: true })
  })
  it('数字だけなら who', () => {
    expect(parseArgs(['5173'])).toMatchObject({ command: 'who', port: 5173 })
  })
  it('suggest のオプション', () => {
    expect(parseArgs(['suggest', '-n', '5', '--range', '5800-5999', '--step=5', '--near', '5900', '--no-probe'])).toMatchObject({
      command: 'suggest', count: 5, range: [5800, 5999], step: 5, near: 5900, probe: false,
    })
  })
  it('--roots は : 区切り', () => {
    expect(parseArgs(['--roots', '~/a:/b']).roots).toEqual(['~/a', '/b'])
  })
  it('おかしな入力ははっきり断る', () => {
    expect(() => parseArgs(['nope'])).toThrow(/知らないコマンド/)
    expect(() => parseArgs(['who', 'x'])).toThrow()
    expect(() => parseArgs(['suggest', '--range', '6000-5000'])).toThrow(/--range/)
    expect(() => parseArgs(['suggest', '-n', '0'])).toThrow()
    expect(() => parseArgs(['suggest', '--range'])).toThrow(/値がない/)
  })
  it('--help / --version', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-v']).command).toBe('version')
  })
})
