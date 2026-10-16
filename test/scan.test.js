// 走査(ファイル I/O)は tmp に本物のフォルダを作って通す
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { findProjectDirs, collectFiles, gitCommonDir, commonDirFromGitdir, scanProjects, isDataless } from '../src/io/scan.js'
import { buildLedger, findConflicts } from '../src/lib/ledger.js'

let root
const write = (rel, text) => {
  const p = path.join(root, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, text)
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'minato-')))
  write('maai/package.json', JSON.stringify({ name: 'maai', scripts: { dev: 'vite' } }))
  write('maai/vite.config.js', "export default { server: { port: 5380, strictPort: true } }")
  write('maai/node_modules/x/package.json', JSON.stringify({ name: 'x', scripts: { dev: 'vite --port 1111' } }))
  write('sora/package.json', JSON.stringify({ name: 'sora', scripts: { dev: 'vite --port 5380 --strictPort' } }))
  write('sora/src/config.js', 'export const port = process.env.PORT ?? 5381')
  write('sora/src/deep/thing.js', 'app.listen(4444)')
  write('sora/src/main.test.js', 'app.listen(4445)')
  write('.orca-worktree-trash/old/package.json', JSON.stringify({ name: 'old', scripts: { dev: 'vite --port 5380' } }))
  write('group/nested/app/package.json', JSON.stringify({ name: 'nested', scripts: { dev: 'vite --port 5600' } }))
  write('server-app/package.json', JSON.stringify({ name: 'server-app', scripts: { start: 'node server.js' } }))
  write('server-app/server.js', 'const PORT = process.env.PORT || 5730')
  write('server-app/.env', 'PORT=5731\n')
  write('server-app/.env.example', 'PORT=9999\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('findProjectDirs', () => {
  it('node_modules とドットで始まるフォルダ(ゴミ箱のワークツリー)には潜らない', () => {
    const dirs = findProjectDirs([root]).map((d) => path.relative(root, d))
    expect(dirs).toEqual(['group/nested/app', 'maai', 'server-app', 'sora'])
  })
  it('深さ制限', () => {
    expect(findProjectDirs([root], 1).map((d) => path.relative(root, d))).not.toContain('group/nested/app')
  })
  it('存在しないルートは黙って飛ばす', () => {
    expect(findProjectDirs([path.join(root, 'nope')])).toEqual([])
  })
})

describe('collectFiles', () => {
  it('src/ は config 系だけ、テストファイルと .env.example は読まない', () => {
    expect(collectFiles(path.join(root, 'sora')).map((f) => f.path).sort()).toEqual(['package.json', 'src/config.js'])
    expect(collectFiles(path.join(root, 'server-app')).map((f) => f.path).sort()).toEqual(['.env', 'package.json', 'server.js'])
  })
})

describe('git の同一リポジトリ判定', () => {
  it('worktrees/<name> の gitdir から共通ディレクトリをパスだけで出す', () => {
    expect(commonDirFromGitdir('/Users/me/r/.git/worktrees/feat')).toBe('/Users/me/r/.git')
    expect(commonDirFromGitdir('/Users/me/r/.git')).toBe('/Users/me/r/.git')
  })
  it('本物の git worktree でも本体と同じ値になる', () => {
    const repo = path.join(root, 'gitrepo')
    mkdirSync(repo)
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
    git('worktree', 'add', '-q', path.join(root, 'gitwt'), '-b', 'wt')
    expect(gitCommonDir(path.join(root, 'gitwt'))).toBe(gitCommonDir(repo))
    expect(gitCommonDir(path.join(repo))).toBe(path.join(repo, '.git'))
  })
  it('git の外なら null', () => {
    expect(gitCommonDir('/')).toBeNull()
  })
})

describe('isDataless', () => {
  it('サイズがあるのにブロック0(iCloud で中身がクラウドだけ)', () => {
    expect(isDataless({ size: 100, blocks: 0 })).toBe(true)
    expect(isDataless({ size: 100, blocks: 8 })).toBe(false)
    expect(isDataless({ size: 0, blocks: 0 })).toBe(false)
  })
})

describe('走査 → 台帳 → 衝突(通し)', () => {
  it('maai と sora の 5380 を衝突として出し、ゴミ箱の古いワークツリーは数えない', () => {
    const projects = scanProjects([root]).filter((p) => !p.dir.includes('git'))
    const rows = buildLedger(projects)
    const c = findConflicts(rows)
    expect(c.map((x) => [x.port, x.entries.map((e) => e.name)])).toEqual([[5380, ['maai', 'sora']]])
    expect(rows.find((r) => r.name === 'server-app' && r.port === 5731)).toMatchObject({ kind: 'env', file: '.env' })
    expect(rows.find((r) => r.port === 5381)).toMatchObject({ kind: 'code', confidence: 'fallback' })
  })
})
