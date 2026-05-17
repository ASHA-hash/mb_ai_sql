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

module.exports = {
  openAiOmitsTemperature,
  openAiChatOptions,
};
