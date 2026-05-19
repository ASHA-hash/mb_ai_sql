"use strict";

/**
 * Multi-model gateway — single entry for OpenAI vs Claude in the adaptive LangGraph pipeline.
 * Uses LangChain chat models (already in package.json) with shared llm-params fixes.
 */
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const {
  openAiChatOptions,
  anthropicChatOptions,
  configureAnthropicLlm,
} = require("./llm-params");
const runtimeConfig = require("./runtime-config");

function normalizeProvider(provider) {
  const s = String(provider || runtimeConfig.get("DEFAULT_AI_PROVIDER") || "openai")
    .toLowerCase()
    .trim();
  if (s === "anthropic" || s === "claude") return "claude";
  return "openai";
}

function isClaudeProvider(provider) {
  return normalizeProvider(provider) === "claude";
}

/**
 * @returns {{ provider: "openai"|"claude", model: string, apiKey: string }}
 */
function resolveModelConfig(provider, explicitModel) {
  const p = normalizeProvider(provider);
  if (p === "claude") {
    return {
      provider: "claude",
      model: String(explicitModel || runtimeConfig.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6").trim(),
      apiKey: String(process.env.ANTHROPIC_API_KEY || "").trim(),
    };
  }
  return {
    provider: "openai",
    model: String(explicitModel || runtimeConfig.get("OPENAI_MODEL") || "gpt-4o-mini").trim(),
    apiKey: String(process.env.OPENAI_API_KEY || "").trim(),
  };
}

function getChatAnthropicClass() {
  try {
    return require("@langchain/anthropic").ChatAnthropic;
  } catch {
    return null;
  }
}

/**
 * @param {"sql"|"answer"} role
 */
function createLangChainLlm(provider, { role = "sql", apiKey, model } = {}) {
  const cfg = resolveModelConfig(provider, model);
  const isSql = role === "sql";
  const temperature = isSql ? 0 : 0.2;
  const maxTokens = isSql ? 4096 : 1024;

  if (cfg.provider === "claude") {
    const ChatAnthropic = getChatAnthropicClass();
    if (!ChatAnthropic) {
      throw new Error("@langchain/anthropic is not installed. Run: npm install @langchain/anthropic");
    }
    const key = String(apiKey || cfg.apiKey).trim();
    if (!key) throw new Error("Anthropic API key not configured (ANTHROPIC_API_KEY)");
    return configureAnthropicLlm(
      new ChatAnthropic({
        ...anthropicChatOptions(cfg.model, {
          anthropicApiKey: key,
          temperature,
          maxTokens,
        }),
      }),
      { temperature }
    );
  }

  const key = String(apiKey || cfg.apiKey).trim();
  if (!key) throw new Error("OpenAI API key not configured (OPENAI_API_KEY)");
  return new ChatOpenAI({
    openAIApiKey: key,
    ...openAiChatOptions(cfg.model, { temperature, maxTokens }),
  });
}

/**
 * SQL + answer LLM pair for LangGraph nodes.
 */
function createLangChainPair({ provider, apiKey, claudeApiKey, model } = {}) {
  const cfg = resolveModelConfig(provider, model);
  const p = cfg.provider;
  const openKey =
    p === "openai"
      ? String(apiKey || process.env.OPENAI_API_KEY || "").trim()
      : String(apiKey || process.env.OPENAI_API_KEY || "").trim();
  const claudeKey =
    p === "claude"
      ? String(claudeApiKey || process.env.ANTHROPIC_API_KEY || "").trim()
      : String(claudeApiKey || process.env.ANTHROPIC_API_KEY || "").trim();

  const label = p === "claude" ? "Claude" : "OpenAI";
  console.log(`[ai-gateway] ${label} — ${cfg.model} (sql=temp:0, answer=temp:0.2)`);

  return {
    provider: p,
    model: cfg.model,
    llmSQL: createLangChainLlm(p, {
      role: "sql",
      apiKey: p === "claude" ? claudeKey : openKey,
      model: cfg.model,
    }),
    llmAnswer: createLangChainLlm(p, {
      role: "answer",
      apiKey: p === "claude" ? claudeKey : openKey,
      model: cfg.model,
    }),
  };
}

function extractMessageText(response) {
  if (!response) return "";
  const c = response.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return String(c ?? "");
}

/**
 * Direct gateway invoke (intent resolution, one-off SQL compile, tests).
 * @param {boolean} jsonMode — OpenAI: json_object; Claude: JSON instruction suffix
 */
async function invokeUnifiedGateway(
  provider,
  systemPrompt,
  userMessage,
  jsonMode = false,
  { apiKey, model, role = "sql" } = {}
) {
  const cfg = resolveModelConfig(provider, model);
  const llm = createLangChainLlm(cfg.provider, {
    role,
    apiKey: apiKey || (cfg.provider === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY), // API keys always from env (secrets)
    model: cfg.model,
  });

  let user = String(userMessage || "");
  if (jsonMode && isClaudeProvider(cfg.provider)) {
    user += "\n\nRespond with a single valid JSON object only. No markdown fences or commentary.";
  }

  const messages = [new SystemMessage(String(systemPrompt || "")), new HumanMessage(user)];

  if (jsonMode && cfg.provider === "openai") {
    const response = await llm.invoke(messages, {
      response_format: { type: "json_object" },
    });
    return extractMessageText(response);
  }

  const response = await llm.invoke(messages);
  return extractMessageText(response);
}

module.exports = {
  normalizeProvider,
  isClaudeProvider,
  resolveModelConfig,
  createLangChainLlm,
  createLangChainPair,
  invokeUnifiedGateway,
  extractMessageText,
};
