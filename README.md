# Fold AI — Local MCP Server & Companion

A private, local Model Context Protocol (MCP) server that connects directly to your Fold expenses, allowing you to seamlessly query, analyze, and visualize your spending data from Claude Desktop or any compatible MCP client.

---

## Architecture Overview

This project is built to be 100% local, secure, and private. It consists of:

1. **SQLite Database (`db.sqlite`)**: The local storage containing all your normalized transaction history and custom category tags.
2. **`unfold_cli`**: A Go-based command line tool that communicates with Fold's v3 API to pull transaction records, parse custom tags, and sync them to your local database.
3. **`fold-mcp`**: A Node/TypeScript-based MCP server that exposes local tools to Claude, allowing the model to perform semantic search, spending summaries, and on-demand database sync.

---

## Setup & Installation

### 1. Compile the MCP Server
Navigate to the `fold-mcp` directory and build the server:
```bash
cd fold-mcp
npm install
npm run build
```

This compiles the TypeScript code into the production bundle at `fold-mcp/build/index.js`.

### 2. Configure Claude Desktop
Add the MCP server configuration to your Claude Desktop config file:

**File path on macOS:**
`~/Library/Application Support/Claude/claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "fold": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/Users/namanganapathi/Documents/fold-ai/fold-mcp/build/index.js"
      ]
    }
  }
}
```
*(Make sure the path to `node` matches your local environment; run `which node` to verify.)*

---

## Exposed MCP Tools

Once installed, Claude will have access to the following tools:

### 1. `sync_fold_data`
Synchronize transaction records from the Fold API into your local `db.sqlite`.
- **Arguments**:
  - `since` (optional, format: `YYYY-MM-DD`): Sync historical transactions from the specified date forward. If omitted, defaults to only fetching the last day's data.

### 2. `get_recent_transactions`
Retrieve the latest transaction records.
- **Arguments**:
  - `limit` (optional, default: `20`): Maximum number of transactions to return.

### 3. `search_transactions`
Perform fine-grained search and filtering on your transactions.
- **Arguments**:
  - `query` (optional): Text search matches description, categories, tags, notes.
  - `startDate` / `endDate` (optional, format: `YYYY-MM-DD`): Limit search within a date range.
  - `category` (optional): Filter by transaction category.
  - `tag` (optional): Filter by custom Fold tags.

### 4. `get_spending_summary`
Request spending aggregates grouped by category or tag.
- **Arguments**:
  - `startDate` / `endDate` (optional, format: `YYYY-MM-DD`): The timeframe to summarize.

---

## Syncing Historical Data

To sync your entire history of Fold usage:
1. Open Claude.
2. Ask Claude: `"Sync my Fold data from the beginning of my usage, e.g., 2015-01-01"` or run the `sync_fold_data` tool with the appropriate `since` date.
3. This runs the patched `unfold_cli` behind the scenes, populating `db.sqlite` with all historical transactions.

---

## Security & Privacy (Scenario A)

- **100% Local Execution**: All transaction history, tokens, and database files remain locally on your physical machine in `/Users/namanganapathi/Documents/fold-ai/db.sqlite`.
- **Shared Accounts Safe**: Even if you share your Claude account credentials with friends/family, **they will not see your spending data** unless they are physically using your specific computer or have access to your local file system. Because Claude Desktop runs MCP servers *locally*, their own Claude Desktop apps will attempt to run the MCP server on *their* computers and fail (or query their own local database if they have one), ensuring absolute separation.
