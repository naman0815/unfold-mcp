# Fold AI — Zero-Touch Setup

## How to Set Up

1. Create a new empty folder anywhere on your computer.
2. Open **Claude Code** (or any Claude agent with terminal access) inside that folder.
3. Paste the prompt below. Everything else is automatic.

---

## 🚀 Paste This Prompt Into Claude Code

```
Set up the Fold AI local expense companion for me. I expect you to do everything automatically —
detect my OS, install dependencies, build all code, configure everything.
The ONLY things I will do manually are:
- Type my phone number when asked
- Enter the OTP sent to my phone

Begin now. Do not wait for permission between steps. Run every command yourself.

─────────────────────────────────────────

STEP 1 — Detect my operating system:
  Run a command to check whether I am on macOS or Windows.
  On macOS: `uname -s` returns "Darwin"
  On Windows: use `$env:OS` in PowerShell, which returns "Windows_NT"

  Save the result — every subsequent step must use the correct OS-specific commands.

─────────────────────────────────────────

STEP 2 — Clone the repository into the current directory:
  Run: git clone --depth 1 https://github.com/naman0815/fold-mcp .
  (git is pre-installed on modern macOS and Windows 10+. If it is missing, install it first:
    macOS: brew install git
    Windows: winget install --id Git.Git -e)

─────────────────────────────────────────

STEP 3 — Install system dependencies if missing. Check and install each:

  Note: npm install requires NO build tools — the SQLite dependency is pure WebAssembly.
  No Xcode, no Visual Studio Build Tools, nothing to compile.

  ── macOS ──────────────────────────────
  a) Homebrew:
       Check: command -v brew
       Install: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  b) Node.js (v18+):
       Check: node --version
       Install: brew install node

  c) Go (v1.20+):
       Check: go version
       Install: brew install go

  ── Windows (run in PowerShell as Administrator) ──
  a) winget (ships with Windows 10 1709+, should already be present):
       Check: winget --version
       If missing, direct me to: https://aka.ms/getwinget

  b) Node.js (v18+):
       Check: node --version
       Install: winget install --id OpenJS.NodeJS -e
       After installing, close and reopen the terminal so PATH updates take effect.

  c) Go (v1.20+):
       Check: go version
       Install: winget install --id GoLang.Go -e
       After installing Go on Windows, close and reopen the terminal so PATH updates take effect.

─────────────────────────────────────────

STEP 4 — Build the MCP server (TypeScript → JavaScript):
  Run: cd fold-mcp && npm install && npm run build && cd ..
  (Same command on both macOS and Windows)

─────────────────────────────────────────

STEP 5 — Build the unfold Go CLI:
  macOS:
    cd unfold_cli && go build -o ../unfold_patched . && cd ..

  Windows (PowerShell):
    cd unfold_cli; go build -o ../unfold_patched.exe .; cd ..

─────────────────────────────────────────

STEP 6 — Authenticate with my Fold account:
  macOS:   ./unfold_patched login
  Windows: .\unfold_patched.exe login

  This will prompt me to enter:
    1. My phone number (without country code, e.g. 9876543210)
    2. The OTP Fold sends to that number via SMS

  Wait for me to complete the login before proceeding.
  My session token is saved to ~/.config/unfold/config.yaml automatically.

─────────────────────────────────────────

STEP 7 — Configure Claude Desktop to use the MCP server:

  First, detect the full absolute path to the node binary:
    macOS:   Run `which node` and save the output (e.g. /opt/homebrew/bin/node)
    Windows: Run `(Get-Command node).Source` in PowerShell and save the output

  You MUST use this full path as the "command" value — Claude Desktop does not
  inherit the user's PATH, so a bare "node" will not work.

  The config file path is:
    macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
    Windows: %APPDATA%\Claude\claude_desktop_config.json

  Read the current file (create it if it does not exist).
  Add a "fold" entry under "mcpServers" using:
    - The FULL PATH to node as "command" (from the which/Get-Command step above)
    - The ABSOLUTE PATH to fold-mcp/build/index.js in the current directory as the arg

  Example for macOS (replace paths with the real values you detected):
  {
    "mcpServers": {
      "fold": {
        "command": "/opt/homebrew/bin/node",
        "args": ["/Users/yourname/fold-ai/fold-mcp/build/index.js"]
      }
    }
  }

  Example for Windows (replace paths with the real values you detected):
  {
    "mcpServers": {
      "fold": {
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["C:\\Users\\yourname\\fold-ai\\fold-mcp\\build\\index.js"]
      }
    }
  }

  If the file already has other mcpServers entries, merge the "fold" entry in — do not overwrite existing entries.
  Write the final JSON back to the config file.

  If you cannot write to this file automatically, print the exact JSON I need to paste
  and the exact file path to open.

─────────────────────────────────────────

STEP 8 — Confirm setup is complete and tell me to:
  1. Fully quit and relaunch Claude Desktop.
     macOS: Cmd+Q, then reopen from Applications.
     Windows: Right-click the tray icon → Quit, then reopen from Start Menu.
  2. Once relaunched, ask Claude: "Sync my Fold data from 2021-01-01 to today"
     This will pull my full transaction history into the local database.
     (Each year syncs in ~10s and up to 3 years run in parallel.)

─────────────────────────────────────────

Go ahead and start from Step 1 now.
```

---

## 🔒 Privacy & Security

- **Auth is phone + OTP only** — the unfold CLI uses your Indian mobile number and a one-time SMS code sent by Fold. No passwords. No API keys.
- **Tokens stored locally** at `~/.config/unfold/config.yaml` (macOS/Linux) or `%USERPROFILE%\.config\unfold\config.yaml` (Windows) — never shared.
- **Your data never touches GitHub** — `db.sqlite` is in `.gitignore` and lives only on your computer.
- **Each person's setup is fully isolated** — their own phone number, their own tokens, their own local database.
