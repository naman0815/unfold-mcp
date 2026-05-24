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
import z from "zod";

import { fileURLToPath } from "url";

// ─── Paths ───────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "..", "..", "db.sqlite");
const cliPath = path.resolve(__dirname, "..", "..", "unfold_patched");
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
function formatTransaction(t: any) {
  let tags = "";
  try {
    if (t.tags && t.tags !== "null") {
      const arr = JSON.parse(t.tags);
      if (Array.isArray(arr) && arr.length > 0) tags = ` [Tags: ${arr.join(", ")}]`;
    }
  } catch (e) {}
  const amtStr = `₹${Math.abs(t.amount)}`;
  const sign = t.type === "INCOMING" ? "+" : "-";
  return `ID: ${t.uuid} | Date: ${t.timestamp} | ${sign}${amtStr} | Merchant: ${t.merchant || "Unknown"}${tags}`;
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
 * Each year completes in ~10s regardless of transaction volume,
 * so yearly batches are the optimal batch size.
 * Returns array of { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
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
  description: "Search transactions by merchant name, tags, date range, or type.",
  inputSchema: {
    type: "object",
    properties: {
      query:     { type: "string", description: "Text search on merchant name or tags." },
      startDate: { type: "string", description: "Filter from this date (YYYY-MM-DD)." },
      endDate:   { type: "string", description: "Filter to this date (YYYY-MM-DD)." },
      type:      { type: "string", description: "Filter by type: INCOMING or OUTGOING." },
      limit:     { type: "number", description: "Number of results.", default: 50 }
    }
  }
};

const GET_SPENDING_SUMMARY_TOOL: Tool = {
  name: "get_spending_summary",
  description: "Get a breakdown of income and spending, optionally filtered by date range.",
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
    "Sync Fold transactions into the local database in yearly batches. " +
    "Use startDate + endDate to specify the full range — each year takes ~10s. " +
    "To sync all history, set startDate to your earliest Fold usage date (e.g. '2020-01-01') and endDate to today. " +
    "If a batch fails (e.g. due to an expired token), the rest continue and the failure is reported.",
  inputSchema: {
    type: "object",
    properties: {
      startDate: {
        type: "string",
        description: "Start of sync range (YYYY-MM-DD). Defaults to 30 days ago."
      },
      endDate: {
        type: "string",
        description: "End of sync range (YYYY-MM-DD). Defaults to today."
      }
    }
  }
};

// ─── Server ───────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "fold-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    GET_RECENT_TRANSACTIONS_TOOL,
    SEARCH_TRANSACTIONS_TOOL,
    GET_SPENDING_SUMMARY_TOOL,
    SYNC_FOLD_DATA_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    // ── get_recent_transactions ─────────────────────────────────────────────
    if (request.params.name === "get_recent_transactions") {
      const limit = Math.min(Number(request.params.arguments?.limit ?? 20), 500);
      const rows = await runQuery(
        `SELECT uuid, amount, timestamp, type, merchant, tags
         FROM transactions ORDER BY timestamp DESC LIMIT ?`,
        [limit]
      );
      return {
        content: [{ type: "text", text: rows.map(formatTransaction).join("\n") || "No transactions found." }]
      };
    }

    // ── search_transactions ─────────────────────────────────────────────────
    if (request.params.name === "search_transactions") {
      const query     = String(request.params.arguments?.query ?? "");
      const startDate = request.params.arguments?.startDate as string | undefined;
      const endDate   = request.params.arguments?.endDate   as string | undefined;
      const type      = request.params.arguments?.type      as string | undefined;
      const limit     = Math.min(Number(request.params.arguments?.limit ?? 50), 500);

      const conditions: string[] = [];
      const params: any[] = [];

      if (query) {
        conditions.push("(merchant LIKE ? OR tags LIKE ?)");
        params.push(`%${query}%`, `%${query}%`);
      }
      if (startDate) { conditions.push("date(timestamp) >= ?"); params.push(startDate); }
      if (endDate)   { conditions.push("date(timestamp) <= ?"); params.push(endDate);   }
      if (type)      { conditions.push("type = ?");             params.push(type.toUpperCase()); }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      const rows = await runQuery(
        `SELECT uuid, amount, timestamp, type, merchant, tags
         FROM transactions ${where} ORDER BY timestamp DESC LIMIT ?`,
        params
      );
      return {
        content: [{ type: "text", text: rows.map(formatTransaction).join("\n") || "No transactions matched." }]
      };
    }

    // ── get_spending_summary ────────────────────────────────────────────────
    if (request.params.name === "get_spending_summary") {
      const today = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const rows = await runQuery<any>(
        `SELECT
           SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as total_incoming,
           SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing,
           COUNT(*) as tx_count
         FROM transactions
         WHERE date(timestamp) >= ? AND date(timestamp) <= ?`,
        [startDate, endDate]
      );
      const s = rows[0];
      return {
        content: [{
          type: "text",
          text: `Spending summary (${startDate} → ${endDate}):\n` +
                `- Total Incoming: ₹${(s.total_incoming || 0).toLocaleString()}\n` +
                `- Total Outgoing: ₹${(s.total_outgoing || 0).toLocaleString()}\n` +
                `- Transaction Count: ${s.tx_count || 0}`
        }]
      };
    }

    // ── sync_fold_data ──────────────────────────────────────────────────────
    if (request.params.name === "sync_fold_data") {
      const today = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

      const startDate = (request.params.arguments?.startDate as string) || thirtyDaysAgo;
      const endDate   = (request.params.arguments?.endDate   as string) || today;

      const batches = yearlyBatches(startDate, endDate);
      const lines: string[] = [
        `📅 Syncing ${batches.length} yearly batch${batches.length === 1 ? "" : "es"} from ${startDate} → ${endDate} (~${batches.length * 10}s estimated)`,
        `   Each year takes ~10s. Sit tight...`,
        ""
      ];

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < batches.length; i++) {
        const { from, to } = batches[i];
        const label = `Batch ${i + 1}/${batches.length}: ${from} → ${to}`;
        try {
          const result = await runBatch(from, to);
          lines.push(`✅ ${label}`);
          if (result && result !== "ok") lines.push(`   ${result.split("\n")[0]}`); // first log line only
          successCount++;
        } catch (err: any) {
          lines.push(`❌ ${label} — ${err.message}`);
          failCount++;
        }
      }

      lines.push("");
      lines.push(`Done: ${successCount} succeeded, ${failCount} failed out of ${batches.length} batches.`);

      return {
        content: [{ type: "text", text: lines.join("\n") }]
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fold MCP Server v2.0.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
