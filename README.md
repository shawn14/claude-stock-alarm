# Stock Alarm for Claude Code

Live stock prices in Claude Code. This **mod** (a Claude Code plugin with a hooks module) keeps your watchlist in view while you work:

- **Ticker strip above the prompt**: `SA  AAPL 340.42 ▲0.72%  NVDA 230.48 ▼0.03%  MSFT …`, green when a stock is up, red when it's down, and `closed` when the US market is shut.
- **`/sa` watchlist pane**: the full watchlist with price, change, alerts, an "Add" field, an `open` button per row (opens the symbol on stockalarm.io), and an `x` to remove it.
- **Local price alerts**: `/sa alert NVDA above 250` highlights NVDA in the strip and pane and shows a toast in Claude Code when the price crosses.

![Stock Alarm in Claude Code](docs/screenshot.png)

*Mockup: the `/sa` watchlist pane with a triggered MSFT alert, and the ticker strip above the prompt during a normal Claude Code session.*

## Requirements

- Claude Code **2.1.287 or later** (mods first shipped in 2.1.287). Check with `claude --version`.
- No account, API key, or extra software.

## Install

```bash
claude plugin marketplace add shawn14/claude-stock-alarm
claude plugin install stock-alarm@stock-alarm
```

Or, inside a Claude Code session: `/plugin marketplace add shawn14/claude-stock-alarm`, then `/plugin install stock-alarm@stock-alarm`.

Start a new `claude` session (or run `/reload-plugins` in an open one). The ticker strip appears above the prompt within a few seconds.

Update: `claude plugin marketplace update stock-alarm && claude plugin update stock-alarm@stock-alarm`
Turn it off: `claude plugin disable stock-alarm@stock-alarm` (or `/plugin` → Installed → stock-alarm)
Remove it: `claude plugin uninstall stock-alarm@stock-alarm && claude plugin marketplace remove stock-alarm`

## Usage

Not sure what to type? Run **`/sa help`**. The ticker strip ends with a dim `· /sa help` hint when there's room for it
(it's the first thing dropped in a narrow terminal, so it never pushes a quote off), and the first time the mod runs it
shows a one-time tip: *Stock Alarm: /sa to open watchlist · /sa add AMD · /sa alert NVDA above 250*.

| Command | What it does |
| --- | --- |
| `/sa` | Open the watchlist pane (Esc closes it; type symbols in "Add" and press Enter) |
| `/sa add AMD PLTR` or `/sa-add AMD PLTR` | Add symbols (up to 25) |
| `/sa rm TSLA` or `/sa-rm TSLA` | Remove symbols |
| `/sa list` | Print the watchlist with fresh quotes |
| `/sa open NVDA` | Open NVDA on stockalarm.io in your browser |
| `/sa alert NVDA above 250` | Alarm when NVDA trades at or above 250 |
| `/sa alert NVDA below 200` | Alarm when NVDA trades at or below 200 |
| `/sa alert NVDA clear` | Remove the alarms on NVDA |
| `/sa hide` / `/sa show` | Hide or show the ticker strip |
| `/sa hints off` / `/sa hints on` | Hide or show the `· /sa help` hint in the strip (for power users) |
| `/sa refresh` | Refresh quotes now |
| `/sa reset` | Back to the default watchlist, alarms cleared |
| `/sa help` | List the commands |

The `/sa` pane lists the key commands at the bottom, and until you set an alarm it shows
*No alarms. Try /sa alert NVDA above 250*.

All `/sa` commands run immediately, even while Claude is in the middle of a turn. Your watchlist, alarms, and hint
setting are saved locally and shared by every Claude Code session on your machine.

Alerts in this mod are local: they only fire while a Claude Code session is open. For alerts on your phone, see below.

## Settings

Run `/plugin configure stock-alarm@stock-alarm` (or find the rows in `/config`):

| Setting | Default | What it does |
| --- | --- | --- |
| `watchlist` | `AAPL NVDA MSFT TSLA` | Default symbols, space- or comma-separated. Used until you change the list with `/sa add` / `/sa rm`, and after `/sa reset`. |
| `refresh_seconds` | `30` | How often quotes refresh, 10 to 600 seconds |
| `display` | `band` | `band`: strip above the prompt. `status`: one line under the prompt. `off`: only the `/sa` pane. |
| `quote_endpoint` | *(empty)* | Optional custom quote URL (see below). Empty uses Stock Alarm's public feed. |

### Quote source

By default, quotes come from Stock Alarm's public, read-only tickers feed (no key needed), one small request per symbol per refresh:

```
https://stockalarm-8b019.firebaseio.com/tickers/<SYMBOL>.json
```

To use a different source, set the `quote_endpoint` setting or the `SA_QUOTE_ENDPOINT` environment variable (the
variable wins) to a URL template:

- `{symbol}`: one request per symbol; the response is one quote object
- `{symbols}`: one request with a comma-separated list; the response is an array, `{ "quotes": [...] }`, or `{ "quotes": { "SYM": {...} } }`

Recognized fields: `symbol`, `latestPrice` / `price` / `close`, `previousClose`, `change`, `changePercent` (fraction),
`changesPercentage` (percent), `isUSMarketOpen`, `companyName` / `name`.

Unknown symbols show as `?`. Symbols containing a dot, such as `BRK.B`, may not resolve on the default feed.

## Powered by Stock Alarm

This mod is powered by [Stock Alarm](https://stockalarm.io). For real alerts on your phone (push notifications,
email, or a phone call) on price, percent change, moving averages, RSI, earnings, and more, get the app:

- [Stock Alarm for iOS](https://apps.apple.com/us/app/stock-alarm-alerts-tracker/id1465535138)
- [Stock Alarm for Android](https://play.google.com/store/apps/details?id=com.StockMarketAlarms.StockAlarm)
- [Stock Alarm on the web](https://app.stockalarm.io)

## Disclaimer

Quotes may be delayed and are provided for information only. Nothing in this mod is investment advice.

## Development

```bash
git clone https://github.com/shawn14/claude-stock-alarm
cd claude-stock-alarm
claude --plugin-dir ./stock-alarm                 # try it in one session, with hot reload
claude plugin validate ./stock-alarm --strict     # static checks
cd stock-alarm && claude plugin test              # unit tests (no network)
```

Layout:

```
.claude-plugin/marketplace.json   # the "stock-alarm" marketplace
stock-alarm/                      # the mod
├── .claude-plugin/plugin.json    # manifest and settings
├── hooks/hooks.json              # { "modules": ["./register.js"] }
├── hooks/register.js             # the hooks module
└── tests/stock-alarm.test.ts     # tests for `claude plugin test`
```

The mods API can change between Claude Code releases. This version was tested with Claude Code 2.1.295.

## License

[MIT](LICENSE) © Shawn Carpenter / Stock Alarm
