// Stock Alarm (SA) mod for Claude Code.
//
// Shows live quotes for a small watchlist while you code: a boxed watchlist
// table docked in the band above the prompt with a one-line ticker strip under
// it (or the strip alone, or a status line), a /sa pane with the full table, and
// price alarms that highlight a symbol and pop a toast when it crosses a threshold.
//
// The docked table lives in the AbovePrompt render site (the band): it stays on
// screen while you chat, and the band shows a tree of up to e.props.maxRows rows
// whole. The table folds back to the strip in short or narrow terminals.
//
// Data source: Stock Alarm's own public tickers feed (Firebase RTDB
// tickers/<SYMBOL>.json, read-only, no key). Swap it with the
// SA_QUOTE_ENDPOINT env var or the quote_endpoint option. See README.md.

const PANE = 'stock-alarm'
const DEFAULT_ENDPOINT = 'https://stockalarm-8b019.firebaseio.com/tickers/{symbol}.json'
const DEFAULT_WATCHLIST = ['AAPL', 'NVDA', 'MSFT', 'TSLA']
// Stock Alarm Pro quote page: https://pro.stockalarm.io/quote/<SYMBOL>
const QUOTE_PAGE = 'https://pro.stockalarm.io/quote/'
const MAX_SYMBOLS = 25
// Dim hint at the end of the ticker strip; the first thing dropped when space is short
export const BAND_HINT = '· /sa help'
// Shown once per user (flag kept in $.store), a moment after the first session starts
export const FIRST_RUN_TIP = 'Stock Alarm: /sa to open watchlist · /sa add AMD · /sa alert NVDA above 250'
const FIRST_RUN_TIP_KEY = 'firstRunTipShown'
const FIRST_RUN_TIP_DELAY_MS = 1500
export const EMPTY_ALARMS = 'No alarms. Try /sa alert NVDA above 250'
// The docked table (display "panel", /sa dock)
export const DEFAULT_PANEL_ROWS = 5
// Below this many terminal rows, or this many band columns, the table folds to the strip
export const PANEL_MIN_TERMINAL_ROWS = 30
export const PANEL_MIN_COLUMNS = 60
// Command footer on the docked table's last row, beside its Add field
export const PANEL_FOOTER = '/sa add · /sa rm · /sa alert NVDA above 250 · /sa open NVDA'
const DISPLAYS = ['panel', 'band', 'status', 'off']

// ---------- module state (rebuilt on reload; durable bits live in $.store) ----------
let opts = {}
let watchlist = DEFAULT_WATCHLIST.slice()
let alerts = {} // { SYM: { above?: number, below?: number } }
let bandHidden = false
let hintsHidden = false // /sa hints off: no "· /sa help" in the strip or status line
let dockOverride // /sa dock: true, /sa undock: false, unset: follow the display option
let panelRowsSaved // /sa dock N: rows of the docked table; unset: the panel_rows option
let quotes = {} // { SYM: normalized quote }
let errors = {} // { SYM: message }
let lastUpdated = 0
let inflight = false
let firing = {} // { SYM: 'above' | 'below' } alarms currently triggered
let endpoint = DEFAULT_ENDPOINT
let sourceLabel = 'Stock Alarm tickers feed'

// ---------- pure helpers ----------
export function parseSymbols(text) {
  return String(text || '')
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^\$/, '').trim())
    .filter((s) => /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(s))
}

// Stock Alarm Pro quote page for a symbol. The route only accepts upper case
// (lower case 404s) and uses dots for share classes (BRK.B), so a class-share
// hyphen like BRK-B or BF-B becomes a dot.
export function quoteUrl(symbol) {
  let s = String(symbol || '').trim().replace(/^\$/, '').toUpperCase()
  if (/^[A-Z]{1,5}-[A-Z]$/.test(s)) s = s.replace('-', '.')
  return QUOTE_PAGE + encodeURIComponent(s)
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// Accepts a Stock Alarm tickers node or a typical quote object and returns
// { symbol, price, change, pct, isOpen, name }.
export function normalizeQuote(raw, fallbackSymbol) {
  if (!raw || typeof raw !== 'object') return undefined
  const symbol = String(raw.symbol || raw.fullSymbol || raw.firebaseKey || fallbackSymbol || '').toUpperCase()
  const price = num(raw.latestPrice) ?? num(raw.price) ?? num(raw.close)
  if (price === undefined) return undefined
  const prev = num(raw.previousClose)
  let change = num(raw.change)
  let pct
  if (prev !== undefined && prev > 0) {
    change = price - prev
    pct = (change / prev) * 100
  } else if (num(raw.changePercent) !== undefined) {
    pct = num(raw.changePercent) * 100
  } else if (num(raw.changesPercentage) !== undefined) {
    pct = num(raw.changesPercentage)
  }
  return {
    symbol,
    price,
    change,
    pct,
    isOpen: typeof raw.isUSMarketOpen === 'boolean' ? raw.isUSMarketOpen : undefined,
    name: raw.companyName || raw.name || undefined,
  }
}

// Pulls quotes out of a bulk response: an array, { quotes: [...] | {...} }, or a map by symbol.
export function quotesFromBulk(body) {
  const out = {}
  let list = body
  if (body && typeof body === 'object' && !Array.isArray(body) && body.quotes) list = body.quotes
  if (Array.isArray(list)) {
    for (const r of list) {
      const q = normalizeQuote(r)
      if (q && q.symbol) out[q.symbol] = q
    }
  } else if (list && typeof list === 'object') {
    for (const k of Object.keys(list)) {
      const q = normalizeQuote(list[k], k)
      if (q) out[q.symbol || k.toUpperCase()] = q
    }
  }
  return out
}

export function fmtPrice(p) {
  if (p === undefined) return '—'
  if (p >= 1000) return p.toFixed(0)
  if (p >= 1) return p.toFixed(2)
  return p.toPrecision(3)
}

export function fmtPct(pct) {
  if (pct === undefined) return ''
  const arrow = pct > 0.0049 ? '▲' : pct < -0.0049 ? '▼' : '•'
  return arrow + Math.abs(pct).toFixed(2) + '%'
}

function colorFor(pct) {
  if (pct === undefined) return undefined
  if (pct > 0.0049) return 'green'
  if (pct < -0.0049) return 'red'
  return undefined
}

// Which side of an alarm, if any, a price has crossed.
export function alarmState(alert, price) {
  if (!alert || price === undefined) return undefined
  if (alert.above !== undefined && price >= alert.above) return 'above'
  if (alert.below !== undefined && price <= alert.below) return 'below'
  return undefined
}

function describeAlert(a) {
  if (!a) return ''
  const parts = []
  if (a.above !== undefined) parts.push('≥' + fmtPrice(a.above))
  if (a.below !== undefined) parts.push('≤' + fmtPrice(a.below))
  return parts.join(' ')
}

// An alarm in words for the docked table: "above 250.00", "below 200.00", or both
export function alarmWords(a) {
  if (!a) return ''
  const parts = []
  if (a.above !== undefined) parts.push('above ' + fmtPrice(a.above))
  if (a.below !== undefined) parts.push('below ' + fmtPrice(a.below))
  return parts.join(' · ')
}

// The band's layout for a display option and the /sa dock | undock override:
// 'panel' (docked table + strip), 'band' (strip only), 'status' or 'off'
export function displayMode(display, docked) {
  if (docked === true) return 'panel'
  if (docked === false) return 'band'
  if (display === undefined || display === '') return 'panel'
  return DISPLAYS.includes(display) ? display : 'panel'
}

// Rows the docked table takes: its border (2), title, column header, one per
// symbol, a "+N more" row when the list is longer, and the Add/commands row
export function panelHeight(symbolRows, hasMore) {
  return 2 + 1 + 1 + symbolRows + (hasMore ? 1 : 0) + 1
}

// How many symbol rows the docked table draws, or 0 to fold to the one-line strip.
// Folds when the terminal is under PANEL_MIN_TERMINAL_ROWS rows or the band under
// PANEL_MIN_COLUMNS columns; otherwise shrinks to fit maxRows with the strip under it.
export function fitPanel({ want, total, terminalRows, maxRows, columns }) {
  if (!total || columns < PANEL_MIN_COLUMNS) return 0
  if (terminalRows !== undefined && terminalRows < PANEL_MIN_TERMINAL_ROWS) return 0
  const budget = maxRows - 1 // the strip's row
  let n = Math.max(1, Math.min(want, total))
  while (n > 0 && panelHeight(n, total > n) > budget) n -= 1
  if (n < Math.min(2, total)) return 0
  return n
}

// The symbols the docked table shows when it can't show them all: triggered
// alarms first, then the watchlist's order, drawn in watchlist order
export function panelSymbols(list, firingMap, n) {
  if (list.length <= n) return list.slice()
  const pick = new Set(list.filter((s) => firingMap && firingMap[s]).slice(0, n))
  for (const s of list) {
    if (pick.size >= n) break
    pick.add(s)
  }
  return list.filter((s) => pick.has(s))
}

function mode() {
  return displayMode(opts.display, dockOverride)
}

function panelRowsWanted() {
  const n = Number(panelRowsSaved ?? opts.panel_rows ?? DEFAULT_PANEL_ROWS)
  return Number.isFinite(n) ? Math.min(MAX_SYMBOLS, Math.max(1, Math.round(n))) : DEFAULT_PANEL_ROWS
}

function timeOf(ms) {
  if (!ms) return 'never'
  const d = new Date(ms)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return (h % 12 || 12) + ':' + m + (h < 12 ? 'am' : 'pm')
}

export function tickerLine() {
  const parts = []
  for (const s of watchlist) {
    const q = quotes[s]
    const tag = firing[s] ? '!' : ''
    parts.push(tag + s + ' ' + (q ? fmtPrice(q.price) + ' ' + fmtPct(q.pct) : errors[s] ? '?' : '…'))
  }
  return 'SA ' + parts.join('  ')
}

function anyOpen() {
  const vals = Object.values(quotes).filter((q) => q.isOpen !== undefined)
  if (!vals.length) return undefined
  return vals.some((q) => q.isOpen)
}

function listText() {
  const lines = ['Stock Alarm watchlist · ' + sourceLabel + ' · updated ' + timeOf(lastUpdated)]
  for (const s of watchlist) {
    const q = quotes[s]
    const a = describeAlert(alerts[s])
    const row =
      s.padEnd(7) +
      (q ? fmtPrice(q.price).padStart(10) + '  ' + fmtPct(q.pct).padEnd(8) : (errors[s] ? 'error: ' + errors[s] : 'loading').padStart(10)) +
      (a ? '  alarm ' + a : '') +
      (firing[s] ? '  << ALARM ' + firing[s].toUpperCase() : '')
    lines.push(row)
  }
  return lines.join('\n')
}

const HELP = [
  'Stock Alarm commands',
  '',
  'Watchlist',
  '  /sa                        open the full watchlist pane (Esc closes it)',
  '  /sa add AMD PLTR           add symbols (also /sa-add)',
  '  /sa rm TSLA                remove symbols (also /sa-rm)',
  '  /sa list                   print the watchlist with quotes',
  '  /sa open NVDA              open NVDA on Stock Alarm Pro',
  '',
  'Alarms',
  '  /sa alert NVDA above 250   alarm when NVDA trades at or above 250',
  '  /sa alert NVDA below 200   alarm when NVDA trades at or below 200',
  '  /sa alert NVDA clear       remove the alarms on NVDA',
  '',
  'Display',
  '  /sa dock [rows]            dock the watchlist table above the prompt (default 5 rows)',
  '  /sa undock                 just the one-line ticker strip',
  '  /sa hide | /sa show        hide or show the ticker (table and strip)',
  '  /sa hints off | on         hide or show the "/sa help" hint in the strip',
  '  /sa refresh                refresh quotes now',
  '  /sa reset                  default watchlist, all alarms cleared',
  '  /sa help                   this list',
  '',
  'The docked table folds to the strip when the terminal is under 30 rows or 60 columns.',
  'Alarms are local: they fire while a Claude Code session is open.',
].join('\n')

// Key commands, shown at the bottom of the /sa pane
export const PANE_FOOTER = [
  '/sa add AMD · /sa rm TSLA · /sa open NVDA · /sa help',
  '/sa alert NVDA above 250 · below 200 · clear',
]

// How many symbols on the watchlist have an alarm set
export function alarmCount(list, alertMap) {
  return list.filter((s) => {
    const a = alertMap && alertMap[s]
    return !!a && (a.above !== undefined || a.below !== undefined)
  }).length
}

// ---------- mods API helpers (top-level so validation can see the calls) ----------
async function loadSaved($) {
  const savedList = await $.store.get('watchlist')
  const savedAlerts = await $.store.get('alerts')
  const savedHidden = await $.store.get('bandHidden')
  const savedHints = await $.store.get('hintsHidden')
  const savedDocked = await $.store.get('docked')
  const savedRows = await $.store.get('panelRows')
  if (Array.isArray(savedList) && savedList.length) watchlist = parseSymbols(savedList.join(' ')).slice(0, MAX_SYMBOLS)
  else {
    const fromOpts = parseSymbols(opts.watchlist)
    watchlist = (fromOpts.length ? fromOpts : DEFAULT_WATCHLIST).slice(0, MAX_SYMBOLS)
  }
  alerts = savedAlerts && typeof savedAlerts === 'object' ? { ...savedAlerts } : {}
  bandHidden = savedHidden === true
  hintsHidden = savedHints === true
  dockOverride = typeof savedDocked === 'boolean' ? savedDocked : undefined
  panelRowsSaved = typeof savedRows === 'number' && Number.isFinite(savedRows) ? savedRows : undefined
}

// The one-time first-run tip. Returns true when it was shown.
async function showFirstRunTip($) {
  const seen = await $.store.get(FIRST_RUN_TIP_KEY)
  if (seen === true) return false
  await $.store.set(FIRST_RUN_TIP_KEY, true)
  $.ui.toast(FIRST_RUN_TIP, { timeoutMs: 15000 })
  return true
}

async function saveWatchlist($) {
  await $.store.set('watchlist', watchlist)
}

async function saveAlerts($) {
  await $.store.set('alerts', alerts)
}

async function getJson($, url) {
  const res = await $.http.fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return JSON.parse(res.text)
}

async function refresh($) {
  if (inflight || !watchlist.length) return
  inflight = true
  try {
    const symbols = watchlist.slice()
    if (endpoint.includes('{symbols}')) {
      try {
        const body = await getJson($, endpoint.replace('{symbols}', encodeURIComponent(symbols.join(','))))
        const got = quotesFromBulk(body)
        for (const s of symbols) {
          if (got[s]) {
            quotes[s] = got[s]
            delete errors[s]
          } else errors[s] = 'no quote'
        }
      } catch (err) {
        for (const s of symbols) errors[s] = String((err && err.message) || err)
      }
    } else {
      const results = await Promise.all(
        symbols.map((s) =>
          getJson($, endpoint.replace('{symbol}', encodeURIComponent(s)))
            .then((body) => ({ s, q: normalizeQuote(body, s) }))
            .catch((err) => ({ s, err: String((err && err.message) || err) })),
        ),
      )
      for (const r of results) {
        if (r.q) {
          quotes[r.s] = r.q
          delete errors[r.s]
        } else errors[r.s] = r.err || 'unknown symbol'
      }
    }
    lastUpdated = Date.now()
    await checkAlarms($)
    await showStatus($)
  } finally {
    inflight = false
    $.ui.invalidate('ui.render')
  }
}

async function checkAlarms($) {
  for (const s of watchlist) {
    const q = quotes[s]
    const state = alarmState(alerts[s], q && q.price)
    if (state && firing[s] !== state) {
      const level = state === 'above' ? alerts[s].above : alerts[s].below
      $.ui.toast('ALARM ' + s + ' ' + fmtPrice(q.price) + (state === 'above' ? ' crossed above ' : ' fell below ') + fmtPrice(level), { timeoutMs: 10000 })
    }
    if (state) firing[s] = state
    else delete firing[s]
  }
}

async function showStatus($) {
  if (mode() !== 'status' || bandHidden) return
  $.ui.status(tickerLine() + (hintsHidden ? '' : '  ' + BAND_HINT))
}

async function openSymbol($, symbol) {
  const url = quoteUrl(symbol)
  try {
    const r = await $.process.run(['open', url], { timeoutMs: 10000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || 'open failed')
  } catch {
    try {
      await $.process.run(['xdg-open', url], { timeoutMs: 10000 })
    } catch {
      // Nothing to open with; the URL is printed below
    }
  }
  return url
}

async function addSymbols($, list) {
  const added = []
  for (const s of list) {
    if (!watchlist.includes(s) && watchlist.length < MAX_SYMBOLS) {
      watchlist.push(s)
      added.push(s)
    }
  }
  if (added.length) {
    await saveWatchlist($)
    await refresh($)
  }
  return added
}

async function removeSymbols($, list) {
  const removed = list.filter((s) => watchlist.includes(s))
  if (removed.length) {
    watchlist = watchlist.filter((s) => !removed.includes(s))
    for (const s of removed) {
      delete quotes[s]
      delete errors[s]
      delete firing[s]
    }
    await saveWatchlist($)
    $.ui.invalidate('ui.render')
  }
  return removed
}

async function handleCommand($, argText) {
  const words = String(argText || '').trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] || '').toLowerCase()
  const rest = words.slice(1).join(' ')

  if (!sub || sub === 'pane' || sub === 'show-pane') {
    await $.ui.open({ id: PANE, title: 'Stock Alarm', focus: true, closeOnEscape: true })
    await refresh($)
    return {}
  }
  if (sub === 'help' || sub === '?' || sub === '-h' || sub === '--help') return { text: HELP }
  if (sub === 'hints' || sub === 'hint') {
    const arg = (words[1] || '').toLowerCase()
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /sa hints off | /sa hints on. Hints are ' + (hintsHidden ? 'off' : 'on') + '.' }
    hintsHidden = arg === 'off'
    await $.store.set('hintsHidden', hintsHidden)
    // Someone turning hints off doesn't need the first-run tip either
    if (hintsHidden) await $.store.set(FIRST_RUN_TIP_KEY, true)
    await showStatus($)
    $.ui.invalidate('ui.render')
    return { text: hintsHidden ? 'Hints off. /sa hints on brings them back.' : 'Hints on.' }
  }
  if (sub === 'list' || sub === 'ls') {
    await refresh($)
    return { text: listText() }
  }
  if (sub === 'add') {
    const syms = parseSymbols(rest)
    if (!syms.length) return { text: 'Usage: /sa add NVDA AMD' }
    const added = await addSymbols($, syms)
    return { text: added.length ? 'Added ' + added.join(', ') + '. Watchlist: ' + watchlist.join(' ') : 'Nothing added (already listed or the list is full at ' + MAX_SYMBOLS + ').' }
  }
  if (sub === 'rm' || sub === 'remove' || sub === 'del') {
    const syms = parseSymbols(rest)
    const removed = await removeSymbols($, syms)
    return { text: removed.length ? 'Removed ' + removed.join(', ') + '. Watchlist: ' + (watchlist.join(' ') || '(empty)') : 'None of those are on the watchlist.' }
  }
  if (sub === 'alert' || sub === 'alarm') {
    const sym = parseSymbols(words[1])[0]
    const dir = (words[2] || '').toLowerCase()
    if (!sym) return { text: 'Usage: /sa alert NVDA above 250 | /sa alert NVDA below 200 | /sa alert NVDA clear' }
    if (dir === 'clear' || dir === 'off' || dir === 'none') {
      delete alerts[sym]
      delete firing[sym]
      await saveAlerts($)
      $.ui.invalidate('ui.render')
      return { text: 'Cleared alarms on ' + sym + '.' }
    }
    const level = num(Number(String(words[3] || '').replace(/[$,]/g, '')))
    const side = dir === 'above' || dir === '>' || dir === '>=' ? 'above' : dir === 'below' || dir === '<' || dir === '<=' ? 'below' : undefined
    if (!side || level === undefined || level <= 0) return { text: 'Usage: /sa alert ' + sym + ' above 250 | below 200 | clear' }
    alerts = { ...alerts, [sym]: { ...(alerts[sym] || {}), [side]: level } }
    await saveAlerts($)
    if (!watchlist.includes(sym)) await addSymbols($, [sym])
    else await refresh($)
    return { text: 'Alarm set: ' + sym + ' ' + side + ' ' + fmtPrice(level) + '. Current: ' + (quotes[sym] ? fmtPrice(quotes[sym].price) : 'n/a') + '.' }
  }
  if (sub === 'open') {
    const sym = parseSymbols(rest)[0]
    if (!sym) return { text: 'Usage: /sa open NVDA' }
    const url = await openSymbol($, sym)
    return { text: 'Opened ' + url }
  }
  if (sub === 'refresh') {
    await refresh($)
    return { text: tickerLine() }
  }
  if (sub === 'dock' || sub === 'panel') {
    const arg = words[1]
    if (arg !== undefined) {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > MAX_SYMBOLS) return { text: 'Usage: /sa dock [rows], rows from 1 to ' + MAX_SYMBOLS + ' (default ' + DEFAULT_PANEL_ROWS + ').' }
      panelRowsSaved = n
      await $.store.set('panelRows', n)
    }
    const wasStatus = mode() === 'status'
    dockOverride = true
    bandHidden = false
    await $.store.set('docked', true)
    await $.store.set('bandHidden', false)
    if (wasStatus) $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    return {
      text:
        'Watchlist docked above the prompt (' + panelRowsWanted() + ' rows). It folds to the one-line strip when the terminal is under ' +
        PANEL_MIN_TERMINAL_ROWS + ' rows or ' + PANEL_MIN_COLUMNS + ' columns. /sa undock for the strip only.',
    }
  }
  if (sub === 'undock' || sub === 'strip') {
    const wasStatus = mode() === 'status'
    dockOverride = false
    bandHidden = false
    await $.store.set('docked', false)
    await $.store.set('bandHidden', false)
    if (wasStatus) $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    return { text: 'Undocked: just the one-line ticker strip. /sa dock brings the table back.' }
  }
  if (sub === 'hide') {
    bandHidden = true
    await $.store.set('bandHidden', true)
    if (mode() === 'status') $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    return { text: 'Ticker hidden. /sa show brings it back.' }
  }
  if (sub === 'show') {
    bandHidden = false
    await $.store.set('bandHidden', false)
    await showStatus($)
    $.ui.invalidate('ui.render')
    return { text: 'Ticker shown.' }
  }
  if (sub === 'reset') {
    const fromOpts = parseSymbols(opts.watchlist)
    watchlist = (fromOpts.length ? fromOpts : DEFAULT_WATCHLIST).slice(0, MAX_SYMBOLS)
    alerts = {}
    firing = {}
    quotes = {}
    errors = {}
    await saveWatchlist($)
    await saveAlerts($)
    await refresh($)
    return { text: 'Reset. Watchlist: ' + watchlist.join(' ') }
  }
  // "/sa NVDA AMD" with no subcommand: treat as add
  const syms = parseSymbols(argText)
  if (syms.length) {
    const added = await addSymbols($, syms)
    return { text: added.length ? 'Added ' + added.join(', ') + '.' : 'Already on the watchlist.' }
  }
  return { text: HELP }
}

async function registerCommands($) {
  const specs = [
    { name: 'sa', description: 'Stock Alarm: open the watchlist pane, or add | rm | alert | open | dock | undock | list | help', argumentHint: '[add|rm|alert|open|list|dock|undock|refresh|hide|show|hints|reset|help] [args]', immediate: true },
    { name: 'sa-add', description: 'Stock Alarm: add symbols to the watchlist', argumentHint: '<SYMBOL ...>', immediate: true },
    { name: 'sa-rm', description: 'Stock Alarm: remove symbols from the watchlist', argumentHint: '<SYMBOL ...>', immediate: true },
  ]
  for (const spec of specs) {
    try {
      await $.command.register(spec)
    } catch (err) {
      $.ui.log('could not add /' + spec.name + ': ' + String((err && err.message) || err))
    }
  }
}

// A failed /sa command prints a short error instead of nothing
function failed($, e, next) {
  return { text: 'Stock Alarm: ' + ((next.error && next.error.message) || 'command failed') }
}

// ---------- band drawing ----------

// The one-line ticker strip: SA  AAPL 340.42 ▲0.72%  NVDA ...  · /sa help
function stripRow(ui, width) {
  const { Box, Text } = ui
  const items = [Text({ bold: true, color: 'yellow', children: ['SA'] })]
  let used = 3
  let shown = 0
  let truncated = false
  for (const s of watchlist) {
    const q = quotes[s]
    const label = s + ' ' + (q ? fmtPrice(q.price) + ' ' + fmtPct(q.pct) : errors[s] ? '?' : '…')
    const firingSide = firing[s]
    const cell = (firingSide ? '! ' : '') + label
    if (used + cell.length + 2 > width - 4 && shown > 0) {
      items.push(Text({ dimColor: true, children: ['+' + (watchlist.length - shown)] }))
      truncated = true
      break
    }
    used += cell.length + 2
    shown += 1
    if (firingSide) {
      items.push(Text({ bold: true, inverse: true, color: firingSide === 'above' ? 'green' : 'red', children: [cell] }))
    } else {
      const c = colorFor(q && q.pct)
      items.push(Text(c ? { color: c, children: [label] } : { children: [label] }))
    }
  }
  const open = anyOpen()
  if (open === false && used + 8 < width) {
    items.push(Text({ dimColor: true, children: ['closed'] }))
    used += 8
  }
  // The hint goes last and only into room that's left, so it never pushes a quote off
  if (!hintsHidden && !truncated && used + BAND_HINT.length + 2 <= width - 4) {
    items.push(Text({ dimColor: true, children: [BAND_HINT] }))
  }
  return Box({ flexDirection: 'row', columnGap: 2, children: items })
}

// The docked watchlist table: SYMBOL / PRICE / CHANGE / ALARM / ACTIONS, an Add
// field and the command footer, in a rounded box `rows` symbols tall
function panelBox($, ui, width, rows) {
  const { Box, Text, Button, Input } = ui
  const inner = Math.max(20, width - 4) // border and one column of padding each side
  const W = { sym: 8, price: 10, change: 10, actions: 10 }
  W.alarm = Math.max(12, inner - W.sym - W.price - W.change - W.actions)
  const cell = (w, text) => Box({ width: w, flexShrink: 0, children: [text] })
  const open = anyOpen()
  const syms = panelSymbols(watchlist, firing, rows)
  const more = watchlist.length - syms.length

  const title = Box({
    flexDirection: 'row',
    children: [
      Text({ bold: true, children: ['Stock Alarm · Watchlist'] }),
      Text({
        dimColor: true,
        wrap: 'truncate',
        children: [' (/sa) · refreshed ' + timeOf(lastUpdated) + (open === undefined ? '' : open ? ' · market open' : ' · market closed')],
      }),
    ],
  })
  const head = (w, label) => cell(w, Text({ bold: true, dimColor: true, wrap: 'truncate', children: [label] }))
  const header = Box({
    flexDirection: 'row',
    children: [head(W.sym, 'SYMBOL'), head(W.price, 'PRICE'), head(W.change, 'CHANGE'), head(W.alarm, 'ALARM'), head(W.actions, 'ACTIONS')],
  })
  const body = syms.map((s) => {
    const q = quotes[s]
    const side = firing[s]
    const words = alarmWords(alerts[s])
    const c = colorFor(q && q.pct)
    const tint = (w, text) => cell(w, Text(c ? { color: c, wrap: 'truncate', children: [text] } : { wrap: 'truncate', children: [text] }))
    const alarm = side
      ? Text({ bold: true, inverse: true, color: 'yellow', wrap: 'truncate', children: [(words || side) + ' · TRIGGERED'] })
      : words
        ? Text({ color: 'yellow', wrap: 'truncate', children: [words] })
        : Text({ dimColor: true, children: ['—'] })
    return Box({
      key: 'dock-row-' + s,
      flexDirection: 'row',
      children: [
        cell(W.sym, Text(side ? { bold: true, color: side === 'above' ? 'green' : 'red', children: [s] } : { bold: true, wrap: 'truncate', children: [s] })),
        cell(W.price, Text({ wrap: 'truncate', children: [q ? fmtPrice(q.price) : errors[s] ? '?' : '…'] })),
        tint(W.change, q ? fmtPct(q.pct) || '—' : ''),
        cell(W.alarm, alarm),
        Box({
          width: W.actions,
          flexShrink: 0,
          flexDirection: 'row',
          children: [
            Button({ key: 'dock-open-' + s, label: 'open', plain: true, onPress: async () => { await openSymbol($, s) } }),
            Text({ dimColor: true, children: [' · '] }),
            Button({ key: 'dock-rm-' + s, label: 'x', plain: true, onPress: async () => { await removeSymbols($, [s]) } }),
          ],
        }),
      ],
    })
  })
  const footer = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Box({
        width: 22,
        flexShrink: 0,
        children: [
          Input({
            key: 'dock-add',
            label: 'Add',
            placeholder: 'symbol…',
            value: '',
            submitLabel: 'add',
            onSubmit: async (value) => {
              const list = parseSymbols(value)
              if (list.length) await addSymbols($, list)
            },
          }),
        ],
      }),
      Text({ dimColor: true, wrap: 'truncate', children: [PANEL_FOOTER] }),
    ],
  })
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: Object.keys(firing).length ? 'red' : 'yellow',
    paddingX: 1,
    children: [
      title,
      header,
      ...body,
      ...(more > 0 ? [Text({ dimColor: true, children: ['+' + more + ' more · /sa for the full list · /sa dock ' + Math.min(MAX_SYMBOLS, watchlist.length) + ' to show all'] })] : []),
      footer,
    ],
  })
}

// ---------- hooks ----------
export function register(on, options) {
  opts = options || {}

  on('session.start', async ($, e, next) => {
    const envEndpoint = await $.env.get('SA_QUOTE_ENDPOINT')
    const configured = (envEndpoint || opts.quote_endpoint || '').trim()
    endpoint = configured && /^https?:\/\//.test(configured) ? configured : DEFAULT_ENDPOINT
    sourceLabel = endpoint === DEFAULT_ENDPOINT ? 'Stock Alarm tickers feed' : 'custom endpoint'
    await loadSaved($)
    const seconds = Math.min(600, Math.max(10, Number(opts.refresh_seconds) || 30))
    $.clock.every(seconds * 1000, () => refresh($))
    // First fetch right away, without holding up the session start
    $.clock.after(0, () => refresh($))
    // One-time tip so new users find /sa; a short delay lets the interface settle
    $.clock.after(FIRST_RUN_TIP_DELAY_MS, () => {
      showFirstRunTip($).catch((err) => $.ui.log('first-run tip: ' + String((err && err.message) || err), { to: 'debug' }))
    })
    await registerCommands($)
    return next(e)
  })

  on('command.run', { command: 'sa' }, async ($, e) => handleCommand($, e.args)).catch(failed)
  on('command.run', { command: 'sa-add' }, async ($, e) => handleCommand($, 'add ' + (e.args || ''))).catch(failed)
  on('command.run', { command: 'sa-rm' }, async ($, e) => handleCommand($, 'rm ' + (e.args || ''))).catch(failed)

  // The band above the prompt: the docked watchlist table with the strip under
  // it, or the strip alone
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = mode()
    if (m !== 'panel' && m !== 'band') return next(e)
    if (bandHidden || !watchlist.length) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const props = e.props || {}
    const width = Math.max(20, props.bodyColumns || 80)
    const strip = stripRow(ui, width)
    let rows = 0
    // A survey holds the band first: fold to the strip while one shows
    if (m === 'panel' && !props.hasSurvey) {
      const maxRows = typeof props.maxRows === 'number' ? props.maxRows : 40
      const terminalRows = e.viewport && typeof e.viewport.rows === 'number' ? e.viewport.rows : maxRows
      rows = fitPanel({ want: panelRowsWanted(), total: watchlist.length, terminalRows, maxRows, columns: width })
    }
    const mine = rows > 0 ? Box({ flexDirection: 'column', children: [panelBox($, ui, width, rows), strip] }) : strip
    const theirs = await next(e)
    return theirs ? Box({ flexDirection: 'column', children: [mine, theirs] }) : mine
  })

  // The /sa pane
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const open = anyOpen()
    const header = Text({
      bold: true,
      children: ['Stock Alarm · ' + watchlist.length + ' symbols · ' + (open === undefined ? '' : open ? 'market open · ' : 'market closed · ') + 'updated ' + timeOf(lastUpdated)],
    })
    const rows = watchlist.map((s) => {
      const q = quotes[s]
      const side = firing[s]
      const a = describeAlert(alerts[s])
      const priceText = q ? fmtPrice(q.price).padStart(9) + ' ' + fmtPct(q.pct).padEnd(8) : (errors[s] ? 'err' : '…').padStart(9) + ' '.repeat(9)
      const c = side ? (side === 'above' ? 'green' : 'red') : colorFor(q && q.pct)
      const symText = side
        ? Text({ bold: true, inverse: true, color: c, children: [s.padEnd(6)] })
        : Text({ bold: true, children: [s.padEnd(6)] })
      return Box({
        key: 'row-' + s,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          symText,
          Text(c ? { color: c, children: [priceText] } : { children: [priceText] }),
          Text(side ? { bold: true, children: [a ? 'ALARM ' + a : ''] } : { dimColor: true, children: [a ? 'alarm ' + a : ''] }),
          Button({ key: 'open-' + s, label: 'open', plain: true, onPress: async () => { await openSymbol($, s) } }),
          Button({ key: 'rm-' + s, label: 'x', plain: true, onPress: async () => { await removeSymbols($, [s]) } }),
        ],
      })
    })
    return Box({
      flexDirection: 'column',
      children: [
        header,
        Input({
          key: 'add',
          label: 'Add',
          placeholder: 'symbols, e.g. AMD PLTR, then Enter',
          value: '',
          submitLabel: 'add',
          autoFocus: true,
          onSubmit: async (value) => {
            const syms = parseSymbols(value)
            if (syms.length) await addSymbols($, syms)
          },
        }),
        ...rows,
        ...(watchlist.length === 0 ? [Text({ dimColor: true, children: ['Watchlist empty. Type symbols in Add above, or /sa add AMD'] })] : []),
        ...(alarmCount(watchlist, alerts) === 0 ? [Text({ dimColor: true, children: [EMPTY_ALARMS] })] : []),
        Text({ children: [' '] }),
        ...PANE_FOOTER.map((line) => Text({ dimColor: true, children: [line] })),
        Text({ dimColor: true, children: ['Source: ' + sourceLabel] }),
      ],
    })
  })
}
