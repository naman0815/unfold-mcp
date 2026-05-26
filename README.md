# Unfold MCP

An unofficial local MCP server for [Fold Money](https://fold.money) that lets you query and analyze your spending data directly from Claude. Everything runs on your machine — no data leaves your computer.

---

## Quick Setup (one prompt)

The easiest way to get started: create an empty folder, open Claude Code inside it, and paste the prompt from [bootstrap_claude_code.md](./bootstrap_claude_code.md). Claude will clone the repo, install dependencies, build everything, log you in, and configure Claude Desktop automatically. The only things you type are your phone number and the OTP.

---

## Manual Setup

### Requirements

- Node.js v18+
- Go 1.20+
- [Claude Desktop](https://claude.ai/download)
- A Fold account (India only)

### 1. Clone and build

```bash
git clone https://github.com/naman0815/fold-mcp.git
cd fold-mcp

# Build the MCP server
cd fold-mcp && npm install && npm run build && cd ..

# Build the Go CLI
cd unfold_cli && go build -o ../unfold_patched . && cd ..
```

> **No build tools required.** `npm install` downloads a pure WebAssembly SQLite — no Xcode, no native compilation.

### 2. Log in to Fold

```bash
./unfold_patched login
```

You'll be prompted for your phone number and an OTP. Tokens are stored at `~/.config/unfold/config.yaml`.

### 3. Configure Claude Desktop

Find your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `fold` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "fold": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/fold-mcp/fold-mcp/build/index.js"]
    }
  }
}
```

Use the full path to `node` (run `which node` on macOS or `(Get-Command node).Source` on Windows). A bare `"node"` won't work because Claude Desktop doesn't inherit your shell's PATH.

Quit and relaunch Claude Desktop to pick up the new config.

### 4. Sync your transaction history

Ask Claude:

> Sync my Fold data from 2021-01-01 to today

This pulls your full history into a local SQLite database. Each year syncs in about 10 seconds and up to 3 years run in parallel.

---

## Staying up to date

When new features are pushed, anyone who cloned the repo can update by running:

```bash
git pull
cd fold-mcp && npm run build
```

Or ask Claude directly: **"Are there any updates available?"** — the `check_for_updates` tool will fetch from GitHub and tell you how many commits behind you are and the exact command to run.

---

## Available Tools

Once installed, Claude has access to these tools:

**Data & sync**

| Tool | What it does |
|---|---|
| `get_sync_status` | Check how fresh your local data is before asking questions |
| `sync_fold_data` | Pull transactions from Fold into the local database |
| `check_for_updates` | Check if a newer version of fold-mcp is available on GitHub |

**Transactions**

| Tool | What it does |
|---|---|
| `get_recent_transactions` | Get the most recent N transactions |
| `search_transactions` | Filter by merchant, narration, tag, date range, amount, mode, or type |
| `full_text_search` | Fast FTS5 search across all text fields — finds any word in merchant, narration, or summary |

**Spending analysis**

| Tool | What it does |
|---|---|
| `get_spending_summary` | Income vs spending with top merchants and daily average |
| `get_merchant_summary` | Top merchants by total spend or transaction count |
| `get_monthly_trend` | Month-by-month income, spending, and net cash flow |
| `get_balance_history` | Average account balance by month |
| `get_spending_by_mode` | Breakdown by payment mode (CARD, UPI, NEFT, etc.) |
| `get_category_breakdown` | Spending grouped into categories: Food Delivery, Transport, Shopping, etc. |
| `get_unusual_transactions` | Charges that are way above your normal spend at a merchant |
| `get_recurring_merchants` | Subscriptions and habits — merchants you pay month after month |
| `compare_periods` | Side-by-side comparison of two date ranges (e.g. this month vs last) |
| `get_spending_forecast` | Projected month-end total based on your pace so far |
| `get_account_breakdown` | Per-bank-account income, spending, and transaction count |
| `get_day_of_week_patterns` | Which days of the week (or month) you spend the most |

**Routines & check-ins**

| Tool | What it does |
|---|---|
| `get_weekly_digest` | 7-day summary vs your rolling average, with unusual charge alerts |
| `get_tax_year_report` | Full April–March financial year report (income, spending, savings rate) |
| `get_spending_streak` | How many consecutive days you've stayed under a daily spending limit |
| `get_savings_rate` | Month-by-month savings rate with rolling average, trend, and negative-savings flags |

**Export**

| Tool | What it does |
|---|---|
| `export_transactions_csv` | Export filtered transactions to a CSV file on disk (defaults to `~/Downloads/`) |

### Example questions to ask Claude

- "What did I spend last month?"
- "How much have I spent on Swiggy this year?"
- "Show me my top 10 merchants since January"
- "Is my data up to date?"
- "Give me my weekly digest"
- "Are there any unusual charges in the last 3 months?"
- "Show me my FY 2024-25 report"
- "Break my spending down by category for this month"
- "How's my spending streak this week?"
- "Are there any updates available?"
- "Find any transaction mentioning 'coffee'"
- "Search for 'salary HDFC' across all my transactions"
- "Which subscriptions am I paying every month?"
- "Compare this month's spending vs last month"
- "Am I on track with my spending this month?"
- "Which day of the week do I spend the most?"
- "What's my savings rate over the last 6 months?"
- "Export all my transactions from January to March to a CSV"

---

## How it works

```
Claude Desktop
    |
    | MCP (stdio)
    v
fold-mcp/build/index.js      — Node.js process, read-only SQLite access
    |
    +-- SQLite reads -------> db.sqlite
    |
    +-- shell exec ---------> unfold_patched transactions -d --since X --till Y
                                    |
                                    | HTTPS (Bearer token)
                                    v
                              api.fold.money
                                    |
                                    v
                              db.sqlite  (upsert by transaction UUID)
```

The MCP server only reads from SQLite. All writes go through the Go CLI, which handles auth token refresh automatically before every sync.

---

## Privacy

- Everything runs locally. No data is sent to any third-party service.
- `db.sqlite` is gitignored and never leaves your machine.
- Auth tokens live at `~/.config/unfold/config.yaml`, scoped to your OS user.
- If you share a Claude account with others, they cannot see your spending data because MCP servers run locally on each person's own computer.

## Credits
- [Fold Money](https://fold.money) for their Account Aggregator integration
- [Unfold](https://github.com/wantguns/unfold) for the CLI and API.
