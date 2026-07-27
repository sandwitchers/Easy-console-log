# Easy Console Log

A SillyTavern extension that captures and displays console logs in a premium overlay UI — built for mobile-first workflow. No more switching between Termux and SillyTavern to check console output.

## Features

- **Real-time console capture** — intercepts `console.log`, `info`, `warn`, `error`, and `debug`
- **Premium dark UI** — developer-tool aesthetic with colored level borders and badges
- **Source toggle** — switch between Frontend and Backend log views
- **Level filtering** — filter by ALL, DEBUG, INFO, WARN, ERROR
- **Search** — instant text search across all captured logs
- **Statistics bar** — live count of entries, warnings, and errors
- **Copy & Clear** — copy visible filtered logs to clipboard, or clear all
- **Toast notifications** — warnings and errors appear as floating notifications
- **Auto-scroll** — automatically scrolls to new entries with "new logs below" indicator
- **Capture toggle** — enable/disable browser console interception on demand
- **Mobile-optimized** — responsive overlay panel designed for phone screens

## Installation

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste the GitHub URL: `https://github.com/sandwitchers/Easy-console-log`
4. Refresh the page

## Usage

1. Open **Extensions settings** (right panel)
2. Find **Easy Console Log** — it shows a gear icon with "Open Setting"
3. Click **Open Setting** — the console monitor overlay appears
4. Logs are captured automatically in real-time
5. Use filter pills, search, and source toggle to narrow down what you see

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Capture browser console | Enabled | Intercepts browser console methods |
| Show notifications | Enabled | Toast notifications for warnings/errors |
| Max entries | 200 | Maximum stored log entries (auto-trims) |

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension metadata |
| `index.js` | Core logic — console interception, log management, UI binding |
| `style.css` | Premium dark UI styles |
| `settings.html` | Extension drawer (gear icon entry point) |
| `monitor.html` | Console log monitor overlay panel |

## License

MIT
