import { expect, mock, test } from 'claude-code/testing'
import { normalizeQuote, parseSymbols, alarmState, fmtPct, alarmCount, BAND_HINT, EMPTY_ALARMS, FIRST_RUN_TIP, PANE_FOOTER, quoteUrl } from '../hooks/register.js'

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

function stubAll(on: any, saved: Map<string, unknown>, toasts: string[], urls: string[], runs: string[][] = []) {
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
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
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

// ---------- discoverability: band hint, first-run tip, pane footer and empty state ----------

const bandAt = ($: any, columns: number) =>
  $.ui.mount({
    plugin: 'stock-alarm',
    component: 'AbovePrompt',
    requestId: 'above',
    surface: 'terminal',
    viewport: { columns: columns + 10, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: columns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)

const mountPane = ($: any) =>
  $.ui.mount({
    plugin: 'stock-alarm',
    component: 'Pane',
    requestId: 'stock-alarm',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { title: 'Stock Alarm', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as any)

test('the band ends with a dim /sa help hint that is dropped first when narrow', async ($, on) => {
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on)
  stubAll(on, saved, [], [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)

  // Wide: all four quotes and the hint, the hint last
  const wide = await bandAt($, 150)
  const hint = await wide.find({ type: 'Text', text: BAND_HINT })
  expect(hint).toBeDefined()
  // The strip's own texts (the stub's 'drawn by Claude Code' sits on a row below it)
  const texts = (await wide.findAll({ type: 'Text' })).map((t: any) => t.text).filter((t: string) => t !== 'drawn by Claude Code')
  expect(texts[texts.length - 1]).toBe(BAND_HINT)
  await wide.unmount()

  // Just wide enough for every quote: the hint goes, the quotes stay
  const snug = await bandAt($, 90)
  expect(await snug.find({ type: 'Text', text: BAND_HINT })).toBeUndefined()
  expect(await snug.find({ type: 'Text', text: 'TSLA 375.00' })).toBeDefined()
  expect(await snug.find({ type: 'Text', text: /^\+\d/ })).toBeUndefined()
  await snug.unmount()

  // Narrow: quotes overflow into +N and there's no hint
  const narrow = await bandAt($, 50)
  expect(await narrow.find({ type: 'Text', text: BAND_HINT })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /^\+\d/ })).toBeDefined()
  await narrow.unmount()
})

test('/sa hints off hides the hint and is saved; /sa hints on brings it back', async ($, on) => {
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on)
  stubAll(on, saved, [], [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)

  const off = await $.command.run({ command: 'sa', args: 'hints off' })
  expect(off.text).toContain('Hints off')
  expect(saved.get('hintsHidden')).toBe(true)
  expect(saved.get('watchlist')).toBeUndefined() // "hints" is not taken as a symbol
  let band = await bandAt($, 150)
  expect(await band.find({ type: 'Text', text: BAND_HINT })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'AAPL 340.42' })).toBeDefined()
  await band.unmount()

  // Still off after a reload
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  band = await bandAt($, 150)
  expect(await band.find({ type: 'Text', text: BAND_HINT })).toBeUndefined()
  await band.unmount()

  const on_ = await $.command.run({ command: 'sa', args: 'hints on' })
  expect(on_.text).toContain('Hints on')
  expect(saved.get('hintsHidden')).toBe(false)
  band = await bandAt($, 150)
  expect(await band.find({ type: 'Text', text: BAND_HINT })).toBeDefined()
  await band.unmount()

  const usage = await $.command.run({ command: 'sa', args: 'hints' })
  expect(usage.text).toContain('Usage: /sa hints off')
})

test('the first-run tip shows once and saves a flag', async ($, on) => {
  const saved = new Map<string, unknown>()
  const toasts: string[] = []
  const clock = mock.clock(on)
  stubAll(on, saved, toasts, [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  expect(toasts.filter((t) => t === FIRST_RUN_TIP)).toHaveLength(1)
  expect(FIRST_RUN_TIP).toBe('Stock Alarm: /sa to open watchlist · /sa add AMD · /sa alert NVDA above 250')
  expect(saved.get('firstRunTipShown')).toBe(true)

  // A later session (same saved state) doesn't show it again
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  expect(toasts.filter((t) => t === FIRST_RUN_TIP)).toHaveLength(1)
})

test('the first-run tip stays hidden when the flag is already saved', async ($, on) => {
  const saved = new Map<string, unknown>([['firstRunTipShown', true]])
  const toasts: string[] = []
  const clock = mock.clock(on)
  stubAll(on, saved, toasts, [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2000)
  expect(toasts.includes(FIRST_RUN_TIP)).toBe(false)
})

test('the pane shows a command footer, and an empty state until an alarm is set', async ($, on) => {
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on)
  stubAll(on, saved, [], [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)

  let pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: EMPTY_ALARMS })).toBeDefined()
  for (const line of PANE_FOOTER) expect(await pane.find({ type: 'Text', text: line })).toBeDefined()
  for (const word of ['/sa add', '/sa rm', 'alert NVDA above', 'below', 'clear', '/sa open', '/sa help']) {
    expect(PANE_FOOTER.join(' ')).toContain(word)
  }
  await pane.unmount()

  await $.command.run({ command: 'sa', args: 'alert NVDA above 250' })
  pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: EMPTY_ALARMS })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'alarm ≥250.00' })).toBeDefined()
  await pane.unmount()

  await $.command.run({ command: 'sa', args: 'alert NVDA clear' })
  pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: EMPTY_ALARMS })).toBeDefined()
  await pane.unmount()
})

test('/sa help lists every command, including hints', async ($, on) => {
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on)
  stubAll(on, saved, [], [])

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const help = await $.command.run({ command: 'sa', args: 'help' })
  for (const cmd of ['/sa add', '/sa rm', '/sa alert NVDA above 250', '/sa alert NVDA below 200', '/sa alert NVDA clear', '/sa open', '/sa hints off', '/sa hide']) {
    expect(help.text).toContain(cmd)
  }
  expect(alarmCount(['NVDA', 'AAPL'], { NVDA: { above: 1 }, TSLA: { below: 2 } })).toBe(1)
})

// ---------- open: Stock Alarm Pro quote page ----------

test('quoteUrl points at the Stock Alarm Pro quote page in the form the route expects', async () => {
  expect(quoteUrl('NVDA')).toBe('https://pro.stockalarm.io/quote/NVDA')
  expect(quoteUrl('nvda')).toBe('https://pro.stockalarm.io/quote/NVDA')
  expect(quoteUrl(' $aapl ')).toBe('https://pro.stockalarm.io/quote/AAPL')
  expect(quoteUrl('BRK.B')).toBe('https://pro.stockalarm.io/quote/BRK.B')
  expect(quoteUrl('brk-b')).toBe('https://pro.stockalarm.io/quote/BRK.B')
  expect(quoteUrl('BF-B')).toBe('https://pro.stockalarm.io/quote/BF.B')
  expect(quoteUrl('BTC-USD')).toBe('https://pro.stockalarm.io/quote/BTC-USD')
  expect(quoteUrl('^GSPC')).toBe('https://pro.stockalarm.io/quote/%5EGSPC')
  expect(quoteUrl('NVDA')).not.toContain('app.stockalarm.io')
})

test('/sa open opens the Stock Alarm Pro quote page', async ($, on) => {
  const saved = new Map<string, unknown>()
  const runs: string[][] = []
  const clock = mock.clock(on)
  stubAll(on, saved, [], [], runs)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const r = await $.command.run({ command: 'sa', args: 'open nvda' })
  expect(r.text).toBe('Opened https://pro.stockalarm.io/quote/NVDA')
  expect(runs).toContainEqual(['open', 'https://pro.stockalarm.io/quote/NVDA'])

  const brk = await $.command.run({ command: 'sa', args: 'open brk.b' })
  expect(brk.text).toBe('Opened https://pro.stockalarm.io/quote/BRK.B')

  const usage = await $.command.run({ command: 'sa', args: 'open' })
  expect(usage.text).toBe('Usage: /sa open NVDA')

  const help = await $.command.run({ command: 'sa', args: 'help' })
  expect(help.text).toContain('open NVDA on Stock Alarm Pro')
})

test("the pane's open button opens the Stock Alarm Pro quote page", async ($, on) => {
  const saved = new Map<string, unknown>()
  const runs: string[][] = []
  const clock = mock.clock(on)
  stubAll(on, saved, [], [], runs)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const pane = await mountPane($)
  await pane.press({ key: 'open-MSFT' })
  expect(runs).toContainEqual(['open', 'https://pro.stockalarm.io/quote/MSFT'])
  expect(runs.some((argv) => argv.some((a) => a.includes('app.stockalarm.io')))).toBe(false)
  await pane.unmount()
})
