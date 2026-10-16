// ファイル走査。走査ルートの下から package.json のあるフォルダを探し、ポートが書かれていそうなファイルを読む。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'Pods', 'DerivedData'])
const MAX_FILE = 256 * 1024
const CODE_RE = /\.[cm]?[jt]s$/
const TEST_RE = /\.(test|spec)\.[cm]?[jt]s$|\.d\.ts$/
const CONFIG_RE = /^(vite|vitest|eslint|prettier|tailwind|postcss|playwright|svelte|astro|next|nuxt)\.config\./

export function defaultRoots() {
  const env = process.env.MINATO_ROOTS
  if (env) return env.split(':').filter(Boolean).map(expandHome)
  const home = os.homedir()
  return [path.join(home, 'ranzo_project'), path.join(home, 'orca', 'workspaces')]
}

export const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p))

const safeReaddir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// iCloud の「最適化」で中身がクラウドにしか無いファイルは、読むとダウンロード待ちで固まる。
// サイズはあるのにブロックが0のものは読まない。
export const isDataless = (st) => st.size > 0 && st.blocks === 0

const readText = (file) => {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_FILE || isDataless(st)) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// ルートの下から package.json のあるフォルダを集める(深さ maxDepth まで)。
// ドットで始まるフォルダ(.git, .orca-worktree-trash など)と node_modules などは潜らない。
export function findProjectDirs(roots, maxDepth = 4) {
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (seen.has(dir)) return
    seen.add(dir)
    const entries = safeReaddir(dir)
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) found.push(dir)
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  for (const r of roots) if (existsSync(r)) walk(path.resolve(r), 0)
  return found.sort()
}

// ポートが書かれていそうなファイルだけ読む。
// - package.json / vite.config.* / .env*
// - コード: 直下の *.js 等、bin/ と server/ の下、src/ 直下の config|server|index|main|app 系
export function collectFiles(dir) {
  const files = []
  const add = (rel) => {
    const text = readText(path.join(dir, rel))
    if (text != null) files.push({ path: rel, text })
  }
  for (const e of safeReaddir(dir)) {
    if (!e.isFile()) continue
    const n = e.name
    if (n === 'package.json' || /^vite\.config\.[cm]?[jt]s$/.test(n) || (/^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n))) add(n)
    else if (CODE_RE.test(n) && !TEST_RE.test(n) && !CONFIG_RE.test(n)) add(n)
  }
  const walkCode = (rel, depth, filter) => {
    for (const e of safeReaddir(path.join(dir, rel))) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walkCode(r, depth - 1, filter)
      } else if (e.isFile() && CODE_RE.test(e.name) && !TEST_RE.test(e.name) && (!filter || filter(e.name))) add(r)
    }
  }
  walkCode('bin', 1)
  walkCode('server', 2)
  walkCode('src', 0, (n) => /^(config|server|index|main|app|daemon)\./.test(n))
  walkCode(path.join('src', 'server'), 1)
  return files
}

// git の「共通ディレクトリ」を返す。ワークツリーでも本体と同じ値になるので、同じリポジトリの判定に使う。
export function gitCommonDir(dir) {
  let cur = path.resolve(dir)
  for (;;) {
    const g = path.join(cur, '.git')
    try {
      const st = statSync(g)
      if (st.isDirectory()) return g
      if (st.isFile()) {
        if (isDataless(st)) return g
        const m = readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)
        if (!m) return g
        // commondir は読まずにパスから決める。ワークツリーの gitdir が走査ルートの外
        // (iCloud の ~/Documents など)にあると、読むだけで固まることがあるため。
        return commonDirFromGitdir(path.resolve(cur, m[1].trim()))
      }
    } catch {
      /* 無ければ上へ */
    }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

// "<repo>/.git/worktrees/<name>" → "<repo>/.git"
export function commonDirFromGitdir(gitdir) {
  const m = gitdir.match(/^(.*)\/worktrees\/[^/]+\/?$/)
  return m ? m[1] : gitdir
}

export function scanProjects(roots, opts = {}) {
  return findProjectDirs(roots, opts.maxDepth).map((dir) => ({
    dir,
    repo: gitCommonDir(dir),
    files: collectFiles(dir),
  }))
}
