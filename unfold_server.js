const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Look for db.sqlite in the current folder, or configure via env
const dbPath = path.resolve(process.env.DB_PATH || 'db.sqlite');

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/transactions') {
    if (!fs.existsSync(dbPath)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `Database file not found at ${dbPath}. Have you run 'unfold transactions -d' yet?` }));
      return;
    }

    try {
      // Query SQLite using pre-installed macOS sqlite3 CLI with -json flag
      const query = "SELECT uuid, amount, timestamp, type, account, merchant, current_balance FROM transactions ORDER BY timestamp DESC;";
      const cmd = `sqlite3 -json "${dbPath}" "${query}"`;
      const output = execSync(cmd).toString().trim();
      
      const transactions = JSON.parse(output || '[]');
      
      // Normalize fields for Fold Companion
      const normalized = transactions.map(t => ({
        id: t.uuid,
        date: t.timestamp,
        amount: t.type === 'INCOMING' ? t.amount : -t.amount,
        type: t.type === 'INCOMING' ? 'credit' : 'debit',
        category: 'General',
        merchant: t.merchant,
        account: t.account
      }));

      res.end(JSON.stringify({ transactions: normalized }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

server.listen(5000, () => {
  console.log(`unfold server running on http://localhost:5000`);
  console.log(`Reading SQLite database from: ${dbPath}`);
});
