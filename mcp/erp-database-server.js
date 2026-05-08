/**
 * ERP SQL Server — Model Context Protocol.
 *
 * Modes:
 *   - stdio (default): Cursor / Claude Desktop spawn this process — no CLI flags.
 *   - HTTP+SSE (--http): Express on MCP_PORT / MCP_SSE_PATH for the dashboard API MCP client.
 *
 * Wire Cursor: Command `node`, arg `path/to/mcp/erp-database-server.js` (no --http).
 * Dashboard: spawned by index.js as `node mcp/erp-database-server.js --http`
 */
"use strict";

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
  quiet: true,
});

const path = require("path");
const http = require("http");
const sql = require("mssql");
const z = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { dispatchAgenticTool } = require(path.join(__dirname, "..", "services", "agentic-db-tools.js"));

function envTrim(key) {
  const v = process.env[key];
  if (v == null) return undefined;
  return String(v).trim();
}

function getDbConfig() {
  const requestTimeout = parseInt(process.env.DB_REQUEST_TIMEOUT_MS || "120000", 10);
  const connectTimeout = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || "60000", 10);
  const encryptEnv = String(process.env.DB_ENCRYPT || "")
    .trim()
    .toLowerCase();
  const encrypt = encryptEnv === "1" || encryptEnv === "true" || encryptEnv === "yes";
  return {
    user: envTrim("DB_USER"),
    password: envTrim("DB_PASSWORD"),
    server: envTrim("DB_SERVER"),
    port: parseInt(envTrim("DB_PORT") || "1433", 10),
    database: envTrim("DB_NAME"),
    options: {
      encrypt,
      trustServerCertificate: true,
      requestTimeout: Number.isFinite(requestTimeout) ? requestTimeout : 120000,
      connectTimeout: Number.isFinite(connectTimeout) ? connectTimeout : 60000,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

let poolPromise = null;
async function getPool() {
  const cfg = getDbConfig();
  if (!cfg.server || !cfg.user || cfg.password == null || !cfg.database) {
    throw new Error("Missing DB_SERVER, DB_USER, DB_PASSWORD, or DB_NAME in environment / .env");
  }
  if (!poolPromise) {
    poolPromise = sql.connect(cfg).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/**
 * Registers the five ERP read-only tools on an McpServer instance.
 */
function registerErpTools(mcpServer) {
  mcpServer.registerTool(
    "find_views_for_question",
    {
      description:
        "Rank dbo views by keyword match to the question. Call first. Optional prefer_view boosts a known view.",
      inputSchema: {
        question: z.string().describe("Business question in plain English"),
        prefer_view: z.string().optional().describe("Optional: dbo view name hint, e.g. VwAISalesData"),
      },
    },
    async ({ question, prefer_view }) => {
      const pool = await getPool();
      const out = await dispatchAgenticTool(pool, "find_views_for_question", { question }, question, prefer_view || "");
      return jsonResult(out);
    }
  );

  mcpServer.registerTool(
    "get_view_columns",
    {
      description:
        "Exact columns and types from INFORMATION_SCHEMA.COLUMNS. Call before writing SQL. Multiple views return safe join hints.",
      inputSchema: {
        view_names: z.array(z.string()).min(1).describe("One or more dbo view/table names"),
      },
    },
    async ({ view_names }) => {
      const pool = await getPool();
      const out = await dispatchAgenticTool(pool, "get_view_columns", { view_names }, "", "");
      return jsonResult(out);
    }
  );

  mcpServer.registerTool(
    "get_sample_rows",
    {
      description: "TOP N sample rows from a view to check date formats and categorical values.",
      inputSchema: {
        view_name: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ view_name, limit }) => {
      const pool = await getPool();
      const out = await dispatchAgenticTool(pool, "get_sample_rows", { view_name, limit }, "", "");
      return jsonResult(out);
    }
  );

  mcpServer.registerTool(
    "get_distinct_values",
    {
      description:
        "Distinct values for a column — use before filtering by branch name, supplier, etc.",
      inputSchema: {
        view_name: z.string(),
        column_name: z.string(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ view_name, column_name, limit }) => {
      const pool = await getPool();
      const out = await dispatchAgenticTool(pool, "get_distinct_values", { view_name, column_name, limit }, "", "");
      return jsonResult(out);
    }
  );

  mcpServer.registerTool(
    "run_select",
    {
      description:
        "Execute a single T-SQL SELECT (read-only). Forbidden: DML, DDL, EXEC. Results capped (see server).",
      inputSchema: {
        sql: z.string().describe("T-SQL SELECT only"),
        description: z.string().optional().describe("What the query is meant to return"),
      },
    },
    async (args) => {
      const pool = await getPool();
      const out = await dispatchAgenticTool(pool, "run_select", args, "", "");
      return jsonResult(out);
    }
  );
}

function createConfiguredMcpServer() {
  const mcpServer = new McpServer({
    name: "erp-sql-database",
    version: "1.0.0",
  });
  registerErpTools(mcpServer);
  return mcpServer;
}

async function runStdio() {
  const server = createConfiguredMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function runHttp() {
  const port = parseInt(String(process.env.MCP_PORT || "3001"), 10) || 3001;
  const host = envTrim("MCP_HTTP_HOST") || "127.0.0.1";
  const ssePath = "/mcp";
  const postPath = "/messages";

  const app = createMcpExpressApp({
    host: host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
  });

  const transports = {};

  app.get(ssePath, async (req, res) => {
    try {
      const transport = new SSEServerTransport(postPath, res);
      const sessionId = transport.sessionId;
      transports[String(sessionId)] = transport;

      transport.onclose = () => {
        delete transports[String(sessionId)];
      };

      const server = createConfiguredMcpServer();
      await server.connect(transport);
    } catch (err) {
      console.error("[mcp:http] SSE error:", err.message);
      if (!res.headersSent) res.status(500).send("Error establishing MCP SSE stream");
    }
  });

  app.post(postPath, async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !transports[String(sessionId)]) {
      res.status(400).send("Missing or stale session");
      return;
    }
    try {
      await transports[String(sessionId)].handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error("[mcp:http] POST error:", err.message);
      if (!res.headersSent) res.status(500).send("Error handling MCP message");
    }
  });

  const listener = http.createServer(app).listen(port, host, () => {
    console.log(
      `[mcp:http] MCP HTTP server listening on http://${host}:${port}${ssePath} (SSE POST target: ${postPath})`
    );
  });

  listener.on("error", (err) => {
    console.error("[mcp:http] listen error:", err);
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    for (const id of Object.keys(transports)) {
      try {
        await transports[id].close();
      } catch {
        //
      }
    }
    listener.close(() => process.exit(0));
  });
}

async function main() {
  const useHttp =
    process.argv.includes("--http") ||
    /^1|true|yes$/i.test(String(process.env.ERP_MCP_HTTP || ""));
  const useStdioExplicit = process.argv.includes("--stdio");

  if (useHttp && !useStdioExplicit) {
    runHttp();
    return;
  }
  await runStdio();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
