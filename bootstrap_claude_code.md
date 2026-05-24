# Fold AI — Zero-Touch Setup

## How to Set Up

1. Create a new empty folder anywhere on your Mac.
2. Open **Claude Code** (or any Claude agent with terminal access) inside that folder.
3. Paste the prompt below. Everything else is automatic.

---

## 🚀 Paste This Prompt Into Claude Code

```
Set up the Fold AI local expense companion for me. I expect you to do everything automatically — install dependencies, build all code, configure everything. The ONLY things I will do manually are:
- Type my phone number when asked
- Enter the OTP sent to my phone

Begin now. Do not wait for permission between steps. Run every command yourself.

─────────────────────────────────────────

STEP 1 — Clone the repository into the current directory:
  Run: git clone https://github.com/naman0815/fold-mcp .

─────────────────────────────────────────

STEP 2 — Install system dependencies if missing. Check and install each:

  a) Homebrew (required for everything else):
     Check: command -v brew
     Install if missing:
       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  b) Node.js (v18 or later):
     Check: node --version
     Install if missing: brew install node

  c) Go (v1.20 or later):
     Check: go version
     Install if missing: brew install go

─────────────────────────────────────────

STEP 3 — Build the MCP server (TypeScript → JavaScript):
  Run: cd fold-mcp && npm install && npm run build && cd ..

─────────────────────────────────────────

STEP 4 — Build the unfold Go CLI (used for Fold authentication and syncing):
  Run: cd unfold_cli && go build -o ../unfold_patched . && cd ..

─────────────────────────────────────────

STEP 5 — Authenticate with my Fold account:
  Run: ./unfold_patched login

  This will prompt me to enter:
    1. My phone number (without country code, e.g. 9876543210)
    2. The OTP Fold sends to that number via SMS

  Wait for me to complete the login before proceeding.

─────────────────────────────────────────

STEP 6 — Configure Claude Desktop to use the MCP server:
  The config file is at: ~/Library/Application Support/Claude/claude_desktop_config.json

  Read the current file (if it exists). Add a "fold" entry under "mcpServers" using the
  ABSOLUTE PATH to this directory. The entry should look like this (replace <DIR> with the
  real absolute path to the current working directory):

  {
    "mcpServers": {
      "fold": {
        "command": "node",
        "args": ["<DIR>/fold-mcp/build/index.js"]
      }
    }
  }

  If the file already has other mcpServers, merge the "fold" entry in — do not overwrite.
  Write the final JSON back to the file.

  If you cannot write to this file, print the exact JSON to paste and tell me which file to update.

─────────────────────────────────────────

STEP 7 — Confirm setup is complete and tell me to:
  1. Fully quit and relaunch Claude Desktop (Cmd+Q, then reopen).
  2. Once relaunched, ask Claude: "Sync my Fold data from 2015-01-01"
     This will populate my local database with my full transaction history.

─────────────────────────────────────────

Go ahead and start from Step 1 now.
```

---

## 🔒 Privacy & Security

- **Auth is phone + OTP only** — the unfold CLI uses your Indian mobile number and a one-time SMS code sent by Fold. No passwords. No API keys to copy.
- **Tokens stored locally** at `~/.config/unfold/config.yaml` on your machine — never shared.
- **Your data never touches GitHub** — `db.sqlite` is in `.gitignore` and only ever lives on your computer.
- **Each person's setup is completely isolated** — their own tokens, their own local database.
