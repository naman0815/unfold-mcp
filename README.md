# Fold Companion — Setup Guide

A local PWA that connects to your Fold app expenses via unfold and lets you chat with Claude about your spending.

---

## What you need

1. **Fold app** on iOS (you already have this)
2. **unfold** running locally on your Mac/PC — it reads Fold's local SQLite DB
3. A **Claude API key** — get one at console.anthropic.com
4. A way to serve the PWA locally (e.g. `npx serve`)

---

## Step 1: Run the unfold server

Clone one of these (check which fork has the best support for your Fold version):

```bash
# Original
git clone https://github.com/wantguns/unfold

# Or a fork — check GitHub for recently updated forks:
# https://github.com/wantguns/unfold/forks?sort=stargazers
```

Follow the fork's README to:
- Point it at your Fold SQLite database
- Start the local HTTP server (usually `python app.py` or `npm start`)
- Note the port it runs on (commonly 5000 or 8000)

Test it works:
```bash
curl http://localhost:5000/transactions
# Should return JSON array of your transactions
```

---

## Step 2: Serve the PWA

In the `fold-companion/` folder:

```bash
# Option A: npx (no install needed)
npx serve .

# Option B: Python
python3 -m http.server 3000

# Option C: Node http-server
npx http-server . -p 3000 --cors
```

Then open: `http://localhost:3000` in Safari on your iPhone (same WiFi network) or on your Mac.

---

## Step 3: Configure the app

1. Tap the **⚙ settings** button (top right)
2. Paste your **Claude API key** (`sk-ant-...`)
3. Set the **unfold server URL** — if on iPhone, use your Mac's local IP:
   ```
   http://192.168.x.x:5000
   ```
   (Find your Mac's IP: System Settings → Network, or `ipconfig getifaddr en0`)
4. Set the **API path** to whatever endpoint your unfold fork uses (e.g. `/transactions`, `/expenses`, `/api/transactions`)
5. Hit **Save**, then **Sync now**

---

## Step 4 (optional): Install as PWA on iPhone

1. Open the PWA URL in Safari on iPhone
2. Tap the Share button → **Add to Home Screen**
3. Now it runs like a native app, full screen

---

## Mapping your unfold fork's fields

The app auto-normalizes common field names. If your fork uses different names, edit the `normalizeTransactions()` function in `index.html`:

```js
list = list.map(t => ({
  date:     t.date || t.created_at || t.YOUR_DATE_FIELD,
  amount:   parseFloat(t.amount || t.YOUR_AMOUNT_FIELD || 0),
  type:     t.type || (t.debit ? 'debit' : 'credit'),
  category: t.category || t.YOUR_CATEGORY_FIELD || 'Uncategorized',
  merchant: t.merchant || t.description || t.narration || 'Unknown',
}));
```

---

## CORS

If the unfold server blocks requests from the PWA origin, you have two options:

**A)** Add a CORS header to unfold (edit the server code):
```python
# Flask example
from flask_cors import CORS
CORS(app)
```

**B)** Serve both the PWA and unfold from localhost on the same origin (less common).

---

## Cost estimate

Claude Sonnet 4 pricing (as of mid-2025):
- Each query sends ~2–4k tokens of expense context
- Typical usage: ~50 queries/month ≈ **< $0.50/month**

---

## Privacy

- Your API key is stored in `localStorage` only — never transmitted anywhere except `api.anthropic.com`
- Your transaction data is sent to Claude as part of each query (this is how it understands your expenses)
- No data is stored server-side; the app is fully local
- Consider Anthropic's [privacy policy](https://www.anthropic.com/privacy) re: API data handling

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach unfold server" | Check server is running; use Mac IP not localhost when on iPhone |
| CORS error in browser console | Add CORS headers to unfold server (see above) |
| Empty transactions list | Check the API path — try `/`, `/api/transactions`, `/expenses` |
| API key error | Ensure key starts with `sk-ant-` and has credits |
| Data looks wrong | Edit `normalizeTransactions()` to match your fork's field names |
