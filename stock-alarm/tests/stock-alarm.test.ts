import { expect, mock, test } from 'claude-code/testing'
import { normalizeQuote, parseSymbols, alarmState, fmtPct } from '../hooks/register.js'

// A tickers/<SYMBOL> node shaped like Stock Alarm's feed
const node = (symbol: string, latestPrice: number, previousClose: number) => ({
  symbol,
  latestPrice,
  previousClose,
  change: latestPrice - previousClose,
  companyName: symbol + ' Inc',
  isUSMarketOpen: true,
})

const PRICES: Record<string, [number, number]> = {
  AAPL: [340.42, 338.0],
  NVDA: [230.48, 230.55],
  MSFT: [522.61, 520.0],
  TSLA: [375, 380],
  AMD: [150, 148],
}

function stubAll(on: any, saved: Map<string, unknown>, toasts: string[], urls: string[]) {
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('http.fetch', ($: any, e: any) => {
    urls.push(e.url)
    const sym = decodeURIComponent(e.url.split('/tickers/')[1].replace('.json', ''))
    const p = PRICES[sym]
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(p ? node(sym, p[0], p[1]) : null) } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

test('helpers parse symbols, quotes, alarms', async () => {
  expect(parseSymbols('aapl, $nvda  msft;;')).toEqual(['AAPL', 'NVDA', 'MSFT'])
  const q = normalizeQuote(node('NVDA', 230.48, 230.55))
  expect(q.price).toBe(230.48)
  expect(fmtPct(q.pct)).toBe('▼0.03%')
  expect(normalizeQuote(null)).toBeUndefined()
  expect(alarmState({ above: 250 }, 251)).toBe('above')
  expect(alarmState({ below: 200 }, 230)).toBeUndefined()
})

test('starts with the default list, adds and removes symbols, and saves them', async ($, on) => {
  const saved = new Map<string, unknown>()
  const toasts: string[] = []
  const urls: string[] = []
  const clock = mock.clock(on)
  stubAll(on, saved, toasts, urls)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  expect(urls.some((u) => u.endsWith('/tickers/AAPL.json'))).toBe(true)
  expect(urls[0].startsWith('https://stockalarm-8b019.firebaseio.com/tickers/')).toBe(true)

  const added = await $.command.run({ command: 'sa', args: 'add amd' })
  expect(added.text).toContain('Added AMD')
  expect(saved.get('watchlist')).toEqual(['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMD'])

  const removed = await $.command.run({ command: 'sa-rm', args: 'TSLA' })
  expect(removed.text).toContain('Removed TSLA')
  expect(saved.get('watchlist')).toEqual(['AAPL', 'NVDA', 'MSFT', 'AMD'])

  const list = await $.command.run({ command: 'sa', args: 'list' })
  expect(list.text).toMatch(/NVDA\s+230\.48/)
})

test('an alarm crossing shows a toast and highlights the band', async ($, on) => {
  const saved = new Map<string, unknown>()
  const toasts: string[] = []
  const urls: string[] = []
  const clock = mock.clock(on)
  stubAll(on, saved, toasts, urls)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const r = await $.command.run({ command: 'sa', args: 'alert NVDA above 200' })
  expect(r.text).toContain('Alarm set: NVDA above 200.00')
  expect(toasts.some((t) => t.startsWith('ALARM NVDA 230.48 crossed above 200.00'))).toBe(true)

  const band = await $.ui.mount({
    plugin: 'stock-alarm',
    component: 'AbovePrompt',
    requestId: 'above',
    surface: 'terminal',
    viewport: { columns: 160, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 150, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await band.find({ type: 'Text', text: '! NVDA 230.48 ▼0.03%' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'AAPL 340.42 ▲0.72%' })).toBeDefined()
  await band.unmount()
})

test('the pane lists symbols and its input adds one', async ($, on) => {
  const saved = new Map<string, unknown>()
  const toasts: string[] = []
  const urls: string[] = []
  const clock = mock.clock(on)
  stubAll(on, saved, toasts, urls)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const pane = await $.ui.mount({
    plugin: 'stock-alarm',
    component: 'Pane',
    requestId: 'stock-alarm',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { title: 'Stock Alarm', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} },
  } as any)
  expect(await pane.find({ key: 'rm-MSFT' })).toBeDefined()
  await pane.input({ key: 'add', text: 'amd' })
  expect(saved.get('watchlist')).toEqual(['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMD'])
  await pane.unmount()
})
