# openrouter-activity-service

[![CI](https://github.com/sebgru/openrouter-activity-service/actions/workflows/ci.yml/badge.svg)](https://github.com/sebgru/openrouter-activity-service/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/sebgru/openrouter-activity-service/branch/main/graph/badge.svg)](https://codecov.io/gh/sebgru/openrouter-activity-service)
[![License: MIT](https://img.shields.io/github/license/sebgru/openrouter-activity-service.svg)](LICENSE)

Lightweight internal microservice that exposes OpenRouter usage/activity and credit data through a simple JSON API.

Sits behind Docker Compose so the OpenRouter Management API key stays inside the container — never exposed to the OpenClaw container.

## Endpoints

### GET `/usage?year=2026&month=5`

Returns per-model usage data for the requested month (aggregated from OpenRouter's daily activity API), plus provider-backed daily buckets for the OpenRouter activity window.

Existing aggregate fields continue to come from the unfiltered account activity
query. `apiKeys` adds the same usage shape for each ordinary API key, obtained
by listing the account keys with `include_disabled=true` and querying activity
using the OpenRouter key hash.
It contains only the label and hash returned by OpenRouter, never an API-key
secret. Per-key activity is limited to OpenRouter's last-30-days window. The
documented `/keys` response is a single data array, so no pagination is used.

**Response:**

```json
{
  "totalRequests": 1234,
  "totalPromptTokens": 500000,
  "totalCompletionTokens": 150000,
  "totalReasoningTokens": 5000,
  "totalCost": 42.5,
  "apiKeysStatus": "ok",
  "apiKeys": [
    {
      "label": "OpenClaw",
      "hash": "<OpenRouter key hash>",
      "totalRequests": 700,
      "totalCost": 25.0,
      "models": [],
      "days": [],
      "yesterday": null,
      "currentDay": {
        "date": "2026-05-31",
        "partial": true,
        "cost": 0.42,
        "source": "keys.usage_daily"
      },
      "usageMonthly": {
        "cost": 12.34,
        "source": "keys.usage_monthly"
      }
    }
  ],
  "models": [
    {
      "model": "openai/gpt-4.1",
      "requests": 500,
      "promptTokens": 200000,
      "completionTokens": 50000,
      "reasoningTokens": 0,
      "cost": 20.0,
      "providers": {
        "OpenAI": { "requests": 500, "cost": 20.0 }
      }
    }
  ],
  "days": [
    {
      "date": "2026-05-31",
      "requests": 25,
      "promptTokens": 10000,
      "completionTokens": 2500,
      "reasoningTokens": 0,
      "cost": 1.25,
      "models": [
        {
          "model": "openai/gpt-4.1",
          "requests": 25,
          "promptTokens": 10000,
          "completionTokens": 2500,
          "reasoningTokens": 0,
          "cost": 1.25,
          "providers": {
            "OpenAI": {
              "requests": 25,
              "promptTokens": 10000,
              "completionTokens": 2500,
              "reasoningTokens": 0,
              "cost": 1.25
            }
          }
        }
      ]
    }
  ],
  "yesterday": {
    "date": "2026-05-31",
    "requests": 25,
    "promptTokens": 10000,
    "completionTokens": 2500,
    "reasoningTokens": 0,
    "cost": 1.25,
    "models": [
      {
        "model": "openai/gpt-4.1",
        "requests": 25,
        "promptTokens": 10000,
        "completionTokens": 2500,
        "reasoningTokens": 0,
        "cost": 1.25,
        "providers": {
          "OpenAI": {
            "requests": 25,
            "promptTokens": 10000,
            "completionTokens": 2500,
            "reasoningTokens": 0,
            "cost": 1.25
          }
        }
      }
    ]
  }
}
```

`days`, `yesterday`, and all aggregate totals contain only completed UTC days.
The service never calls `/activity` for today because OpenRouter rejects that
date. For an ordinary key in the current month, `currentDay` is instead a
cost-only partial bucket from that key's `/keys` `usage_daily` field. It has no
request, token, model, or provider breakdown and is deliberately excluded from
that key's `totalCost`. `usageMonthly`, when OpenRouter supplies it, is the
unchanged `/keys` `usage_monthly` cost and may include the current partial day.

`apiKeysStatus` is `"ok"` when the key list contains entries, `"empty"` when
OpenRouter returned a valid empty key list (not a zero-spend result), and
`"not_queried"` when the requested month is outside the activity window.

### GET `/balance`

Returns total credits purchased, used, and remaining.

**Response:**

```json
{
  "totalCredits": 100.0,
  "totalUsage": 42.5,
  "remainingCredits": 57.5
}
```

### GET `/health`

Liveness check.

```json
{
  "ok": true,
  "service": "openrouter-activity-service",
  "token_loaded": true
}
```

## Setup

### 1. Create an OpenRouter Management API key

Go to <https://openrouter.ai/settings/keys> → "Create Management Key".

Required scopes:

- `/credits` read — total credits purchased and used
- `/activity` read — per-model, per-day usage data
- `/keys` read — list ordinary API keys for the per-key usage breakdown

### 2. Store the key file

Create a file with the key value (and nothing else):

```bash
echo -n 'sk-or-v1-xxxxxxxxxxxxxxxx' > /path/to/openrouter-management-token
chmod 600 /path/to/openrouter-management-token
```

### 3. Run with Docker Compose

```yaml
services:
  openrouter-activity-service:
    image: ghcr.io/sebgru/openrouter-activity-service:latest
    restart: unless-stopped
    ports:
      - "8767:8767"
    volumes:
      - path/to/openrouter-management-token:/run/secrets/openrouter-management-token:ro
    environment:
      OPENROUTER_ACTIVITY_PORT: "8767"
      OPENROUTER_MGMT_TOKEN_FILE: /run/secrets/openrouter-management-token
      OPENROUTER_WORKSPACE_ID: 73823bec-88a6-42e7-a146-0b1aa1ae0de0
    networks:
      - ai-net

networks:
  ai-net:
    external: true
```

### 4. Test

```bash
curl http://localhost:8767/health
curl 'http://localhost:8767/usage?year=2026&month=5'
curl http://localhost:8767/balance
```

## Environment Variables

| Variable                     | Default                                    | Description                                     |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `OPENROUTER_ACTIVITY_PORT`   | `8767`                                     | HTTP listen port                                |
| `OPENROUTER_MGMT_TOKEN_FILE` | `/run/secrets/openrouter-management-token` | Path to Bearer token file                       |
| `OPENROUTER_WORKSPACE_ID`    | `73823bec-88a6-42e7-a146-0b1aa1ae0de0`     | OpenRouter workspace used when listing API keys |

## CI/CD

- **CI** (`ci.yml`): Prettier formatting check, ESLint, Vitest unit tests with coverage (≥ 80%), Codecov upload, Trivy container security scan
- **docker build** (`docker-image.yml`): verifies clean Docker build on every push/PR
- **docker publish** (`docker-publish.yml`): on version tags (`v*.*.*`), builds and publishes to `ghcr.io/sebgru/openrouter-activity-service` with cosign image signing

## Development

This repository includes a VS Code devcontainer that installs the same local development tools used by CI.

```bash
# Format
npm run format

# Lint
npm run lint

# Tests
npm test

# Tests with coverage
npm run test:cov
```

## Building

```bash
docker build -t openrouter-activity-service .
```

Or use the GitHub Actions workflow to publish to GHCR.
