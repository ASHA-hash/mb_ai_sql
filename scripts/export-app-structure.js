/**
 * Read-only application structure exporter.
 * Usage: node scripts/export-app-structure.js [--json] [--out path]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractRoutes(indexSrc) {
  const routes = [];
  const re = /app\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(indexSrc))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function extractRequires(fileRel) {
  const src = readText(fileRel);
  const reqs = [];
  const re = /require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (!m[1].startsWith(".") && !m[1].startsWith("@")) continue;
    reqs.push(m[1]);
  }
  return [...new Set(reqs)];
}

function listDir(rel, ext = ".js") {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(ext))
    .map((d) => `${rel}/${d.name}`.replace(/\\/g, "/"));
}

function schemaMeta() {
  try {
    const j = JSON.parse(readText("metadata/db_tables_views_columns.json"));
    return {
      database: j.database,
      tables: Object.keys(j.tables || {}).length,
      views: Object.keys(j.views || {}).length,
      generated_at_utc: j.generated_at_utc,
    };
  } catch {
    return { error: "metadata/db_tables_views_columns.json unreadable" };
  }
}

function buildStructure() {
  const indexSrc = readText("index.js");
  return {
    exported_at: new Date().toISOString(),
    entrypoint: "index.js",
    package: JSON.parse(readText("package.json")).name,
    schema: schemaMeta(),
    static_pages: [
      "/",
      "/dashboard",
      "/dashboard.html",
      "/index.html",
      "/rag-guide.html",
      "/privacy",
      "/support",
      "/tos",
      "/setup-guide",
      "/help",
      "/report-issue",
      "/admin-config",
      "/oauth2callback",
    ],
    api_routes: extractRoutes(indexSrc),
    query_pipelines: {
      "POST /api/query/adaptive": [
        "forceMode=langgraph → tryRagVerifiedFastPath → runLangChainQuery",
        "contextData → analyzeDataResult (follow-up)",
        "rawSql → direct pool.query",
        "tryRagVerifiedFastPath",
        "runDeterministicQuery (if DETERMINISTIC_LEGACY_TEMPLATES=1)",
        "parseQuery + runLangChainQuery fallback (DETERMINISTIC_LANGGRAPH_FALLBACK)",
        "ai-sql nlToSelectSql + validation (legacy path)",
      ],
      "POST /api/query/langchain": ["runLangChainQuery"],
      "POST /api/query/agentic": ["runAgenticQuery → MCP or agentic-db-tools"],
      "POST /api/query/ai": ["ai-sql.nlToSelectSql"],
    },
    langgraph_nodes: [
      "pre_flight_gate",
      "retrieve_context",
      "resolve_intent",
      "generate_sql",
      "check_sql",
      "execute_sql",
      "error_recovery",
      "zero_rows_recovery",
      "generate_answer",
      "verify_answer",
    ],
    core_modules: {
      "ai-langchain-query.js": extractRequires("ai-langchain-query.js"),
      "ai-agentic-query.js": extractRequires("ai-agentic-query.js"),
      "services/pre-flight-gate.js": extractRequires("services/pre-flight-gate.js"),
      "services/metadata-translation-engine.js": extractRequires("services/metadata-translation-engine.js"),
    },
    services: listDir("services"),
    metadata_files: listDir("metadata", ".json"),
    mcp: listDir("mcp"),
    env_flags: [
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "DETERMINISTIC_LEGACY_TEMPLATES (default 0)",
      "DETERMINISTIC_LANGGRAPH_FALLBACK (default 1)",
      "SCHEMA_CONTEXT_TOP_VIEWS (default 1)",
      "ADAPTIVE_INTENT_STEP",
      "AI_AGGREGATE_REQUIRED",
    ],
  };
}

const asJson = process.argv.includes("--json");
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;
const structure = buildStructure();

if (outPath) {
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(structure, null, 2));
  console.log("Wrote", outPath);
} else if (asJson) {
  console.log(JSON.stringify(structure, null, 2));
} else {
  console.log("# Application structure\n");
  console.log(`Schema: ${structure.schema.views} views, ${structure.schema.tables} tables (${structure.schema.database})`);
  console.log(`\n## API routes (${structure.api_routes.length})\n`);
  for (const r of structure.api_routes) {
    console.log(`- ${r.method} ${r.path}`);
  }
  console.log("\n## LangGraph nodes\n");
  structure.langgraph_nodes.forEach((n) => console.log(`- ${n}`));
  console.log("\n## Services\n");
  structure.services.forEach((s) => console.log(`- ${s}`));
}
