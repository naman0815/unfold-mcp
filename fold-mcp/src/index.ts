import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from "sqlite3";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import z from "zod";

import { fileURLToPath } from "url";

const execAsync = promisify(exec);

// Path to the db.sqlite. Compute relative to this file's location (build/index.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "..", "..", "db.sqlite");
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

// Promisify SQLite queries
function runQuery<T>(query: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

// Format transactions for the AI
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

const server = new Server(
  {
    name: "fold-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const GET_RECENT_TRANSACTIONS_TOOL: Tool = {
  name: "get_recent_transactions",
  description: "Get the most recent transactions from the user's Fold account.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of transactions to retrieve (max 100).",
        default: 20
      }
    }
  }
};

const SEARCH_TRANSACTIONS_TOOL: Tool = {
  name: "search_transactions",
  description: "Search transactions by merchant name, tags, or type.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query (e.g. 'Amazon', 'trip', 'groceries')."
      },
      limit: {
        type: "number",
        description: "Number of results to return.",
        default: 20
      }
    },
    required: ["query"]
  }
};

const GET_SPENDING_SUMMARY_TOOL: Tool = {
  name: "get_spending_summary",
  description: "Get a summary of incoming and outgoing spending over the last N days.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Number of days to look back.",
        default: 30
      }
    }
  }
};

const SYNC_FOLD_DATA_TOOL: Tool = {
  name: "sync_fold_data",
  description: "Fetch the latest transactions from the Fold API to update the local database.",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "Date to fetch from in YYYY-MM-DD format. E.g., '2020-01-01' for all history."
      }
    }
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    GET_RECENT_TRANSACTIONS_TOOL,
    SEARCH_TRANSACTIONS_TOOL,
    GET_SPENDING_SUMMARY_TOOL,
    SYNC_FOLD_DATA_TOOL
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "get_recent_transactions") {
      const limit = Math.min(Number(request.params.arguments?.limit || 20), 500);
      const rows = await runQuery(`SELECT uuid, amount, timestamp, type, merchant, tags FROM transactions ORDER BY timestamp DESC LIMIT ?`, [limit]);
      
      const formatted = rows.map(formatTransaction).join("\n");
      return {
        content: [{ type: "text", text: formatted || "No transactions found." }]
      };
    }

    if (request.params.name === "search_transactions") {
      const query = String(request.params.arguments?.query || "");
      const limit = Math.min(Number(request.params.arguments?.limit || 20), 500);
      
      const sqlQuery = `
        SELECT uuid, amount, timestamp, type, merchant, tags 
        FROM transactions 
        WHERE merchant LIKE ? OR tags LIKE ? 
        ORDER BY timestamp DESC LIMIT ?`;
      
      const searchParam = `%${query}%`;
      const rows = await runQuery(sqlQuery, [searchParam, searchParam, limit]);
      
      const formatted = rows.map(formatTransaction).join("\n");
      return {
        content: [{ type: "text", text: formatted || "No transactions matched your search." }]
      };
    }

    if (request.params.name === "get_spending_summary") {
      const days = Number(request.params.arguments?.days || 30);
      
      const sqlQuery = `
        SELECT 
          SUM(CASE WHEN type = 'INCOMING' THEN amount ELSE 0 END) as total_incoming,
          SUM(CASE WHEN type = 'OUTGOING' THEN amount ELSE 0 END) as total_outgoing,
          COUNT(*) as tx_count
        FROM transactions 
        WHERE timestamp >= datetime('now', ? || ' days')
      `;
      
      const rows = await runQuery<any>(sqlQuery, [`-${days}`]);
      const summary = rows[0];
      
      const text = `Summary for the last ${days} days:
- Total Incoming: ₹${summary.total_incoming || 0}
- Total Outgoing: ₹${summary.total_outgoing || 0}
- Transaction Count: ${summary.tx_count || 0}`;

      return {
        content: [{ type: "text", text }]
      };
    }

    if (request.params.name === "sync_fold_data") {
      const since = request.params.arguments?.since ? String(request.params.arguments.since) : null;
      let cmdStr = "transactions -d";
      if (since) {
        cmdStr += ` --since "${since}"`;
      }
      
      const cliPath = path.resolve(__dirname, "..", "..", "unfold_patched");
      const { stdout, stderr } = await execAsync(`${cliPath} ${cmdStr}`, {
        cwd: path.resolve(__dirname, "..", "..")
      });
      
      return {
        content: [{ type: "text", text: `Successfully synced Fold data.\nLogs:\n${stderr || stdout}` }]
      };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error executing tool: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fold MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
