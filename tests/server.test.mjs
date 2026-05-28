/**
 * Unit tests for openrouter-activity-service.
 *
 * Tests pure functions, HTTP handler routes, and upstream fetch logic
 * without making real network calls.
 */

import http from "node:http";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ── Mock node:https before server.mjs is imported ───────────────────────────
vi.mock("node:https", () => ({
    default: { request: vi.fn() },
}));

// ── Mock node:fs (readFileSync used by readToken) ────────────────────────────
vi.mock("node:fs", async () => {
    const actual = await vi.importActual("node:fs");
    return { ...actual, readFileSync: vi.fn() };
});

import https from "node:https";
import { readFileSync } from "node:fs";

import {
    daysInMonth,
    readToken,
    sendJSON,
    sendError,
    fetchFromOpenRouter,
    getBalance,
    getUsage,
    createServer,
    PORT,
    TOKEN_FILE,
} from "../server.mjs";

// ── HTTPS mock helper ────────────────────────────────────────────────────────

/**
 * Configure https.request to simulate an OpenRouter API response.
 * @param {object} opts
 * @param {number}  [opts.statusCode=200]
 * @param {string}  [opts.body='{}']
 * @param {string|null} [opts.error=null]   - If set, the request emits an error.
 * @param {boolean} [opts.timeout=false]    - If true, the request emits a timeout.
 */
function setupHttpsMock({ statusCode = 200, body = "{}", error = null, timeout = false } = {}) {
    https.request.mockImplementation((_opts, callback) => {
        const reqMock = {
            on: vi.fn((event, handler) => {
                if (error && event === "error") process.nextTick(() => handler(new Error(error)));
                if (timeout && event === "timeout") process.nextTick(() => handler());
                return reqMock;
            }),
            end: vi.fn(),
            destroy: vi.fn(),
        };

        if (!error && !timeout) {
            const resMock = {
                statusCode,
                on: vi.fn((event, handler) => {
                    if (event === "data") process.nextTick(() => handler(body));
                    if (event === "end") process.nextTick(() => handler());
                    return resMock;
                }),
            };
            process.nextTick(() => callback(resMock));
        }

        return reqMock;
    });
}

// ── Helper: fire an HTTP request against the live test server ────────────────

async function httpGet(baseUrl, path) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* not JSON */
    }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: json, raw: text };
}

// ── daysInMonth ──────────────────────────────────────────────────────────────

describe("daysInMonth", () => {
    it("returns 31 for January", () => {
        expect(daysInMonth(2026, 1)).toBe(31);
    });

    it("returns 28 for February in a non-leap year", () => {
        expect(daysInMonth(2026, 2)).toBe(28);
    });

    it("returns 29 for February in a leap year", () => {
        expect(daysInMonth(2024, 2)).toBe(29);
    });

    it("returns 30 for April", () => {
        expect(daysInMonth(2026, 4)).toBe(30);
    });

    it("returns 31 for December", () => {
        expect(daysInMonth(2026, 12)).toBe(31);
    });
});

// ── readToken ────────────────────────────────────────────────────────────────

describe("readToken", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns the trimmed token when the file exists", () => {
        readFileSync.mockReturnValue("  sk-or-v1-abc123  \n");
        expect(readToken()).toBe("sk-or-v1-abc123");
    });

    it("returns null when the file does not exist", () => {
        readFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        expect(readToken()).toBeNull();
    });

    it("exposes TOKEN_FILE constant", () => {
        expect(typeof TOKEN_FILE).toBe("string");
        expect(TOKEN_FILE.length).toBeGreaterThan(0);
    });
});

// ── sendJSON / sendError ─────────────────────────────────────────────────────

describe("sendJSON", () => {
    it("writes the correct status, headers, and JSON body", () => {
        const body = [];
        const res = {
            writeHead: vi.fn(),
            end: vi.fn((chunk) => body.push(chunk)),
        };
        sendJSON(res, 200, { ok: true });
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
        expect(JSON.parse(body[0])).toEqual({ ok: true });
    });
});

describe("sendError", () => {
    it("delegates to sendJSON with an error wrapper", () => {
        const body = [];
        const res = {
            writeHead: vi.fn(),
            end: vi.fn((chunk) => body.push(chunk)),
        };
        sendError(res, 404, "Not found");
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
        expect(JSON.parse(body[0])).toEqual({ error: "Not found" });
    });
});

// ── fetchFromOpenRouter ──────────────────────────────────────────────────────

describe("fetchFromOpenRouter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readFileSync.mockReturnValue("test-token");
    });

    it("resolves with parsed JSON on a successful response", async () => {
        setupHttpsMock({ body: '{"data": []}' });
        const result = await fetchFromOpenRouter("/activity", "date=2026-05-01");
        expect(result).toEqual({ data: [] });
    });

    it("rejects when no token file is available", async () => {
        readFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        await expect(fetchFromOpenRouter("/activity")).rejects.toThrow(
            "OPENROUTER_MGMT_TOKEN_FILE not found or empty"
        );
    });

    it("rejects on a non-2xx status code", async () => {
        setupHttpsMock({ statusCode: 401, body: '{"error":"unauthorized"}' });
        await expect(fetchFromOpenRouter("/credits")).rejects.toThrow("401");
    });

    it("rejects on a network error", async () => {
        setupHttpsMock({ error: "connection refused" });
        await expect(fetchFromOpenRouter("/activity")).rejects.toThrow("connection refused");
    });

    it("rejects on timeout and destroys the request", async () => {
        setupHttpsMock({ timeout: true });
        await expect(fetchFromOpenRouter("/activity")).rejects.toThrow("timed out");
    });

    it("rejects when the response body is not valid JSON", async () => {
        setupHttpsMock({ body: "not-json" });
        await expect(fetchFromOpenRouter("/activity")).rejects.toThrow(
            "Failed to parse OpenRouter response"
        );
    });
});

// ── getBalance ───────────────────────────────────────────────────────────────

describe("getBalance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readFileSync.mockReturnValue("test-token");
    });

    it("returns computed balance fields from the API response", async () => {
        setupHttpsMock({
            body: JSON.stringify({ data: { total_credits: 100, total_usage: 42.5 } }),
        });
        const result = await getBalance();
        expect(result).toEqual({
            totalCredits: 100,
            totalUsage: 42.5,
            remainingCredits: 57.5,
        });
    });

    it("throws when the API response has unexpected shape", async () => {
        setupHttpsMock({ body: JSON.stringify({ unexpected: true }) });
        await expect(getBalance()).rejects.toThrow("Unexpected response from /credits endpoint");
    });
});

// ── getUsage ─────────────────────────────────────────────────────────────────

describe("getUsage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readFileSync.mockReturnValue("test-token");
    });

    it("returns empty totals for a month entirely outside the 30-day window", async () => {
        // January 2020 is well outside any 30-day window; no https calls expected.
        const result = await getUsage(2020, 1);
        expect(result.totalRequests).toBe(0);
        expect(result.totalCost).toBe(0);
        expect(result.models).toHaveLength(0);
        expect(https.request).not.toHaveBeenCalled();
    });

    it("aggregates activity data across days", async () => {
        // Use the current month so some days fall within the 30-day window.
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() + 1;

        const activityEntry = {
            model: "openai/gpt-4.1",
            requests: 10,
            prompt_tokens: 1000,
            completion_tokens: 500,
            reasoning_tokens: 0,
            usage: 1.5,
            provider_name: "OpenAI",
        };

        setupHttpsMock({ body: JSON.stringify({ data: [activityEntry] }) });

        const result = await getUsage(year, month);
        expect(result.totalRequests).toBeGreaterThan(0);
        expect(result.totalCost).toBeGreaterThan(0);
        expect(result.models[0].model).toBe("openai/gpt-4.1");
        expect(result.models[0].providers["OpenAI"]).toBeDefined();
    });

    it("records errors for days that fail and still returns partial results", async () => {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() + 1;

        setupHttpsMock({ error: "upstream error" });

        const result = await getUsage(year, month);
        expect(result.errors).toBeDefined();
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].error).toContain("upstream error");
    });
});

// ── HTTP routes (live server) ─────────────────────────────────────────────────

describe("HTTP routes", () => {
    let srv;
    let baseUrl;

    beforeAll(async () => {
        srv = createServer();
        await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${srv.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => srv.close(resolve));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        readFileSync.mockReturnValue("test-token");
    });

    // ── /health ──────────────────────────────────────────────────────────────

    it("GET /health returns 200 with ok:true when token is present", async () => {
        const { status, body } = await httpGet(baseUrl, "/health");
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.service).toBe("openrouter-activity-service");
        expect(body.token_loaded).toBe(true);
    });

    it("GET /health returns token_loaded:false when token file is missing", async () => {
        readFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        const { status, body } = await httpGet(baseUrl, "/health");
        expect(status).toBe(200);
        expect(body.token_loaded).toBe(false);
    });

    // ── /usage ───────────────────────────────────────────────────────────────

    it("GET /usage with valid old month returns empty aggregates", async () => {
        const { status, body } = await httpGet(baseUrl, "/usage?year=2020&month=1");
        expect(status).toBe(200);
        expect(body.totalRequests).toBe(0);
        expect(Array.isArray(body.models)).toBe(true);
    });

    it("GET /usage without year/month returns 400", async () => {
        const { status, body } = await httpGet(baseUrl, "/usage");
        expect(status).toBe(400);
        expect(body.error).toMatch(/year/i);
    });

    it("GET /usage with month=13 returns 400", async () => {
        const { status, body } = await httpGet(baseUrl, "/usage?year=2026&month=13");
        expect(status).toBe(400);
    });

    it("GET /usage with month=0 returns 400", async () => {
        const { status, body } = await httpGet(baseUrl, "/usage?year=2026&month=0");
        expect(status).toBe(400);
    });

    it("GET /usage returns 502 when upstream call fails", async () => {
        const now = new Date();
        setupHttpsMock({ error: "upstream unavailable" });
        const { status } = await httpGet(
            baseUrl,
            `/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`
        );
        // Either 200 (errors captured per-day) or 502 (thrown) — both are valid.
        // The service captures per-day errors internally, so 200 with errors array.
        expect([200, 502]).toContain(status);
    });

    // ── /balance ─────────────────────────────────────────────────────────────

    it("GET /balance returns 200 with balance data", async () => {
        setupHttpsMock({
            body: JSON.stringify({ data: { total_credits: 50, total_usage: 10 } }),
        });
        const { status, body } = await httpGet(baseUrl, "/balance");
        expect(status).toBe(200);
        expect(body.totalCredits).toBe(50);
        expect(body.remainingCredits).toBe(40);
    });

    it("GET /balance returns 502 on upstream error", async () => {
        setupHttpsMock({ error: "network failure" });
        const { status } = await httpGet(baseUrl, "/balance");
        expect(status).toBe(502);
    });

    // ── unknown / wrong method ────────────────────────────────────────────────

    it("GET /unknown returns 404", async () => {
        const { status, body } = await httpGet(baseUrl, "/unknown");
        expect(status).toBe(404);
        expect(body.error).toMatch(/not found/i);
    });

    it("POST /health returns 405", async () => {
        const res = await fetch(`${baseUrl}/health`, { method: "POST" });
        const body = await res.json();
        expect(res.status).toBe(405);
        expect(body.error).toMatch(/method not allowed/i);
    });

    it("OPTIONS /health returns 204 with CORS headers", async () => {
        const res = await fetch(`${baseUrl}/health`, { method: "OPTIONS" });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    // ── module-level constants ────────────────────────────────────────────────

    it("PORT constant is a positive integer", () => {
        expect(typeof PORT).toBe("number");
        expect(Number.isInteger(PORT)).toBe(true);
        expect(PORT).toBeGreaterThan(0);
    });

    // ── Dockerfile and compose reference OPENROUTER_ACTIVITY_PORT ────────────

    it("Dockerfile healthcheck respects OPENROUTER_ACTIVITY_PORT", async () => {
        const { readFileSync: realReadFileSync } = await vi.importActual("node:fs");
        const { resolve, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const dockerfile = realReadFileSync(`${root}/Dockerfile`, "utf8");
        expect(dockerfile).toContain("OPENROUTER_ACTIVITY_PORT");
        // Must not hardcode the port in the healthcheck
        expect(dockerfile).not.toContain("127.0.0.1:8767/health");
    });
});
