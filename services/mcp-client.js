"use strict";

/**
 * MCP client for ERP DB tools — connects to local HTTP+SSE MCP server.
 * Serialized per exclusive queue — one SSE session; concurrent agent runs would collide otherwise.
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

function getSSEUrlRaw() {
  return String(process.env.MCP_SSE_URL || "http://127.0.0.1:3001/mcp").trim();
}

function getSSEURL() {
  return new URL(getSSEUrlRaw());
}

let connectedClient = null;
let connectingPromise = null;
let openAIToolsCache = null;
let disconnected = false;

/** Serialize access to MCP (single SSE connection). */
let exclusiveChain = Promise.resolve();
function enqueueExclusive(fn) {
  const result = exclusiveChain.then(() => fn());
  exclusiveChain = result.then(
    () => {},
    () => {}
  );
  return result;
}

function resetConnection() {
  disconnected = true;
  openAIToolsCache = null;
}

async function connectOnce() {
  const transport = new SSEClientTransport(getSSEURL());
  const client = new Client({ name: "erp-api-agentic", version: "1.0.0" });
  disconnected = false;
  await client.connect(transport);
  connectedClient = client;
  openAIToolsCache = null;
}

async function ensureConnectedInner() {
  if (connectedClient && !disconnected) return connectedClient;

  let lastErr = null;
  const retries = Math.max(
    1,
    parseInt(String(process.env.MCP_CLIENT_CONNECT_RETRIES || "25"), 10) || 25
  );
  const delayMs = Math.max(
    50,
    parseInt(String(process.env.MCP_CLIENT_CONNECT_DELAY_MS || "250"), 10) || 250
  );

  for (let i = 0; i < retries; i++) {
    try {
      await connectOnce();
      return connectedClient;
    } catch (e) {
      lastErr = e;
      connectingPromise = null;
      connectedClient = null;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  connectingPromise = null;
  throw lastErr || new Error("MCP connect failed");
}

/**
 * Obtain a connected Client; single-flight while connecting.
 */
async function ensureConnected() {
  if (connectedClient && !disconnected) return connectedClient;
  if (!connectingPromise) {
    connectingPromise = ensureConnectedInner().finally(() => {
      connectingPromise = null;
    });
  }
  return connectingPromise;
}

/**
 * Normalize MCP JSON Schema-ish inputSchema to OpenAI `parameters`.
 */
function mcpSchemaToParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const o = { ...inputSchema };
  if (!o.type) o.type = "object";
  return o;
}

/**
 * @returns {Promise<Array<object>>} OpenAI chat `tools` array
 */
async function getMCPTools() {
  if (openAIToolsCache && connectedClient && !disconnected) {
    return openAIToolsCache;
  }
  const client = await ensureConnected();
  const { tools } = await client.listTools();
  openAIToolsCache = (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: mcpSchemaToParameters(t.inputSchema),
    },
  }));
  return openAIToolsCache;
}

/**
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<object|string>} Parsed JSON when possible, else concatenated text
 */
async function callMCPTool(toolName, args) {
  const client = await ensureConnected();

  function parseContent(result) {
    const parts = Array.isArray(result.content) ? result.content : [];
    const texts = parts.filter((c) => c.type === "text").map((c) => String(c.text || ""));
    const raw = texts.join("\n").trim();
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  const result = await client.callTool({ name: toolName, arguments: args || {} });
  if (result.isError) {
    const txt = parseContent(result);
    throw new Error(typeof txt === "string" ? txt : JSON.stringify(txt));
  }
  return parseContent(result);
}

/**
 * Run `fn` while holding MCP exclusive lock (whole agent turns should run inside).
 */
async function runMCPExclusive(fn) {
  return enqueueExclusive(fn);
}

async function disconnect() {
  try {
    if (connectedClient) await connectedClient.close();
  } catch {
    //
  }
  connectedClient = null;
  connectingPromise = null;
  resetConnection();
}

/**
 * Ping MCP and cache tools once; retries like ensureConnectedInner.
 */
async function initMCPClient() {
  await ensureConnected();
  await getMCPTools();
  console.log('[mcp-client] MCP Client connected to', getSSEUrlRaw());
}

module.exports = {
  getMCPTools,
  callMCPTool,
  initMCPClient,
  disconnect,
  runMCPExclusive,
  enqueueExclusive,
  getSSEUrlRaw,
};
