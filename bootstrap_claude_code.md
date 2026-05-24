# Fold AI — Setup Guide for Claude Code

If you want to set up your own local Fold AI companion, follow this guide. 

## 1. How to Share this Project (For You)
1. Commit the code and push it to a private (or public) GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initialize private Fold MCP server"
   # Push to your private repository
   ```
   *(Note: The `.gitignore` is pre-configured to ensure your private database `db.sqlite` and transaction logs `tx.log` are never committed or shared.)*
2. Tell your friend to clone your repository:
   ```bash
   git clone <your-repo-url> fold-ai
   cd fold-ai
   ```

---

## 2. Instruction Prompt for your Friend's Claude Code (For Your Friend)
Once your friend has cloned the repository, they should open **Claude Code** (or Antigravity) in the cloned directory and paste the following comprehensive prompt:

```markdown
Hello! I have just cloned this Fold AI repository. I want to set up my own local Fold MCP server and sync my personal expense data. Please guide me and automate the setup end-to-end.

Here is what you should do:
1. Check my system dependencies (ensure Node.js and Go are installed).
2. Build the MCP server by running `npm install` and `npm run build` inside the `fold-mcp` folder.
3. Build the Go CLI by compiling `unfold_cli` to `unfold_patched` in the root folder.
4. Auto-detect the path to my Claude Desktop configuration file and write the MCP server configuration for the `fold` server pointing to `fold-mcp/build/index.js`.
5. Guide me through retrieving my personal Fold API credentials/headers (such as from my mobile app proxies or session cookies) and how to configure them so the sync tool works.
6. Once I provide the credentials, help me perform the initial sync from the beginning of my Fold usage (e.g. using `sync_fold_data(since="2015-01-01")`).

Let's begin!
```

---

## 3. How to Extract Your Fold API Key
To get your Fold API credentials to sync your own transactions, do the following:
1. Log into your Fold account or app.
2. If you are using their standard API, retrieve your session token or API credentials.
3. When running the `sync_fold_data` tool, Claude will prompt you to save these credentials locally so that `unfold_cli` can authenticately pull your transaction history directly.
