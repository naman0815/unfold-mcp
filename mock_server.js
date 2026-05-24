const http = require('http');

const transactions = [
  { id: '1', date: '2026-05-20', amount: -450, type: 'debit', category: 'Dining', merchant: 'Coffee Shop' },
  { id: '2', date: '2026-05-21', amount: -1200, type: 'debit', category: 'Groceries', merchant: 'Supermarket' }
];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/transactions') {
    res.end(JSON.stringify({ transactions }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});

server.listen(5001, () => console.log('Mock server on port 5001'));
