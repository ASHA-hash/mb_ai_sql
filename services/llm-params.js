"use strict";

/**
 * OpenAI chat models that reject non-default temperature (e.g. gpt-5, o-series).
 * Omit temperature so the API uses its default.
 */
function openAiOmitsTemperature(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return false;
  return /\bgpt-5\b/.test(m) || /^o[0-9]/.test(m) || /\bo[134](-mini|-preview)?\b/.test(m);
}

/**
 * Build ChatOpenAI options — only sets temperature when the model supports it.
 */
function openAiChatOptions(model, { temperature, maxTokens } = {}) {
  const opts = {
    model: String(model || "").trim(),
    maxTokens: maxTokens != null ? maxTokens : 2048,
  };
  if (!openAiOmitsTemperature(model) && temperature != null && Number.isFinite(Number(temperature))) {
    opts.temperature = temperature;
  }
  return opts;
}

/**
 * @langchain/anthropic defaults topP to -1. Newer models reject top_p: -1 and also reject
 * sending both temperature and top_p — use temperature only, then clear topP on the instance.
 */
function anthropicChatOptions(model, { temperature, maxTokens, anthropicApiKey } = {}) {
  const opts = {
    model: String(model || "").trim(),
    maxTokens: maxTokens != null ? maxTokens : 2048,
  };
  if (anthropicApiKey) opts.anthropicApiKey = anthropicApiKey;
  if (temperature != null && Number.isFinite(Number(temperature))) {
    opts.temperature = temperature;
  } else {
    opts.topP = 1;
  }
  return opts;
}

/** Clear LangChain's topP=-1 default when using temperature (API allows only one). */
function configureAnthropicLlm(llm, { temperature } = {}) {
  if (!llm) return llm;
  const useTemp = temperature != null && Number.isFinite(Number(temperature));
  if (useTemp) {
    llm.topP = undefined;
  } else if (llm.topP === -1) {
    llm.topP = 1;
  }
  return llm;
}

module.exports = {
  openAiOmitsTemperature,
  openAiChatOptions,
  anthropicChatOptions,
  configureAnthropicLlm,
};
