# Fold AI — Zero-Touch Setup Guide for Claude Code

This guide provides an incredibly simple, automated way for anyone to set up their own local Fold AI companion. All they need to do is open Claude Code in an empty folder and paste a single prompt!

---

## 🚀 The Zero-Touch Setup Prompt (For Your Friend)

Have your friend create a new empty directory on their Mac, launch **Claude Code** (or Antigravity) inside that directory, and copy-paste the exact prompt below:

```markdown
I want to set up my personal local Fold AI expense companion from scratch. Please automate the entire setup end-to-end.

Here is what you should do:
1. Clone the Fold AI repository into the current directory:
   git clone https://github.com/naman0815/fold-mcp .

2. Verify system dependencies (ensure Node.js and Go are installed).
3. Build the MCP server by running `npm install` and `npm run build` inside the `fold-mcp` folder.
4. Build the Go CLI by compiling `unfold_cli` to `unfold_patched` in the root folder.
5. Auto-detect the path to my Claude Desktop configuration file and write the MCP server configuration for the `fold` server pointing to `fold-mcp/build/index.js` under the absolute path of this directory.
6. Guide me through retrieving my personal Fold API credentials/headers (such as from my mobile app proxies or session cookies) and how to configure them so the sync tool works.
7. Once I provide the credentials, help me perform the initial sync from the beginning of my Fold usage (e.g. using `sync_fold_data(since="2015-01-01")`).

Let's begin!
```

---

## 🔒 Security & Privacy Notes

- **100% Local**: No transaction data or SQLite databases are ever shared or committed to GitHub.
- **Isolate Databases**: Since SQLite database files run locally on your own machine, your friends' database files will remain 100% isolated on their physical computers, even though you share the same Claude account or repository.
