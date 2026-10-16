import { describe, it, expect } from 'vitest'
import { parseAddress, parseLsofF, parseLsofTable, parseCwdF, parsePs, unescapeCommand } from '../src/lib/lsof.js'

describe('parseAddress', () => {
  it.each([
    ['127.0.0.1:5173', { host: '127.0.0.1', port: 5173 }],
    ['*:5850', { host: '*', port: 5850 }],
    ['[::1]:5173', { host: '::1', port: 5173 }],
    ['[::]:3000', { host: '::', port: 3000 }],
    ['localhost:5173 (LISTEN)', { host: 'localhost', port: 5173 }],
    ['fe80::1%lo0:8080', { host: 'fe80::1%lo0', port: 8080 }],
  ])('%s', (s, want) => expect(parseAddress(s)).toEqual(want))
  it('接続中(->)や名前つきポートは null', () => {
    expect(parseAddress('127.0.0.1:5173->127.0.0.1:50000')).toBeNull()
    expect(parseAddress('localhost:http-alt')).toBeNull()
  })
})

// macOS の lsof 4.91(+c 0 -nP -iTCP -sTCP:LISTEN -Fpcn)で実際に出た形
const MAC_F = `p679
crapportd
f10
n*:56454
f11
n*:56454
p717
cControlCenter
f10
n*:7000
f11
n*:7000
p27913
cnode
f13
n*:5850
p59656
cAdobe Desktop Service
f14
n127.0.0.1:15292
`

describe('parseLsofF', () => {
  it('pid ごとにまとめ、IPv4/IPv6 の二重行を1つにする', () => {
    const l = parseLsofF(MAC_F)
    expect(l.map((x) => [x.port, x.pid, x.command])).toEqual([
      [5850, 27913, 'node'],
      [7000, 717, 'ControlCenter'],
      [15292, 59656, 'Adobe Desktop Service'],
      [56454, 679, 'rapportd'],
    ])
    expect(l.find((x) => x.port === 7000).hosts).toEqual(['*'])
  })
  it('Linux 版の IPv6 表記と CRLF も読める', () => {
    const l = parseLsofF('p100\r\ncvite\r\nf20\r\nn[::1]:5173\r\nf21\r\nn127.0.0.1:5173\r\n')
    expect(l).toEqual([{ pid: 100, command: 'vite', port: 5173, hosts: ['::1', '127.0.0.1'] }])
  })
  it('空の出力は空配列', () => {
    expect(parseLsofF('')).toEqual([])
  })
})

describe('parseLsofTable(-F が使えないときの保険)', () => {
  it('切り詰め・\\x20 エスケープ・(LISTEN) つきの表を読む', () => {
    const text = `COMMAND     PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
ControlCe   717 nokokoro   10u  IPv4 0xd3093e35702f2749      0t0  TCP *:7000 (LISTEN)
ControlCe   717 nokokoro   11u  IPv6 0x6534986b28aa10a5      0t0  TCP *:7000 (LISTEN)
Adobe\\x20 59656 nokokoro   14u  IPv4 0xe8b449023508dcfd      0t0  TCP 127.0.0.1:15292 (LISTEN)
node      27913 nokokoro   13u  IPv6 0xd46ccff6352d5205      0t0  TCP [::1]:5850 (LISTEN)`
    expect(parseLsofTable(text).map((x) => [x.port, x.pid, x.command])).toEqual([
      [5850, 27913, 'node'],
      [7000, 717, 'ControlCe'],
      [15292, 59656, 'Adobe '],
    ])
  })
})

describe('parseCwdF / parsePs / unescapeCommand', () => {
  it('cwd を pid ごとに', () => {
    const m = parseCwdF('p24760\nfcwd\nn/\np27913\nfcwd\nn/Users/me/app\n')
    expect(m.get(27913)).toBe('/Users/me/app')
    expect(m.get(24760)).toBe('/')
  })
  it('ps のコマンドラインを pid ごとに', () => {
    const m = parsePs('24760 Raycast Backend   \n27913 node /x/node_modules/.bin/../vite/bin/vite.js\n')
    expect(m.get(27913)).toBe('node /x/node_modules/.bin/../vite/bin/vite.js')
    expect(m.get(24760)).toBe('Raycast Backend')
  })
  it('\\x20 を空白に戻す', () => {
    expect(unescapeCommand('Google\\x20Chrome')).toBe('Google Chrome')
  })
})
