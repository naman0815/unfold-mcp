import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from "sqlite3";
import { exec } from "child_process";
import path from "path";

import { fileURLToPath } from "url";

// ─── Paths ───────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "..", "..", "db.sqlite");
const cliPath = path.resolve(__dirname, "..", "..",
  process.platform === "win32" ? "unfold_patched.exe" : "unfold_patched"
);
const cliDir  = path.resolve(__dirname, "..", "..");

// ─── SQLite ───────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

function runQuery<T>(query: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
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
  const merchant = truncate(t.merchant || t.narration || "Unknown");
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
  description: "Search transactions by merchant, narration, exact tag, date range, amount range, payment mode, or type.",
  inputSchema: {
    type: "object",
    properties: {
      query:     { type: "string", description: "Text search on merchant name (LIKE match)." },
      narration: { type: "string", description: "Text search on raw bank narration (LIKE match)." },
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
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
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
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      limit:     { type: "number", description: "Number of top merchants to return (max 50).", default: 10 },
      sortBy:    { type: "string", description: "Sort by 'amount' (total spend, default) or 'count' (frequency)." }
    }
  }
};

const GET_MONTHLY_TREND_TOOL: Tool = {
  name: "get_monthly_trend",
  description: "Get month-by-month income and spending totals with net cash flow. Useful for identifying spending patterns and trends.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 12 months ago." },
      endDate:   { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." }
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

// ─── Server ───────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "fold-mcp", version: "3.0.0" },
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
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const [summary] = await runQuery<any>(
        `SELECT
           SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as total_incoming,
           SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing,
           COUNT(*) as tx_count,
           AVG(CASE WHEN type = 'OUTGOING' THEN amount END) as avg_spend
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?`,
        [startDate, endDate]
      );

      const topMerchants = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''
         GROUP BY merchant ORDER BY total DESC LIMIT 5`,
        [startDate, endDate]
      );

      const msPerDay = 864e5;
      const days = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / msPerDay) + 1);
      const incoming = summary.total_incoming || 0;
      const outgoing = summary.total_outgoing || 0;

      let text = `Spending summary (${startDate} → ${endDate}):\n` +
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
      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;
      const limit     = Math.min(Number(request.params.arguments?.limit ?? 10), 50);
      const sortCol   = (request.params.arguments?.sortBy as string) === "count" ? "cnt" : "total";

      const rows = await runQuery<any>(
        `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt, AVG(amount) as avg
         FROM transactions
         WHERE type = 'OUTGOING' AND date(timestamp) >= ? AND date(timestamp) <= ?
           AND merchant IS NOT NULL AND merchant != ''
         GROUP BY merchant ORDER BY ${sortCol} DESC LIMIT ?`,
        [startDate, endDate, limit]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No outgoing transactions found from ${startDate} to ${endDate}.` }] };
      }

      const sortLabel = sortCol === "cnt" ? "frequency" : "total spend";
      let text = `Top merchants by ${sortLabel} (${startDate} → ${endDate}):\n\n`;
      rows.forEach((r: any, i: number) => {
        text += `${i + 1}. ${truncate(r.merchant, 45)}\n`;
        text += `   ${fmtAmount(r.total)} total | ${r.cnt} txn${r.cnt === 1 ? "" : "s"} | ${fmtAmount(r.avg)} avg\n`;
      });

      return { content: [{ type: "text", text }] };
    }

    // ── get_monthly_trend ───────────────────────────────────────────────────
    if (request.params.name === "get_monthly_trend") {
      const today          = new Date().toISOString().slice(0, 10);
      const twelveMonthsAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      const startDate = (request.params.arguments?.startDate as string) || twelveMonthsAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT strftime('%Y-%m', timestamp) as month,
                SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as incoming,
                SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as outgoing,
                COUNT(*) as tx_count
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?
         GROUP BY month ORDER BY month ASC`,
        [startDate, endDate]
      );

      if (!rows.length) {
        return { content: [{ type: "text", text: `No transactions found from ${startDate} to ${endDate}.` }] };
      }

      const pad = (s: string, w: number) => s.padStart(w);
      let text = `Monthly trend (${startDate} → ${endDate}):\n\n`;
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

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fold MCP Server v3.0.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
