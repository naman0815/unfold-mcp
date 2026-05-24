# Fold AI — Zero-Touch Setup Guide for Claude Code

All your friend needs to do is:
1. Create a new empty folder on their Mac.
2. Open **Claude Code** (or Antigravity) inside that folder.
3. Paste the prompt below. That's it.

---

## 🚀 Zero-Touch Setup Prompt (Paste This Into Claude Code)

```
I want to set up my personal local Fold AI expense companion from scratch. Automate the entire setup end-to-end with no manual steps.

Step 1 — Clone the repository into the current directory:
  git clone https://github.com/naman0815/fold-mcp .

Step 2 — Check dependencies. Verify that Node.js and Go are installed.
  If Node.js is missing, instruct me to install it from https://nodejs.org
  If Go is missing, instruct me to install it from https://golang.org/dl

Step 3 — Build the MCP server:
  cd fold-mcp && npm install && npm run build && cd ..

Step 4 — Build the Go CLI (the unfold_cli tool that authenticates with Fold):
  cd unfold_cli && go build -o ../unfold_patched . && cd ..

Step 5 — Log in to my Fold account using the unfold CLI:
  Run: ./unfold_patched login
  It will prompt me for my Indian phone number (without +91) and then send an OTP to my phone.
  Enter the OTP when prompted. This stores my session token in ~/.config/unfold/config.yaml.

Step 6 — Configure Claude Desktop to use this MCP server:
  Find my Claude Desktop config file at:
    ~/Library/Application Support/Claude/claude_desktop_config.json
  Add this entry under "mcpServers" (replace <ABSOLUTE_PATH> with the full path to this directory):
  {
    "fold": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH>/fold-mcp/build/index.js"]
    }
  }

Step 7 — Perform the initial sync of all my Fold transaction history:
  Tell me to open Claude Desktop (restart it if already open) and ask it to:
  "Sync my Fold data from 2015-01-01"
  This will populate my local db.sqlite with all my historical transactions.

Let's begin!
```

---

## 🔒 How Auth & Privacy Works

- **Auth**: The `unfold_patched` CLI uses your Indian phone number + OTP (sent by Fold) to authenticate. No passwords. Tokens are stored locally in `~/.config/unfold/config.yaml` on your own machine.
- **Data Isolation**: Your transactions are stored in `db.sqlite` inside your local folder — never committed to GitHub (it's in `.gitignore`), never shared with anyone else.
- **Tokens are personal**: Even if two friends share the same GitHub repo, each person logs in separately with their own phone number and gets their own tokens and their own local database.
