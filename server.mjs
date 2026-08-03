#!/usr/bin/env node
// openrouter-activity-service — internal microservice exposing OpenRouter usage/activity data
//
// Endpoints:
//   GET /usage?year=2026&month=5  → daily per-model usage and cost breakdown for the month
//   GET /balance                  → total credits purchased and used
//   GET /health                   → liveness check
//
// Authentication:
//   Mount your OpenRouter Management API key at
//   /run/secrets/openrouter-management-token (override with OPENROUTER_MGMT_TOKEN_FILE).
//   The file is re-read on every request — replace it and the next call picks up
//   the new token automatically, no container restart required.
//
//   Create a management key: https://openrouter.ai/settings/keys → "Create Management Key"
//   (Needs: /credits read + /activity read scopes)
//
//   Scopes (from OpenRouter docs):
//     - /credits read — total credits purchased and used
//     - /activity read — per-model, per-day usage for last 30 days

import http from "node:http";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

const PORT = parseInt(process.env.OPENROUTER_ACTIVITY_PORT || "8767", 10);
const TOKEN_FILE =
  process.env.OPENROUTER_MGMT_TOKEN_FILE || "/run/secrets/openrouter-management-token";
const API_HOST = "openrouter.ai";
const KNOWN_PATHS = ["/health", "/usage?year=...&month=...", "/balance"];

// ---------- Token ----------

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

// ---------- HTTPS helpers ----------

async function fetchFromOpenRouter(path, queryString) {
  const token = readToken();
  if (!token) {
    throw new Error("OPENROUTER_MGMT_TOKEN_FILE not found or empty");
  }

  const url = new URL(path.replace(/^\//, ""), `https://${API_HOST}/api/v1/`);
  if (queryString) url.search = queryString;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}: ${body.slice(0, 500)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Failed to parse OpenRouter response: ${body.slice(0, 200)}`);
  }
}

// ---------- Activity / usage aggregation ----------

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function createUsageBucket() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    models: {},
  };
}

function addUsageEntry(bucket, entry) {
  const model = entry.model || "unknown";
  const provider = entry.provider_name || "unknown";
  const requests = entry.requests || 0;
  const promptTokens = entry.prompt_tokens || 0;
  const completionTokens = entry.completion_tokens || 0;
  const reasoningTokens = entry.reasoning_tokens || 0;
  const cost = entry.usage || 0;

  bucket.requests += requests;
  bucket.promptTokens += promptTokens;
  bucket.completionTokens += completionTokens;
  bucket.reasoningTokens += reasoningTokens;
  bucket.cost += cost;

  if (!bucket.models[model]) {
    bucket.models[model] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      providers: {},
    };
  }

  const modelBucket = bucket.models[model];
  modelBucket.requests += requests;
  modelBucket.promptTokens += promptTokens;
  modelBucket.completionTokens += completionTokens;
  modelBucket.reasoningTokens += reasoningTokens;
  modelBucket.cost += cost;

  if (!modelBucket.providers[provider]) {
    modelBucket.providers[provider] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    };
  }

  const providerBucket = modelBucket.providers[provider];
  providerBucket.requests += requests;
  providerBucket.promptTokens += promptTokens;
  providerBucket.completionTokens += completionTokens;
  providerBucket.reasoningTokens += reasoningTokens;
  providerBucket.cost += cost;
}

function finalizeModels(modelsByName) {
  return Object.entries(modelsByName)
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.cost - a.cost);
}

async function getUsage(year, month) {
  const totalDays = daysInMonth(year, month);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayDate = new Date(today);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayStr = formatDateUTC(yesterdayDate);
  const requestedDates = [];

  // Collect data for all days in the month (up to today, but OpenRouter only keeps 30 days)
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    requestedDates.push(dateStr);
  }

  // Fetch activity for each day the OpenRouter API still has data for (last 30 UTC days)
  // We batch-fetch each day individually for clean per-day data
  const errors = [];
  const dayMap = {};

  // Fetch only the last 30 days (OpenRouter limit)
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  for (const dateStr of requestedDates) {
    const dt = new Date(dateStr + "T00:00:00Z");
    if (dt < thirtyDaysAgo || dt > today) continue;

    try {
      const dayBucket = createUsageBucket();
      const result = await fetchFromOpenRouter(`/activity`, `date=${dateStr}`);
      if (result && Array.isArray(result.data)) {
        for (const entry of result.data) {
          addUsageEntry(dayBucket, entry);
        }
      }
      dayMap[dateStr] = dayBucket;
    } catch (err) {
      errors.push({ date: dateStr, error: err.message });
    }
  }

  const monthBucket = createUsageBucket();

  for (const day of Object.values(dayMap)) {
    for (const model of Object.entries(day.models)) {
      const [modelName, modelData] = model;
      for (const [providerName, providerData] of Object.entries(modelData.providers)) {
        addUsageEntry(monthBucket, {
          model: modelName,
          provider_name: providerName,
          requests: providerData.requests,
          prompt_tokens: providerData.promptTokens,
          completion_tokens: providerData.completionTokens,
          reasoning_tokens: providerData.reasoningTokens,
          usage: providerData.cost,
        });
      }
    }
  }

  const days = Object.entries(dayMap)
    .map(([date, data]) => ({
      date,
      requests: data.requests,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      reasoningTokens: data.reasoningTokens,
      cost: data.cost,
      models: finalizeModels(data.models),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const yesterday = days.find((day) => day.date === yesterdayStr) || null;

  return {
    totalRequests: monthBucket.requests,
    totalPromptTokens: monthBucket.promptTokens,
    totalCompletionTokens: monthBucket.completionTokens,
    totalReasoningTokens: monthBucket.reasoningTokens,
    totalCost: monthBucket.cost,
    models: finalizeModels(monthBucket.models),
    days,
    yesterday,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function getBalance() {
  const result = await fetchFromOpenRouter(`/credits`);
  if (result && result.data) {
    return {
      totalCredits: result.data.total_credits,
      totalUsage: result.data.total_usage,
      remainingCredits: result.data.total_credits - result.data.total_usage,
    };
  }
  throw new Error("Unexpected response from /credits endpoint");
}

// ---------- HTTP Server ----------

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data, null, 2) + "\n");
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

async function handleRequest(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendError(res, 405, "Method not allowed");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/health") {
      // Check token availability
      const token = readToken();
      sendJSON(res, 200, {
        ok: true,
        service: "openrouter-activity-service",
        token_loaded: token !== null,
      });
    } else if (pathname === "/usage") {
      const year = parseInt(url.searchParams.get("year"), 10);
      const month = parseInt(url.searchParams.get("month"), 10);

      if (!year || !month || month < 1 || month > 12) {
        sendError(res, 400, "Provide ?year=YYYY&month=M (month 1-12)");
        return;
      }

      const data = await getUsage(year, month);
      sendJSON(res, 200, data);
    } else if (pathname === "/balance") {
      const data = await getBalance();
      sendJSON(res, 200, data);
    } else {
      sendError(res, 404, `Not found. Known paths: ${KNOWN_PATHS.join(", ")}`);
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    sendError(res, 502, err.message);
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

// ---------- Exports (for testing) ----------

export {
  readToken,
  fetchFromOpenRouter,
  daysInMonth,
  getUsage,
  getBalance,
  sendJSON,
  sendError,
  PORT,
  TOKEN_FILE,
};

// ---------- Entry point ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`openrouter-activity-service listening on port ${PORT}`);
  });
}
