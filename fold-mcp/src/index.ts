import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

import { fileURLToPath } from "url";

// ─── Paths ───────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "..", "..", "db.sqlite");
const cliPath = path.resolve(__dirname, "..", "..",
  process.platform === "win32" ? "unfold_patched.exe" : "unfold_patched"
);
const cliDir  = path.resolve(__dirname, "..", "..");

// ─── SQLite (sql.js — pure WASM, no native compilation) ──────────────────────
// eslint-disable-next-line prefer-const
let SQL: SqlJsStatic;
let db: Database;    // main DB loaded from db.sqlite (reloaded after sync)
let ftsDb: Database; // in-memory FTS index (rebuilt at startup and after sync)

function runQuery<T>(query: string, params: any[] = []): Promise<T[]> {
  try {
    const stmt = db.prepare(query);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return Promise.resolve(rows);
  } catch (err) {
    return Promise.reject(err);
  }
}

function runFtsQuery<T>(query: string, params: any[] = []): Promise<T[]> {
  try {
    const stmt = ftsDb.prepare(query);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return Promise.resolve(rows);
  } catch (err) {
    return Promise.reject(err);
  }
}

function runFtsExec(query: string): Promise<void> {
  try {
    ftsDb.exec(query);
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

// ─── FTS index setup ─────────────────────────────────────────────────────────
async function initFts(): Promise<void> {
  await runFtsExec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tx_fts USING fts4(
      uuid, merchant, narration, summary,
      notindexed=uuid,
      tokenize=porter
    )
  `);
  await rebuildFtsIfStale();
}

async function rebuildFtsIfStale(): Promise<void> {
  // Skip gracefully if transactions table doesn't exist yet (pre-first-sync)
  const [tableCheck] = await runQuery<any>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`
  );
  if (!tableCheck) return;

  const [ftsRow]  = await runFtsQuery<any>(`SELECT COUNT(*) as cnt FROM tx_fts`);
  const [mainRow] = await runQuery<any>(`SELECT COUNT(*) as cnt FROM transactions`);
  if ((ftsRow?.cnt ?? 0) >= (mainRow?.cnt ?? 0)) return;

  const rows = await runQuery<any>(
    `SELECT uuid, COALESCE(merchant,'') as merchant,
            COALESCE(narration,'') as narration,
            COALESCE(summary,'') as summary
     FROM transactions`
  );

  ftsDb.exec("DELETE FROM tx_fts");
  ftsDb.exec("BEGIN");
  const stmt = ftsDb.prepare(
    `INSERT INTO tx_fts(uuid, merchant, narration, summary) VALUES (?,?,?,?)`
  );
  for (const r of rows) stmt.run([r.uuid, r.merchant, r.narration, r.summary]);
  stmt.free();
  ftsDb.exec("COMMIT");
  console.error(`FTS index built: ${rows.length} rows`);
}

function toFtsQuery(q: string): string {
  if (/["*]|\b(?:AND|OR|NOT)\b/.test(q)) return q;
  return q.trim().split(/\s+/).filter(Boolean).map((w) => `${w}*`).join(" ");
}

// ─── Merchant name normalisation ─────────────────────────────────────────────
const MERCHANT_OVERRIDES: Record<string, string> = {
  "SWIGGY": "Swiggy", "ZOMATO": "Zomato", "BLINKIT": "Blinkit",
  "ZEPTO": "Zepto", "BIGBASKET": "BigBasket", "DUNZO": "Dunzo",
  "AMAZON": "Amazon", "FLIPKART": "Flipkart", "MYNTRA": "Myntra",
  "AJIO": "AJIO", "NYKAA": "Nykaa", "MEESHO": "Meesho",
  "NETFLIX": "Netflix", "SPOTIFY": "Spotify", "YOUTUBE": "YouTube",
  "HOTSTAR": "Hotstar", "BOOKMYSHOW": "BookMyShow",
  "UBER": "Uber", "OLA": "Ola", "RAPIDO": "Rapido",
  "PHONEPE": "PhonePe", "PAYTM": "Paytm", "GPAY": "Google Pay",
  "GOOGLE PAY": "Google Pay", "CRED": "CRED",
  "ZERODHA": "Zerodha", "GROWW": "Groww", "UPSTOX": "Upstox",
  "HDFC BANK": "HDFC Bank", "ICICI BANK": "ICICI Bank",
  "AXIS BANK": "Axis Bank", "SBI YONO": "SBI (YONO)",
  "KOTAK MAHINDRA": "Kotak Bank", "INDUSIND BANK": "IndusInd Bank",
  "AIRTEL": "Airtel", "JIO": "Jio", "VODAFONE": "Vodafone",
  "IRCTC": "IRCTC", "MAKEMYTRIP": "MakeMyTrip", "REDBUS": "redBus",
};

function cleanMerchant(name: string): string {
  if (!name) return name;
  const trimmed = name.trim();
  const upper   = trimmed.toUpperCase();

  // Exact override
  if (MERCHANT_OVERRIDES[upper]) return MERCHANT_OVERRIDES[upper];

  // Prefix override (e.g. "SWIGGY INSTAMART" → "Swiggy Instamart")
  for (const [key, val] of Object.entries(MERCHANT_OVERRIDES)) {
    if (upper.startsWith(key + " ") || upper.startsWith(key + "_")) {
      const suffix = trimmed.slice(key.length);
      const cleanSuffix = /^[A-Z0-9 _]+$/.test(suffix.trim())
        ? suffix.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : suffix;
      return val + cleanSuffix;
    }
  }

  // Strip legal suffixes
  let out = trimmed
    .replace(/\s+PRIVATE\s+LIMITED$/i, "")
    .replace(/\s+PVT\.?\s*LTD\.?$/i, "")
    .replace(/\s+LIMITED$/i, "")
    .trim();

  // Title-case if still entirely uppercase and longer than 3 chars
  if (out.length > 3 && /^[A-Z0-9 ]+$/.test(out)) {
    out = out.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function truncate(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function fmtAmount(n: number): string {
  return "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function parseTags(raw: string | null): string[] {
  if (!raw || raw === "null") return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function formatTransaction(t: any): string {
  const tags = parseTags(t.tags);
  const tagsStr = tags.length > 0 ? ` [Tags: ${tags.join(", ")}]` : "";
  const merchant = truncate(cleanMerchant(t.merchant || t.narration || "Unknown"));
  const sign = t.type === "INCOMING" ? "+" : "-";
  const modeStr = t.mode ? ` | ${t.mode}` : "";
  return `${(t.timestamp as string).slice(0, 10)} | ${sign}${fmtAmount(t.amount)} | ${merchant}${modeStr}${tagsStr} [ID: ${t.uuid}]`;
}

/** Run a single unfold_patched sync for [from, to] with a per-batch timeout */
function runBatch(from: string, to: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = `"${cliPath}" transactions -d --since "${from}" --till "${to}"`;
    const child = exec(cmd, { cwd: cliDir });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Batch ${from} → ${to} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || stderr) resolve(stderr.trim() || stdout.trim() || "ok");
      else reject(new Error(`Batch ${from} → ${to} exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Split [startDate, endDate] into yearly windows.
 */
function yearlyBatches(startDate: string, endDate: string): { from: string; to: string }[] {
  const batches: { from: string; to: string }[] = [];
  const startYear = new Date(startDate + "T00:00:00Z").getUTCFullYear();
  const endYear   = new Date(endDate   + "T00:00:00Z").getUTCFullYear();
  for (let year = startYear; year <= endYear; year++) {
    const from = year === startYear ? startDate : `${year}-01-01`;
    const to   = year === endYear   ? endDate   : `${year}-12-31`;
    batches.push({ from, to });
  }
  return batches;
}

/**
 * Run batches concurrently with a max concurrency limit.
 * Results are passed to onResult with their original index so callers
 * can reconstruct chronological order regardless of completion order.
 */
async function runBatchesConcurrent(
  batches: { from: string; to: string }[],
  concurrency: number,
  onResult: (index: number, from: string, to: string, result: string | Error) => void
): Promise<void> {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < batches.length) {
      const idx = nextIdx++;
      const { from, to } = batches[idx];
      try {
        const result = await runBatch(from, to);
        onResult(idx, from, to, result);
      } catch (err: any) {
        onResult(idx, from, to, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
}

// ─── Shell helper (for git commands) ─────────────────────────────────────────
function runCommand(cmd: string, cwd: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${cmd}`)); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exit code ${code}`));
    });
  });
}

// ─── Merchant categorisation ──────────────────────────────────────────────────
const CATEGORY_MAP: { category: string; keywords: string[] }[] = [
  { category: "Food Delivery",    keywords: ["swiggy", "zomato"] },
  { category: "Quick Commerce",   keywords: ["blinkit", "zepto", "dunzo", "instamart", "bigbasket", "grofers"] },
  { category: "Transport",        keywords: ["uber", "ola", "rapido", "metro"] },
  { category: "Travel",           keywords: ["irctc", "redbus", "makemytrip", "goibibo", "yatra", "cleartrip", "indigo", "spicejet", "air india", "easemytrip", "airasia", "vistara"] },
  { category: "Entertainment",    keywords: ["netflix", "hotstar", "amazon prime", "spotify", "youtube", "pvr", "inox", "bookmyshow", "disney", "jiocinema"] },
  { category: "Telecom",          keywords: ["airtel", "jio", "vodafone", " vi ", "bsnl", "act broadband"] },
  { category: "Shopping",         keywords: ["amazon", "flipkart", "myntra", "ajio", "nykaa", "meesho", "tatacliq", "snapdeal"] },
  { category: "Health & Fitness", keywords: ["apollo", "1mg", "practo", "netmeds", "medplus", "cult.fit", "gym"] },
  { category: "Investing",        keywords: ["zerodha", "groww", "upstox", "smallcase", "kuvera", "paytm money"] },
  { category: "Education",        keywords: ["udemy", "coursera", "unacademy", "byju", "vedantu", "duolingo"] },
  { category: "Fuel",             keywords: ["petrol", "bpcl", "hpcl", "iocl", "nayara"] },
  { category: "Utilities",        keywords: ["electricity", "water bill", "bescom", "tata power", "adani electricity", "mahanagar gas"] },
];

function categorize(merchant: string): string {
  const lower = merchant.toLowerCase();
  for (const { category, keywords } of CATEGORY_MAP) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return "Other";
}

// ─── Tool Schemas ─────────────────────────────────────────────────────────────
const GET_RECENT_TRANSACTIONS_TOOL: Tool = {
  name: "get_recent_transactions",
  description: "Get the most recent transactions from the user's Fold account.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of transactions to retrieve (max 500).", default: 20 }
    }
  }
};

const SEARCH_TRANSACTIONS_TOOL: Tool = {
  name: "search_transactions",
  description: "Search transactions by merchant, narration, summary description, exact tag, date range, amount range, payment mode, or type.",
  inputSchema: {
    type: "object",
    properties: {
      query:     { type: "string", description: "Text search on merchant name (LIKE match)." },
      narration: { type: "string", description: "Text search on raw bank narration (LIKE match)." },
      summary:   { type: "string", description: "Text search on the natural-language transaction summary (e.g. 'transferred ₹500 to Zepto'). Catches things merchant search misses." },
      tag:       { type: "string", description: "Exact tag match (e.g. 'food'). Uses proper JSON array lookup — more reliable than query for tags." },
      startDate: { type: "string", description: "Filter from this date (YYYY-MM-DD)." },
      endDate:   { type: "string", description: "Filter to this date (YYYY-MM-DD)." },
      type:      { type: "string", description: "Filter by type: INCOMING or OUTGOING." },
      mode:      { type: "string", description: "Filter by payment mode: CARD, OTHERS, UPI, NEFT, etc." },
      minAmount: { type: "number", description: "Minimum transaction amount (absolute value, in ₹)." },
      maxAmount: { type: "number", description: "Maximum transaction amount (absolute value, in ₹)." },
      limit:     { type: "number", description: "Number of results.", default: 50 }
    }
  }
};

const GET_SPENDING_SUMMARY_TOOL: Tool = {
  name: "get_spending_summary",
  description: "Get a breakdown of income vs spending with top merchants and avg daily spend, optionally filtered by date range.",
  inputSchema: {
    type: "object",
    properties: {
      startDate:        { type: "string",  description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:          { type: "string",  description: "End date (YYYY-MM-DD). Defaults to today." },
      excludeTransfers: { type: "boolean", description: "Exclude internal transfers between your own accounts. Default false." }
    }
  }
};

const SYNC_FOLD_DATA_TOOL: Tool = {
  name: "sync_fold_data",
  description:
    "Sync Fold transactions into the local database. Splits the range into yearly batches and runs up to 3 in parallel (~3x faster than sequential). " +
    "Each batch takes ~10s. To sync all history set startDate to your earliest Fold usage (e.g. '2023-01-01') and endDate to today. " +
    "If a batch fails (e.g. expired token), remaining batches continue and failures are reported.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start of sync range (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End of sync range (YYYY-MM-DD). Defaults to today." }
    }
  }
};

const GET_SYNC_STATUS_TOOL: Tool = {
  name: "get_sync_status",
  description: "Check local database freshness: total transactions, date range, and most recent transaction. Call this before querying to confirm data is up to date.",
  inputSchema: { type: "object", properties: {} }
};

const GET_MERCHANT_SUMMARY_TOOL: Tool = {
  name: "get_merchant_summary",
  description: "Get top merchants by total spend or transaction frequency, optionally filtered by date range.",
  inputSchema: {
    type: "object",
    properties: {
      startDate:        { type: "string",  description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:          { type: "string",  description: "End date (YYYY-MM-DD). Defaults to today." },
      limit:            { type: "number",  description: "Number of top merchants to return (max 50).", default: 10 },
      sortBy:           { type: "string",  description: "Sort by 'amount' (total spend, default) or 'count' (frequency)." },
      excludeTransfers: { type: "boolean", description: "Exclude internal transfers between your own accounts. Default false." }
    }
  }
};

const GET_MONTHLY_TREND_TOOL: Tool = {
  name: "get_monthly_trend",
  description: "Get month-by-month income and spending totals with net cash flow. Useful for identifying spending patterns and trends.",
  inputSchema: {
    type: "object",
    properties: {
      startDate:        { type: "string",  description: "Start date (YYYY-MM-DD). Defaults to 12 months ago." },
      endDate:          { type: "string",  description: "End date (YYYY-MM-DD). Defaults to today." },
      excludeTransfers: { type: "boolean", description: "Exclude internal transfers between your own accounts. Default false." }
    }
  }
};

const GET_BALANCE_HISTORY_TOOL: Tool = {
  name: "get_balance_history",
  description: "Get average, min, and max account balance by month. Shows financial trajectory over time.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 12 months ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
    }
  }
};

const GET_SPENDING_BY_MODE_TOOL: Tool = {
  name: "get_spending_by_mode",
  description: "Get spending and income breakdown by payment mode (CARD, UPI, NEFT, OTHERS, etc.), optionally filtered by date range.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
    }
  }
};

const CHECK_FOR_UPDATES_TOOL: Tool = {
  name: "check_for_updates",
  description: "Check if a newer version of fold-mcp is available on GitHub. Fetches from remote and reports how many commits behind you are, with the exact command to update.",
  inputSchema: { type: "object", properties: {} }
};

const GET_WEEKLY_DIGEST_TOOL: Tool = {
  name: "get_weekly_digest",
  description: "7-day spending summary designed for a weekly check-in. Shows total vs your rolling 3-week average, day-by-day breakdown, top merchants, and flags any unusual charges.",
  inputSchema: {
    type: "object",
    properties: {
      weeksBack: { type: "number", description: "Which week to summarize: 0 = last 7 days, 1 = the week before that, etc. Default 0.", default: 0 }
    }
  }
};

const GET_TAX_YEAR_REPORT_TOOL: Tool = {
  name: "get_tax_year_report",
  description: "Full income and spending report for an Indian financial year (April 1 – March 31). Useful for tax filing or year-end review.",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "number", description: "The year the FY starts (e.g. 2024 for FY 2024-25). Defaults to the current or most recently completed FY." }
    }
  }
};

const GET_UNUSUAL_TRANSACTIONS_TOOL: Tool = {
  name: "get_unusual_transactions",
  description: "Find transactions that are unusually large compared to your normal spend at that merchant. Helps catch unexpected charges or billing errors.",
  inputSchema: {
    type: "object",
    properties: {
      startDate:  { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 90 days ago." },
      endDate:    { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      multiplier: { type: "number", description: "Flag transactions this many times above the merchant average. Default 2.5.", default: 2.5 },
      minHistory: { type: "number", description: "Minimum past transactions at the merchant needed to compare against. Default 3.", default: 3 },
      limit:      { type: "number", description: "Max results. Default 20.", default: 20 }
    }
  }
};

const GET_CATEGORY_BREAKDOWN_TOOL: Tool = {
  name: "get_category_breakdown",
  description: "Group spending into categories: Food Delivery, Transport, Shopping, Entertainment, etc. Gives a high-level picture of where your money goes.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
    }
  }
};

const GET_SPENDING_STREAK_TOOL: Tool = {
  name: "get_spending_streak",
  description: "Track your current streak of days where you spent less than a daily threshold. Also shows your longest streak in the lookback window.",
  inputSchema: {
    type: "object",
    properties: {
      threshold: { type: "number", description: "Daily spending limit in ₹ to count as a 'good' day. Default 1000.", default: 1000 },
      lookback:  { type: "number", description: "Days to look back for the longest-streak calculation. Default 90.", default: 90 }
    }
  }
};

const GET_RECURRING_MERCHANTS_TOOL: Tool = {
  name: "get_recurring_merchants",
  description: "Find merchants you pay regularly month after month — subscriptions, habits, recurring bills. Shows how many months each appeared and your average spend.",
  inputSchema: {
    type: "object",
    properties: {
      startDate:  { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 12 months ago." },
      endDate:    { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      minMonths:  { type: "number", description: "Minimum distinct months a merchant must appear to be listed. Default 3.", default: 3 },
      limit:      { type: "number", description: "Max results. Default 20.", default: 20 }
    }
  }
};

const COMPARE_PERIODS_TOOL: Tool = {
  name: "compare_periods",
  description: "Compare spending side-by-side across two date ranges. Shows income, spending, net, avg daily spend, and % change between periods.",
  inputSchema: {
    type: "object",
    properties: {
      period1Start:     { type: "string",  description: "Start of period 1 (YYYY-MM-DD). Defaults to first day of this month." },
      period1End:       { type: "string",  description: "End of period 1 (YYYY-MM-DD). Defaults to today." },
      period2Start:     { type: "string",  description: "Start of period 2 (YYYY-MM-DD). Defaults to first day of last month." },
      period2End:       { type: "string",  description: "End of period 2 (YYYY-MM-DD). Defaults to last day of last month." },
      excludeTransfers: { type: "boolean", description: "Exclude internal transfers. Default false." }
    }
  }
};

const GET_SPENDING_FORECAST_TOOL: Tool = {
  name: "get_spending_forecast",
  description: "Project where your spending will land by end of month, based on your pace so far. Compares to last month's actual.",
  inputSchema: {
    type: "object",
    properties: {
      excludeTransfers: { type: "boolean", description: "Exclude internal transfers from the forecast. Default false." }
    }
  }
};

const GET_ACCOUNT_BREAKDOWN_TOOL: Tool = {
  name: "get_account_breakdown",
  description: "Break down spending and income by bank account. You have 4 accounts — this shows which account does what.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
    }
  }
};

const GET_DAY_OF_WEEK_PATTERNS_TOOL: Tool = {
  name: "get_day_of_week_patterns",
  description: "See which days of the week (or days of the month) you spend the most and least. Surfaces patterns like 'you spend 3x more on Saturdays' or 'salary-day spikes on the 1st'.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 90 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      groupBy:   { type: "string", description: "'weekday' (default) or 'monthday'." }
    }
  }
};

const FULL_TEXT_SEARCH_TOOL: Tool = {
  name: "full_text_search",
  description: "Fast full-text search across merchant name, bank narration, and the natural-language transaction summary. Supports partial words, multi-term queries, and boolean operators (AND, OR, NOT). Use this when you need to find a transaction by any word in its description — e.g. 'coffee', 'salary HDFC', 'zomato NOT swiggy'.",
  inputSchema: {
    type: "object",
    properties: {
      query:     { type: "string", description: "Search terms. Partial words are matched automatically (e.g. 'swi' matches 'Swiggy'). Use AND/OR/NOT for boolean logic. Use quotes for phrases." },
      startDate: { type: "string", description: "Filter results from this date (YYYY-MM-DD)." },
      endDate:   { type: "string", description: "Filter results to this date (YYYY-MM-DD)." },
      limit:     { type: "number", description: "Max results. Default 30.", default: 30 }
    },
    required: ["query"]
  }
};

// ─── Server ───────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "fold-mcp", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    GET_RECENT_TRANSACTIONS_TOOL,
    SEARCH_TRANSACTIONS_TOOL,
    GET_SPENDING_SUMMARY_TOOL,
    SYNC_FOLD_DATA_TOOL,
    GET_SYNC_STATUS_TOOL,
    GET_MERCHANT_SUMMARY_TOOL,
    GET_MONTHLY_TREND_TOOL,
    GET_BALANCE_HISTORY_TOOL,
    GET_SPENDING_BY_MODE_TOOL,
    CHECK_FOR_UPDATES_TOOL,
    GET_WEEKLY_DIGEST_TOOL,
    GET_TAX_YEAR_REPORT_TOOL,
    GET_UNUSUAL_TRANSACTIONS_TOOL,
    GET_CATEGORY_BREAKDOWN_TOOL,
    GET_SPENDING_STREAK_TOOL,
    GET_RECURRING_MERCHANTS_TOOL,
    COMPARE_PERIODS_TOOL,
    GET_SPENDING_FORECAST_TOOL,
    GET_ACCOUNT_BREAKDOWN_TOOL,
    GET_DAY_OF_WEEK_PATTERNS_TOOL,
    FULL_TEXT_SEARCH_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    // ── get_recent_transactions ─────────────────────────────────────────────
    if (request.params.name === "get_recent_transactions") {
      const limit = Math.min(Number(request.params.arguments?.limit ?? 20), 500);
      const rows = await runQuery(
        `SELECT uuid, amount, timestamp, type, merchant, narration, mode, tags
         FROM transactions ORDER BY timestamp DESC LIMIT ?`,
        [limit]
      );
      return {
        content: [{ type: "text", text: rows.map(formatTransaction).join("\n") || "No transactions found." }]
      };
    }

    // ── search_transactions ─────────────────────────────────────────────────
    if (request.params.name === "search_transactions") {
      const query     = request.params.arguments?.query     as string | undefined;
      const narration = request.params.arguments?.narration as string | undefined;
      const summary   = request.params.arguments?.summary   as string | undefined;
      const tag       = request.params.arguments?.tag       as string | undefined;
      const startDate = request.params.arguments?.startDate as string | undefined;
      const endDate   = request.params.arguments?.endDate   as string | undefined;
      const type      = request.params.arguments?.type      as string | undefined;
      const mode      = request.params.arguments?.mode      as string | undefined;
      const minAmount = request.params.arguments?.minAmount as number | undefined;
      const maxAmount = request.params.arguments?.maxAmount as number | undefined;
      const limit     = Math.min(Number(request.params.arguments?.limit ?? 50), 500);

      const conditions: string[] = [];
      const params: any[] = [];

      if (query)     { conditions.push("merchant LIKE ?");              params.push(`%${query}%`); }
      if (narration) { conditions.push("narration LIKE ?");             params.push(`%${narration}%`); }
      if (summary)   { conditions.push("summary LIKE ?");               params.push(`%${summary}%`); }
      if (startDate) { conditions.push("date(timestamp) >= ?");         params.push(startDate); }
      if (endDate)   { conditions.push("date(timestamp) <= ?");         params.push(endDate); }
      if (type)      { conditions.push("type = ?");                     params.push(type.toUpperCase()); }
      if (mode)      { conditions.push("mode = ?");                     params.push(mode.toUpperCase()); }
      if (minAmount !== undefined) { conditions.push("amount >= ?");    params.push(minAmount); }
      if (maxAmount !== undefined) { conditions.push("amount <= ?");    params.push(maxAmount); }

      // Exact tag match via json_each — guarded so malformed/null tags don't error
      if (tag) {
        conditions.push(
          "tags IS NOT NULL AND tags != '' AND tags != 'null' AND json_valid(tags)" +
          " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)"
        );
        params.push(tag.toLowerCase().trim());
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      const rows = await runQuery(
        `SELECT uuid, amount, timestamp, type, merchant, narration, mode, tags
         FROM transactions ${where} ORDER BY timestamp DESC LIMIT ?`,
        params
      );
      return {
        content: [{ type: "text", text: rows.map(formatTransaction).join("\n") || "No transactions matched." }]
      };
    }

    // ── get_spending_summary ────────────────────────────────────────────────
    if (request.params.name === "get_spending_summary") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate       = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate         = (request.params.arguments?.endDate   as string) || today;
      const excludeTransfers = Boolean(request.params.arguments?.excludeTransfers);
      const xferClause       = excludeTransfers ? " AND excluded_from_cash_flow = 0" : "";

      const [summary] = await runQuery<any>(
        `SELECT
           SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as total_incoming,
           SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing,
           COUNT(*) as tx_count,
           AVG(CASE WHEN type = 'OUTGOING' THEN amount END) as avg_spend
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?${xferClause}`,
        [startDate, endDate]
      );

      const topMerchants = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''${xferClause}
         GROUP BY merchant ORDER BY total DESC LIMIT 5`,
        [startDate, endDate]
      );

      const msPerDay = 864e5;
      const days = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / msPerDay) + 1);
      const incoming = summary.total_incoming || 0;
      const outgoing = summary.total_outgoing || 0;
      const xferNote = excludeTransfers ? " (transfers excluded)" : "";

      let text = `Spending summary (${startDate} → ${endDate})${xferNote}:\n` +
        `- Total Incoming:   ${fmtAmount(incoming)}\n` +
        `- Total Outgoing:   ${fmtAmount(outgoing)}\n` +
        `- Net:              ${outgoing <= incoming ? "+" : ""}${fmtAmount(incoming - outgoing)}\n` +
        `- Transactions:     ${summary.tx_count || 0}\n` +
        `- Avg Daily Spend:  ${fmtAmount(outgoing / days)}\n`;

      if (topMerchants.length > 0) {
        text += `\nTop 5 merchants by spend:\n`;
        topMerchants.forEach((m: any, i: number) => {
          text += `  ${i + 1}. ${truncate(m.merchant, 35)} — ${fmtAmount(m.total)} (${m.cnt} txns)\n`;
        });
      }

      return { content: [{ type: "text", text }] };
    }

    // ── sync_fold_data ──────────────────────────────────────────────────────
    if (request.params.name === "sync_fold_data") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const batches = yearlyBatches(startDate, endDate);
      const CONCURRENCY = 3;
      const estimatedSecs = Math.ceil(batches.length / CONCURRENCY) * 10;

      const lines: string[] = [
        `📅 Syncing ${batches.length} yearly batch${batches.length === 1 ? "" : "es"} (${startDate} → ${endDate})`,
        `   Up to ${CONCURRENCY} batches in parallel — estimated ~${estimatedSecs}s`,
        ""
      ];

      // Pre-allocate result slots to preserve chronological display order
      const results: { label: string; ok: boolean; detail: string }[] = new Array(batches.length);
      let successCount = 0;
      let failCount = 0;

      await runBatchesConcurrent(batches, CONCURRENCY, (idx, from, to, result) => {
        const label = `Batch ${idx + 1}/${batches.length}: ${from} → ${to}`;
        if (result instanceof Error) {
          results[idx] = { label, ok: false, detail: result.message };
          failCount++;
        } else {
          const detail = result !== "ok" ? result.split("\n")[0] : "";
          results[idx] = { label, ok: true, detail };
          successCount++;
        }
      });

      for (const r of results) {
        lines.push(r.ok ? `✅ ${r.label}` : `❌ ${r.label} — ${r.detail}`);
        if (r.ok && r.detail) lines.push(`   ${r.detail}`);
      }

      lines.push("");
      if (failCount > 0 && failCount === batches.length) {
        lines.push(`All batches failed. Your session token may have expired — run the unfold login command to re-authenticate, then sync again.`);
      } else {
        lines.push(`Done: ${successCount} succeeded, ${failCount} failed out of ${batches.length} batches.`);
      }

      if (successCount > 0) {
        try {
          const buf = fs.readFileSync(dbPath);
          db.close();
          db = new SQL.Database(buf);
          ftsDb.exec("DELETE FROM tx_fts");
          rebuildFtsIfStale().catch(() => {});
        } catch { /* non-fatal — data visible after next restart */ }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── get_sync_status ─────────────────────────────────────────────────────
    if (request.params.name === "get_sync_status") {
      const [stats] = await runQuery<any>(
        `SELECT COUNT(*) as total,
                MIN(date(timestamp)) as earliest,
                MAX(date(timestamp)) as latest,
                COUNT(DISTINCT date(timestamp)) as days_covered
         FROM transactions`
      );

      const [recent] = await runQuery<any>(
        `SELECT merchant, narration, amount, type, timestamp, mode
         FROM transactions ORDER BY timestamp DESC LIMIT 1`
      );

      const today = new Date().toISOString().slice(0, 10);
      const daysSinceSync = recent
        ? Math.floor((new Date(today).getTime() - new Date((recent.timestamp as string).slice(0, 10)).getTime()) / 864e5)
        : null;

      const freshness =
        daysSinceSync === null ? "no data" :
        daysSinceSync === 0    ? "✅ up to date (synced today)" :
        daysSinceSync === 1    ? "⚠️  synced yesterday" :
                                 `⚠️  last transaction ${daysSinceSync} days ago — consider syncing`;

      let text = `Database status:\n` +
        `- Total transactions: ${(stats.total as number).toLocaleString()}\n` +
        `- Date range: ${stats.earliest || "none"} → ${stats.latest || "none"}\n` +
        `- Days with data: ${stats.days_covered}\n` +
        `- Freshness: ${freshness}\n`;

      if (recent) {
        const merchant = truncate(recent.merchant || recent.narration || "Unknown", 35);
        const sign = recent.type === "INCOMING" ? "+" : "-";
        text += `- Most recent: ${(recent.timestamp as string).slice(0, 10)} | ${sign}${fmtAmount(recent.amount)} | ${merchant} | ${recent.mode || "—"}\n`;
      }

      return { content: [{ type: "text", text }] };
    }

    // ── get_merchant_summary ────────────────────────────────────────────────
    if (request.params.name === "get_merchant_summary") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate       = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate         = (request.params.arguments?.endDate   as string) || today;
      const limit           = Math.min(Number(request.params.arguments?.limit ?? 10), 50);
      const sortCol         = (request.params.arguments?.sortBy as string) === "count" ? "cnt" : "total";
      const excludeTransfers = Boolean(request.params.arguments?.excludeTransfers);
      const xferClause       = excludeTransfers ? " AND excluded_from_cash_flow = 0" : "";

      const rows = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt, AVG(amount) as avg
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''${xferClause}
         GROUP BY merchant ORDER BY ${sortCol} DESC LIMIT ?`,
        [startDate, endDate, limit]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No outgoing transactions found from ${startDate} to ${endDate}.` }] };
      }

      const sortLabel = sortCol === "cnt" ? "frequency" : "total spend";
      const xferNote  = excludeTransfers ? " (transfers excluded)" : "";
      let text = `Top merchants by ${sortLabel} (${startDate} → ${endDate})${xferNote}:\n\n`;
      rows.forEach((r: any, i: number) => {
        text += `${i + 1}. ${truncate(cleanMerchant(r.merchant), 45)}\n`;
        text += `   ${fmtAmount(r.total)} total | ${r.cnt} txn${r.cnt === 1 ? "" : "s"} | ${fmtAmount(r.avg)} avg\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── get_monthly_trend ───────────────────────────────────────────────────
    if (request.params.name === "get_monthly_trend") {
      const today           = new Date().toISOString().slice(0, 10);
      const twelveMonthsAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      const startDate        = (request.params.arguments?.startDate as string) || twelveMonthsAgo;
      const endDate          = (request.params.arguments?.endDate   as string) || today;
      const excludeTransfers = Boolean(request.params.arguments?.excludeTransfers);
      const xferClause       = excludeTransfers ? " AND excluded_from_cash_flow = 0" : "";

      const rows = await runQuery<any>(
        `SELECT strftime('%Y-%m', timestamp) as month,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                COUNT(*) as tx_count
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?${xferClause}
         GROUP BY month ORDER BY month ASC`,
        [startDate, endDate]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No transactions found from ${startDate} to ${endDate}.` }] };
      }

      const pad = (s: string, w: number) => s.padStart(w);
      const xferNote = excludeTransfers ? " (transfers excluded)" : "";
      let text = `Monthly trend (${startDate} → ${endDate})${xferNote}:\n\n`;
      text += `Month    | Income        | Spending      | Net           | Txns\n`;
      text += `---------|---------------|---------------|---------------|----- \n`;

      let totalIn = 0, totalOut = 0;
      rows.forEach((r: any) => {
        totalIn  += r.incoming;
        totalOut += r.outgoing;
        const net = r.incoming - r.outgoing;
        const netStr = (net >= 0 ? "+" : "") + fmtAmount(net);
        text += `${r.month}  | ${pad(fmtAmount(r.incoming), 13)} | ${pad(fmtAmount(r.outgoing), 13)} | ${pad(netStr, 13)} | ${r.tx_count}\n`;
      });

      text += `---------|---------------|---------------|---------------|----- \n`;
      const totalNet = totalIn - totalOut;
      text += `TOTAL    | ${pad(fmtAmount(totalIn), 13)} | ${pad(fmtAmount(totalOut), 13)} | ${pad((totalNet >= 0 ? "+" : "") + fmtAmount(totalNet), 13)} |\n`;

      return { content: [{ type: "text", text }] };
    }

    // ── get_balance_history ─────────────────────────────────────────────────
    if (request.params.name === "get_balance_history") {
      const today          = new Date().toISOString().slice(0, 10);
      const twelveMonthsAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || twelveMonthsAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT strftime('%Y-%m', timestamp) as month,
                ROUND(AVG(current_balance), 0)  as avg_balance,
                ROUND(MIN(current_balance), 0)  as min_balance,
                ROUND(MAX(current_balance), 0)  as max_balance
         FROM transactions
         WHERE current_balance > 0
           AND date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY month ORDER BY month ASC`,
        [startDate, endDate]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No balance data found from ${startDate} to ${endDate}. The current_balance field may not be populated for your account type.` }] };
      }

      const pad = (s: string, w: number) => s.padStart(w);
      let text = `Balance history (${startDate} → ${endDate}):\n`;
      text += `Note: avg/min/max computed from individual transaction snapshots.\n\n`;
      text += `Month    | Avg Balance   | Min           | Max\n`;
      text += `---------|---------------|---------------|---------------\n`;
      rows.forEach((r: any) => {
        text += `${r.month}  | ${pad(fmtAmount(r.avg_balance), 13)} | ${pad(fmtAmount(r.min_balance), 13)} | ${pad(fmtAmount(r.max_balance), 13)}\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── get_spending_by_mode ────────────────────────────────────────────────
    if (request.params.name === "get_spending_by_mode") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT COALESCE(NULLIF(mode, ''), 'UNKNOWN') as mode,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                COUNT(*) as tx_count
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY mode ORDER BY outgoing DESC`,
        [startDate, endDate]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No transactions found from ${startDate} to ${endDate}.` }] };
      }

      const totalOut = rows.reduce((s: number, r: any) => s + r.outgoing, 0);
      let text = `Spending by payment mode (${startDate} → ${endDate}):\n\n`;
      rows.forEach((r: any) => {
        const pct = totalOut > 0 ? ((r.outgoing / totalOut) * 100).toFixed(1) : "0.0";
        text += `${r.mode.padEnd(8)} | Out: ${fmtAmount(r.outgoing).padStart(12)} (${pct.padStart(5)}%) | In: ${fmtAmount(r.incoming).padStart(12)} | ${r.tx_count} txns\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── check_for_updates ───────────────────────────────────────────────────
    if (request.params.name === "check_for_updates") {
      try {
        await runCommand("git fetch origin", cliDir);
      } catch (e: any) {
        return { content: [{ type: "text", text: `Could not reach remote: ${e.message}\nMake sure you have internet access and git configured.` }] };
      }

      try {
        const currentDesc = await runCommand("git describe --tags --always HEAD", cliDir).catch(
          () => runCommand("git rev-parse --short HEAD", cliDir)
        );
        const upstream = await runCommand("git rev-parse --abbrev-ref --symbolic-full-name @{u}", cliDir)
          .catch(() => "origin/main");
        const behindStr = await runCommand(`git rev-list HEAD..${upstream} --count`, cliDir);
        const behind = parseInt(behindStr, 10);

        if (behind === 0) {
          return { content: [{ type: "text", text: `✅ Already up to date (${currentDesc})` }] };
        }

        const log = await runCommand(`git log HEAD..${upstream} --oneline --max-count=10`, cliDir);
        let text = `⬆️  ${behind} new commit${behind === 1 ? "" : "s"} available (you're on ${currentDesc}):\n\n`;
        text += log + "\n";
        if (behind > 10) text += `  … and ${behind - 10} more\n`;
        text += `\nTo update:\n  git pull\n  cd fold-mcp && npm run build`;
        return { content: [{ type: "text", text }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Update check failed: ${e.message}` }] };
      }
    }

    // ── get_weekly_digest ───────────────────────────────────────────────────
    if (request.params.name === "get_weekly_digest") {
      const weeksBack = Math.max(0, Math.min(Number(request.params.arguments?.weeksBack ?? 0), 52));
      const today = new Date();

      const weekEndMs   = today.getTime() - weeksBack * 7 * 864e5;
      const weekEndStr   = new Date(weekEndMs).toISOString().slice(0, 10);
      const weekStartStr = new Date(weekEndMs - 6 * 864e5).toISOString().slice(0, 10);

      // Baseline: 3 prior weeks for rolling average
      const baselineEndStr   = new Date(weekEndMs - 7 * 864e5).toISOString().slice(0, 10);
      const baselineStartStr = new Date(weekEndMs - 4 * 7 * 864e5).toISOString().slice(0, 10);

      const weekRows = await runQuery<any>(
        `SELECT date(timestamp) as day,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY day ORDER BY day ASC`,
        [weekStartStr, weekEndStr]
      );

      const [baseline] = await runQuery<any>(
        `SELECT SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?`,
        [baselineStartStr, baselineEndStr]
      );

      const topMerchants = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''
         GROUP BY merchant ORDER BY total DESC LIMIT 5`,
        [weekStartStr, weekEndStr]
      );

      const ninetyDaysAgo = new Date(today.getTime() - 90 * 864e5).toISOString().slice(0, 10);
      const unusualRows = await runQuery<any>(
        `SELECT t.timestamp, t.merchant, t.amount, stats.avg_amount,
                ROUND(CAST(t.amount AS REAL) / stats.avg_amount, 1) as multiplier
         FROM transactions t
         JOIN (
           SELECT merchant, AVG(amount) as avg_amount, COUNT(*) as tx_count
           FROM transactions
           WHERE type = 'OUTGOING' AND merchant IS NOT NULL AND merchant != ''
             AND date(timestamp) >= ?
           GROUP BY merchant HAVING COUNT(*) >= 3
         ) stats ON t.merchant = stats.merchant
         WHERE t.type = 'OUTGOING'
           AND date(t.timestamp) >= ? AND date(t.timestamp) <= ?
           AND t.amount >= stats.avg_amount * 2.5
         ORDER BY multiplier DESC LIMIT 5`,
        [ninetyDaysAgo, weekStartStr, weekEndStr]
      );

      const weekDayMap = new Map<string, { outgoing: number; incoming: number }>();
      let weekOutgoing = 0, weekIncoming = 0;
      for (const r of weekRows) {
        weekDayMap.set(r.day, r);
        weekOutgoing += r.outgoing;
        weekIncoming += r.incoming;
      }

      const avgWeeklySpend = (baseline.total_outgoing ?? 0) / 3;
      const vsAvg = avgWeeklySpend > 0
        ? (((weekOutgoing - avgWeeklySpend) / avgWeeklySpend) * 100).toFixed(0)
        : null;

      const label = weeksBack === 0 ? "This week" : `Week of ${weekStartStr}`;
      let text = `Weekly digest — ${label} (${weekStartStr} → ${weekEndStr})\n`;
      text += "─".repeat(55) + "\n\n";
      text += `Total spending:   ${fmtAmount(weekOutgoing)}`;
      if (vsAvg !== null) {
        const sign = Number(vsAvg) >= 0 ? "+" : "";
        text += `  (${sign}${vsAvg}% vs 3-week avg of ${fmtAmount(avgWeeklySpend)})`;
      }
      text += `\nTotal income:     ${fmtAmount(weekIncoming)}\n`;
      text += `Avg daily spend:  ${fmtAmount(weekOutgoing / 7)}\n\n`;

      text += `Day-by-day:\n`;
      const cur = new Date(weekStartStr + "T00:00:00Z");
      const wEnd = new Date(weekEndStr + "T00:00:00Z");
      while (cur <= wEnd) {
        const d = cur.toISOString().slice(0, 10);
        const out = weekDayMap.get(d)?.outgoing ?? 0;
        const bar = out > 0 ? "▓".repeat(Math.min(Math.round(out / 500), 20)) : "·";
        text += `  ${d}  ${fmtAmount(out).padStart(10)}  ${bar}\n`;
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      if (topMerchants.length > 0) {
        text += `\nTop merchants:\n`;
        topMerchants.forEach((m: any, i: number) => {
          text += `  ${i + 1}. ${truncate(cleanMerchant(m.merchant), 35).padEnd(37)} ${fmtAmount(m.total)}  (${m.cnt} txns)\n`;
        });
      }

      if (unusualRows.length > 0) {
        text += `\n⚠️  Unusual charges this week:\n`;
        unusualRows.forEach((r: any) => {
          text += `  ${(r.timestamp as string).slice(0, 10)} | ${fmtAmount(r.amount)} | ${truncate(r.merchant, 30)} — ${r.multiplier}x your usual ${fmtAmount(r.avg_amount)}\n`;
        });
      }

      return { content: [{ type: "text", text }] };
    }

    // ── get_tax_year_report ─────────────────────────────────────────────────
    if (request.params.name === "get_tax_year_report") {
      const today = new Date();
      const currentMonth = today.getMonth() + 1;
      const currentYear  = today.getFullYear();
      const defaultFYStart = currentMonth >= 4 ? currentYear : currentYear - 1;
      const fyStartYear = Number(request.params.arguments?.year ?? defaultFYStart);

      const startDate = `${fyStartYear}-04-01`;
      const endDate   = `${fyStartYear + 1}-03-31`;
      const fyLabel   = `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;

      const [summary] = await runQuery<any>(
        `SELECT SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as total_incoming,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing,
                COUNT(*) as tx_count
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?`,
        [startDate, endDate]
      );

      const monthRows = await runQuery<any>(
        `SELECT strftime('%Y-%m', timestamp) as month,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY month ORDER BY month ASC`,
        [startDate, endDate]
      );

      const topMerchants = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''
         GROUP BY merchant ORDER BY total DESC LIMIT 10`,
        [startDate, endDate]
      );

      const incoming = summary.total_incoming || 0;
      const outgoing = summary.total_outgoing || 0;
      const savings  = incoming - outgoing;
      const savingsRate = incoming > 0 ? ((savings / incoming) * 100).toFixed(1) : "N/A";
      const isComplete = today.toISOString().slice(0, 10) > endDate;
      const completionNote = isComplete ? "" : ` (in progress — FY ends ${endDate})`;

      let text = `${fyLabel} Report${completionNote}\n`;
      text += "─".repeat(50) + "\n\n";
      text += `Total income:    ${fmtAmount(incoming)}\n`;
      text += `Total spending:  ${fmtAmount(outgoing)}\n`;
      text += `Net savings:     ${savings >= 0 ? "+" : ""}${fmtAmount(savings)}\n`;
      text += `Savings rate:    ${savingsRate}%\n`;
      text += `Transactions:    ${(summary.tx_count as number).toLocaleString()}\n\n`;

      if (monthRows.length > 0) {
        text += `Month-by-month:\n`;
        for (const r of monthRows) {
          const net = r.incoming - r.outgoing;
          const pad = (s: string) => s.padStart(12);
          text += `  ${r.month}  In: ${pad(fmtAmount(r.incoming))}  Out: ${pad(fmtAmount(r.outgoing))}  Net: ${pad((net >= 0 ? "+" : "") + fmtAmount(net))}\n`;
        }
        text += "\n";
      }

      if (topMerchants.length > 0) {
        text += `Top 10 merchants by spend:\n`;
        topMerchants.forEach((m: any, i: number) => {
          const pct = outgoing > 0 ? ((m.total / outgoing) * 100).toFixed(1) : "0.0";
          text += `  ${String(i + 1).padStart(2)}. ${truncate(m.merchant, 35).padEnd(37)} ${fmtAmount(m.total).padStart(12)} (${pct}%)\n`;
        });
      }

      return { content: [{ type: "text", text }] };
    }

    // ── get_unusual_transactions ────────────────────────────────────────────
    if (request.params.name === "get_unusual_transactions") {
      const today         = new Date().toISOString().slice(0, 10);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
      const startDate  = (request.params.arguments?.startDate  as string) || ninetyDaysAgo;
      const endDate    = (request.params.arguments?.endDate    as string) || today;
      const multiplier = Number(request.params.arguments?.multiplier ?? 2.5);
      const minHistory = Number(request.params.arguments?.minHistory ?? 3);
      const limit      = Math.min(Number(request.params.arguments?.limit ?? 20), 100);

      const rows = await runQuery<any>(
        `SELECT t.uuid, t.timestamp, t.merchant, t.amount,
                stats.avg_amount, stats.tx_count,
                ROUND(CAST(t.amount AS REAL) / stats.avg_amount, 1) as multiplier
         FROM transactions t
         JOIN (
           SELECT merchant, AVG(amount) as avg_amount, COUNT(*) as tx_count
           FROM transactions
           WHERE type = 'OUTGOING' AND merchant IS NOT NULL AND merchant != ''
             AND date(timestamp) >= ? AND date(timestamp) <= ?
           GROUP BY merchant HAVING COUNT(*) >= ?
         ) stats ON t.merchant = stats.merchant
         WHERE t.type = 'OUTGOING'
           AND date(t.timestamp) >= ? AND date(t.timestamp) <= ?
           AND t.amount >= stats.avg_amount * ?
         ORDER BY multiplier DESC
         LIMIT ?`,
        [startDate, endDate, minHistory, startDate, endDate, multiplier, limit]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No unusual transactions found (${startDate} → ${endDate}, threshold: ${multiplier}x above average, min ${minHistory} past transactions).` }] };
      }

      let text = `Unusual transactions (${startDate} → ${endDate}) — above ${multiplier}x merchant average:\n\n`;
      rows.forEach((r: any) => {
        text += `${(r.timestamp as string).slice(0, 10)} | ${fmtAmount(r.amount)} | ${truncate(r.merchant, 35)}\n`;
        text += `   ${r.multiplier}x your usual ${fmtAmount(r.avg_amount)} avg (based on ${r.tx_count} transactions)\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── get_category_breakdown ──────────────────────────────────────────────
    if (request.params.name === "get_category_breakdown") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions
         WHERE type = 'OUTGOING' AND merchant IS NOT NULL AND merchant != ''
           AND date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY merchant`,
        [startDate, endDate]
      );

      interface CatData { total: number; count: number; merchantAmounts: Map<string, number> }
      const cats = new Map<string, CatData>();
      let grandTotal = 0;

      for (const r of rows) {
        const cat = categorize(r.merchant as string);
        if (!cats.has(cat)) cats.set(cat, { total: 0, count: 0, merchantAmounts: new Map() });
        const d = cats.get(cat)!;
        d.total += r.total;
        d.count += r.cnt;
        d.merchantAmounts.set(r.merchant, (d.merchantAmounts.get(r.merchant) ?? 0) + r.total);
        grandTotal += r.total;
      }

      const sorted = [...cats.entries()].sort((a, b) => b[1].total - a[1].total);

      let text = `Category breakdown (${startDate} → ${endDate}):\n\n`;
      for (const [cat, d] of sorted) {
        const pct = grandTotal > 0 ? ((d.total / grandTotal) * 100).toFixed(1) : "0.0";
        text += `${cat.padEnd(20)} ${fmtAmount(d.total).padStart(12)}  (${pct.padStart(5)}%)  ${d.count} txns\n`;
        const top3 = [...d.merchantAmounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([m]) => truncate(m, 20))
          .join(", ");
        text += `  └─ ${top3}\n`;
      }
      text += `\n${"TOTAL".padEnd(20)} ${fmtAmount(grandTotal).padStart(12)}\n`;

      return { content: [{ type: "text", text }] };
    }

    // ── get_spending_streak ─────────────────────────────────────────────────
    if (request.params.name === "get_spending_streak") {
      const threshold = Number(request.params.arguments?.threshold ?? 1000);
      const lookback  = Math.min(Number(request.params.arguments?.lookback ?? 90), 365);

      const today = new Date();
      const todayStr  = today.toISOString().slice(0, 10);
      const startDate = new Date(today.getTime() - lookback * 864e5).toISOString().slice(0, 10);

      const rows = await runQuery<any>(
        `SELECT date(timestamp) as day, SUM(amount) as total
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY day`,
        [startDate, todayStr]
      );

      const spendMap = new Map<string, number>();
      for (const r of rows) spendMap.set(r.day as string, r.total as number);

      // Build ordered list of all dates in range
      const allDates: string[] = [];
      const cur = new Date(startDate + "T00:00:00Z");
      const end = new Date(todayStr + "T00:00:00Z");
      while (cur <= end) {
        allDates.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      // Current streak (from today backwards)
      let currentStreak = 0;
      for (let i = allDates.length - 1; i >= 0; i--) {
        if ((spendMap.get(allDates[i]) ?? 0) <= threshold) currentStreak++;
        else break;
      }

      // Longest streak in the period
      let longestStreak = 0, run = 0;
      for (const d of allDates) {
        if ((spendMap.get(d) ?? 0) <= threshold) { run++; if (run > longestStreak) longestStreak = run; }
        else run = 0;
      }

      const threshFmt = fmtAmount(threshold);
      let text = `Spending streak (days under ${threshFmt}/day):\n\n`;
      text += `Current streak:       ${currentStreak} day${currentStreak !== 1 ? "s" : ""}\n`;
      text += `Longest in ${lookback} days:  ${longestStreak} day${longestStreak !== 1 ? "s" : ""}\n`;

      if (currentStreak >= 7)      text += `\n🔥 A full week-long streak — solid!`;
      else if (currentStreak >= 3) text += `\n💪 ${currentStreak} days in a row.`;
      else if (currentStreak === 0) text += `\nToday was over ${threshFmt}.`;

      text += `\n\nLast 7 days:\n`;
      for (const d of allDates.slice(-7)) {
        const spend = spendMap.get(d) ?? 0;
        text += `  ${spend <= threshold ? "✅" : "❌"} ${d}  ${fmtAmount(spend)}\n`;
      }

      return { content: [{ type: "text", text }] };
    }

    // ── get_recurring_merchants ─────────────────────────────────────────────
    if (request.params.name === "get_recurring_merchants") {
      const today          = new Date().toISOString().slice(0, 10);
      const twelveMonthsAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || twelveMonthsAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;
      const minMonths = Number(request.params.arguments?.minMonths ?? 3);
      const limit     = Math.min(Number(request.params.arguments?.limit ?? 20), 100);

      const rows = await runQuery<any>(
        `SELECT merchant,
                COUNT(DISTINCT strftime('%Y-%m', timestamp)) as months_active,
                COUNT(*) as total_transactions,
                ROUND(AVG(amount), 0) as avg_amount,
                SUM(amount) as total_spent,
                MIN(date(timestamp)) as first_seen,
                MAX(date(timestamp)) as last_seen
         FROM transactions
         WHERE type = 'OUTGOING'
           AND merchant IS NOT NULL AND merchant != ''
           AND date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY merchant
         HAVING COUNT(DISTINCT strftime('%Y-%m', timestamp)) >= ?
         ORDER BY months_active DESC, avg_amount DESC
         LIMIT ?`,
        [startDate, endDate, minMonths, limit]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No recurring merchants found (${startDate} → ${endDate}, min ${minMonths} months).` }] };
      }

      let text = `Recurring merchants (${startDate} → ${endDate}, appearing in ${minMonths}+ months):\n\n`;
      rows.forEach((r: any, i: number) => {
        text += `${i + 1}. ${truncate(cleanMerchant(r.merchant), 40)}\n`;
        text += `   ${r.months_active} months | ${fmtAmount(r.avg_amount)}/time avg | ${fmtAmount(r.total_spent)} total | ${r.total_transactions} txns\n`;
        text += `   Active: ${r.first_seen} → ${r.last_seen}\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── compare_periods ─────────────────────────────────────────────────────
    if (request.params.name === "compare_periods") {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);

      // Default period 1: this month so far
      const thisMonthStart = `${todayStr.slice(0, 7)}-01`;
      // Default period 2: full previous month
      const prevMonthDate  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevMonthStart = prevMonthDate.toISOString().slice(0, 7) + "-01";
      const prevMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

      const p1Start         = (request.params.arguments?.period1Start as string) || thisMonthStart;
      const p1End           = (request.params.arguments?.period1End   as string) || todayStr;
      const p2Start         = (request.params.arguments?.period2Start as string) || prevMonthStart;
      const p2End           = (request.params.arguments?.period2End   as string) || prevMonthEnd;
      const excludeTransfers = Boolean(request.params.arguments?.excludeTransfers);
      const xferClause       = excludeTransfers ? " AND excluded_from_cash_flow = 0" : "";

      async function periodStats(start: string, end: string) {
        const [s] = await runQuery<any>(
          `SELECT SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                  SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                  COUNT(*) as tx_count
           FROM transactions
           WHERE date(timestamp) >= ? AND date(timestamp) <= ?${xferClause}`,
          [start, end]
        );
        const days = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 864e5) + 1);
        return { incoming: s.incoming || 0, outgoing: s.outgoing || 0, tx_count: s.tx_count || 0, days };
      }

      const [p1, p2] = await Promise.all([periodStats(p1Start, p1End), periodStats(p2Start, p2End)]);

      function pctChange(a: number, b: number): string {
        if (b === 0) return "N/A";
        const pct = ((a - b) / b * 100).toFixed(0);
        return (Number(pct) >= 0 ? "+" : "") + pct + "%";
      }

      const xferNote = excludeTransfers ? " (transfers excluded)" : "";
      let text = `Period comparison${xferNote}:\n\n`;
      const col1 = `${p1Start} → ${p1End}`.padEnd(26);
      const col2 = `${p2Start} → ${p2End}`.padEnd(26);
      text += `                       ${col1}  ${col2}  Change\n`;
      text += `${"─".repeat(90)}\n`;

      const rows2 = [
        ["Spending",    fmtAmount(p1.outgoing),        fmtAmount(p2.outgoing),        pctChange(p1.outgoing, p2.outgoing)],
        ["Income",      fmtAmount(p1.incoming),        fmtAmount(p2.incoming),        pctChange(p1.incoming, p2.incoming)],
        ["Net",         (p1.incoming - p1.outgoing >= 0 ? "+" : "") + fmtAmount(p1.incoming - p1.outgoing),
                        (p2.incoming - p2.outgoing >= 0 ? "+" : "") + fmtAmount(p2.incoming - p2.outgoing), ""],
        ["Avg/day",     fmtAmount(p1.outgoing / p1.days), fmtAmount(p2.outgoing / p2.days), pctChange(p1.outgoing / p1.days, p2.outgoing / p2.days)],
        ["Transactions",String(p1.tx_count),            String(p2.tx_count),            pctChange(p1.tx_count, p2.tx_count)],
      ];

      for (const [label, v1, v2, chg] of rows2) {
        text += `${label.padEnd(15)} ${v1.padStart(18)}  ${v2.padStart(26)}  ${chg}\n`;
      }

      return { content: [{ type: "text", text }] };
    }

    // ── get_spending_forecast ────────────────────────────────────────────────
    if (request.params.name === "get_spending_forecast") {
      const excludeTransfers = Boolean(request.params.arguments?.excludeTransfers);
      const xferClause       = excludeTransfers ? " AND excluded_from_cash_flow = 0" : "";

      const today = new Date();
      const todayStr       = today.toISOString().slice(0, 10);
      const monthStart     = `${todayStr.slice(0, 7)}-01`;
      const dayOfMonth     = today.getDate();
      const daysInMonth    = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

      // Previous month
      const prevMonthDate  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevStart      = prevMonthDate.toISOString().slice(0, 7) + "-01";
      const prevEnd        = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

      const [[current], [prev]] = await Promise.all([
        runQuery<any>(
          `SELECT SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                  SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming
           FROM transactions
           WHERE date(timestamp) >= ? AND date(timestamp) <= ?${xferClause}`,
          [monthStart, todayStr]
        ),
        runQuery<any>(
          `SELECT SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing
           FROM transactions
           WHERE date(timestamp) >= ? AND date(timestamp) <= ?${xferClause}`,
          [prevStart, prevEnd]
        ),
      ]);

      const spentSoFar  = current.outgoing || 0;
      const incomeSoFar = current.incoming || 0;
      const projected   = dayOfMonth > 0 ? Math.round((spentSoFar / dayOfMonth) * daysInMonth) : 0;
      const lastMonth   = prev.outgoing || 0;
      const vsLastMonth = lastMonth > 0 ? (((projected - lastMonth) / lastMonth) * 100).toFixed(0) : null;

      const xferNote = excludeTransfers ? " (transfers excluded)" : "";
      let text = `Spending forecast — ${todayStr.slice(0, 7)}${xferNote}:\n\n`;
      text += `Day ${dayOfMonth} of ${daysInMonth}\n\n`;
      text += `Spent so far:    ${fmtAmount(spentSoFar)}\n`;
      text += `Income so far:   ${fmtAmount(incomeSoFar)}\n`;
      text += `Projected total: ${fmtAmount(projected)}`;
      if (vsLastMonth !== null) {
        const sign = Number(vsLastMonth) >= 0 ? "+" : "";
        text += `  (${sign}${vsLastMonth}% vs last month's ${fmtAmount(lastMonth)})`;
      }
      text += `\n\nDaily pace:      ${fmtAmount(Math.round(spentSoFar / dayOfMonth))}/day\n`;
      text += `Remaining days:  ${daysInMonth - dayOfMonth}\n`;
      text += `Budget to stay flat: ${fmtAmount(Math.max(0, lastMonth - spentSoFar))} left to match last month\n`;

      return { content: [{ type: "text", text }] };
    }

    // ── get_account_breakdown ────────────────────────────────────────────────
    if (request.params.name === "get_account_breakdown") {
      const today         = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT account_id,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                COUNT(*) as tx_count,
                MAX(date(timestamp)) as last_activity
         FROM transactions
         WHERE account_id IS NOT NULL AND account_id != ''
           AND date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY account_id
         ORDER BY outgoing DESC`,
        [startDate, endDate]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No transactions with account data found from ${startDate} to ${endDate}.` }] };
      }

      let text = `Account breakdown (${startDate} → ${endDate}):\n`;
      text += `(Accounts shown by UUID — label them once you identify which is which)\n\n`;
      rows.forEach((r: any, i: number) => {
        const net = r.incoming - r.outgoing;
        const shortId = (r.account_id as string).slice(0, 8) + "…";
        text += `Account ${i + 1}  [${shortId}]\n`;
        text += `  Spending:  ${fmtAmount(r.outgoing)}\n`;
        text += `  Income:    ${fmtAmount(r.incoming)}\n`;
        text += `  Net:       ${net >= 0 ? "+" : ""}${fmtAmount(net)}\n`;
        text += `  Txns:      ${r.tx_count}  |  Last active: ${r.last_activity}\n\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── get_day_of_week_patterns ─────────────────────────────────────────────
    if (request.params.name === "get_day_of_week_patterns") {
      const today        = new Date().toISOString().slice(0, 10);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || ninetyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;
      const groupBy   = (request.params.arguments?.groupBy   as string) === "monthday" ? "monthday" : "weekday";

      if (groupBy === "weekday") {
        const rows = await runQuery<any>(
          `SELECT strftime('%w', timestamp) as dow,
                  COUNT(DISTINCT date(timestamp)) as days_sampled,
                  SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_out,
                  COUNT(CASE WHEN type = 'OUTGOING' THEN 1 END) as tx_count
           FROM transactions
           WHERE date(timestamp) >= ? AND date(timestamp) <= ?
           GROUP BY dow ORDER BY dow`,
          [startDate, endDate]
        );

        const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const allDow = Array.from({ length: 7 }, (_, i) => {
          const r = rows.find((row: any) => Number(row.dow) === i);
          return { label: DOW_LABELS[i], days: r?.days_sampled ?? 0, total: r?.total_out ?? 0, txns: r?.tx_count ?? 0 };
        });

        const avgPerDay = allDow.map(d => d.days > 0 ? d.total / d.days : 0);
        const maxAvg    = Math.max(...avgPerDay, 1);

        let text = `Day-of-week spending patterns (${startDate} → ${endDate}):\n\n`;
        allDow.forEach((d, i) => {
          const avg = avgPerDay[i];
          const bar = avg > 0 ? "█".repeat(Math.round((avg / maxAvg) * 15)) : "·";
          text += `${d.label.padEnd(10)} ${fmtAmount(avg).padStart(10)}/day  ${bar}\n`;
        });

        const maxDay = allDow.reduce((a, b, i) => avgPerDay[i] > avgPerDay[a] ? i : a, 0);
        const minDay = allDow.filter((_, i) => avgPerDay[i] > 0).reduce((a, b, i) => {
          const ri = allDow.indexOf(allDow.filter((_, j) => avgPerDay[j] > 0)[i]);
          return avgPerDay[ri] < avgPerDay[a] ? ri : a;
        }, maxDay);

        if (avgPerDay[minDay] > 0 && avgPerDay[maxDay] > avgPerDay[minDay]) {
          const ratio = (avgPerDay[maxDay] / avgPerDay[minDay]).toFixed(1);
          text += `\nYou spend ${ratio}x more on ${allDow[maxDay].label}s than ${allDow[minDay].label}s.`;
        }

        return { content: [{ type: "text", text }] };
      } else {
        // Day of month
        const rows = await runQuery<any>(
          `SELECT CAST(strftime('%d', timestamp) AS INTEGER) as dom,
                  COUNT(DISTINCT date(timestamp)) as days_sampled,
                  SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_out
           FROM transactions
           WHERE date(timestamp) >= ? AND date(timestamp) <= ?
           GROUP BY dom ORDER BY dom`,
          [startDate, endDate]
        );

        const maxTotal = Math.max(...rows.map((r: any) => r.total_out), 1);
        let text = `Day-of-month spending patterns (${startDate} → ${endDate}):\n\n`;
        rows.forEach((r: any) => {
          const bar = r.total_out > 0 ? "█".repeat(Math.round((r.total_out / maxTotal) * 15)) : "·";
          text += `Day ${String(r.dom).padStart(2)}  ${fmtAmount(r.total_out / r.days_sampled).padStart(10)}/day  ${bar}\n`;
        });

        return { content: [{ type: "text", text }] };
      }
    }

    // ── full_text_search ─────────────────────────────────────────────────────
    if (request.params.name === "full_text_search") {
      const query     = (request.params.arguments?.query as string) || "";
      const startDate = request.params.arguments?.startDate as string | undefined;
      const endDate   = request.params.arguments?.endDate   as string | undefined;
      const limit     = Math.min(Number(request.params.arguments?.limit ?? 30), 200);

      if (!query.trim()) {
        return { content: [{ type: "text", text: "Please provide a search query." }] };
      }

      let uuids: string[];

      try {
        const ftsQ = toFtsQuery(query);
        const ftsRows = await runFtsQuery<any>(
          `SELECT uuid FROM tx_fts WHERE tx_fts MATCH ? ORDER BY rank LIMIT ?`,
          [ftsQ, limit * 3]
        );
        uuids = ftsRows.map((r: any) => r.uuid as string);
      } catch {
        // FTS unavailable — fall back to LIKE search across all three text columns
        const like = `%${query}%`;
        const fallbackRows = await runQuery<any>(
          `SELECT uuid FROM transactions
           WHERE (merchant LIKE ? OR narration LIKE ? OR summary LIKE ?)
           ORDER BY timestamp DESC LIMIT ?`,
          [like, like, like, limit]
        );
        uuids = fallbackRows.map((r: any) => r.uuid as string);
      }

      if (!uuids.length) {
        return { content: [{ type: "text", text: `No transactions matched "${query}".` }] };
      }

      // Fetch full rows from main DB, apply date filters, preserve FTS ranking order
      const placeholders = uuids.map(() => "?").join(",");
      const dateConditions: string[] = [];
      const dateParams: any[] = [];
      if (startDate) { dateConditions.push("date(timestamp) >= ?"); dateParams.push(startDate); }
      if (endDate)   { dateConditions.push("date(timestamp) <= ?"); dateParams.push(endDate); }
      const dateWhere = dateConditions.length ? ` AND ${dateConditions.join(" AND ")}` : "";

      const rows = await runQuery<any>(
        `SELECT uuid, amount, timestamp, type, merchant, narration, mode, tags
         FROM transactions
         WHERE uuid IN (${placeholders})${dateWhere}`,
        [...uuids, ...dateParams]
      );

      // Re-sort by FTS rank (uuids order) then by date within same rank
      const uuidRank = new Map(uuids.map((id, i) => [id, i]));
      rows.sort((a: any, b: any) => {
        const rankDiff = (uuidRank.get(a.uuid) ?? 999) - (uuidRank.get(b.uuid) ?? 999);
        if (rankDiff !== 0) return rankDiff;
        return (b.timestamp as string).localeCompare(a.timestamp as string);
      });

      const displayed = rows.slice(0, limit);
      const note = rows.length > limit ? `\n(showing top ${limit} of ${rows.length} matches)` : "";
      const dateNote = (startDate || endDate) ? ` | date filter: ${startDate ?? "any"} → ${endDate ?? "any"}` : "";

      return {
        content: [{
          type: "text",
          text: `Full-text search: "${query}"${dateNote} — ${displayed.length} result${displayed.length !== 1 ? "s" : ""}${note}\n\n` +
                displayed.map(formatTransaction).join("\n")
        }]
      };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  // @ts-ignore — sql.js types don't expose the module-level assignment correctly
  SQL = await initSqlJs();

  try {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch {
    // db.sqlite doesn't exist yet (first run before any sync)
    db = new SQL.Database();
  }

  ftsDb = new SQL.Database();
  await initFts();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fold MCP Server v6.0.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
