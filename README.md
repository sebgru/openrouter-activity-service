# openrouter-activity-service

Lightweight internal microservice that exposes OpenRouter usage/activity and credit data through a simple JSON API.

Sits behind Docker compose so the OpenRouter Management API key stays inside the container — never exposed to the OpenClaw container.

## Endpoints

### GET `/usage?year=2026&month=5`

Returns per-model usage data for the requested month (aggregated from OpenRouter's daily activity API).

**Response:**
```json
{
  "totalRequests": 1234,
  "totalPromptTokens": 500000,
  "totalCompletionTokens": 150000,
  "totalReasoningTokens": 5000,
  "totalCost": 42.50,
  "models": [
    {
      "model": "openai/gpt-4.1",
      "requests": 500,
      "promptTokens": 200000,
      "completionTokens": 50000,
      "reasoningTokens": 0,
      "cost": 20.00,
      "providers": {
        "OpenAI": { "requests": 500, "cost": 20.00 }
      }
    }
  ]
}
```

### GET `/balance`

Returns total credits purchased, used, and remaining.

**Response:**
```json
{
  "totalCredits": 100.00,
  "totalUsage": 42.50,
  "remainingCredits": 57.50
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

Go to https://openrouter.ai/settings/keys → "Create Management Key".

Required scopes:
- `/credits` read — total credits purchased and used
- `/activity` read — per-model, per-day usage data

### 2. Store the key file

Create a file with the key value (and nothing else):

```bash
echo -n 'sk-or-v1-xxxxxxxxxxxxxxxx' > /home/sebg/openclaw/openrouter-management-token
chmod 600 /home/sebg/openclaw/openrouter-management-token
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
      - /home/sebg/openclaw/openrouter-management-token:/run/secrets/openrouter-management-token:ro
    environment:
      OPENROUTER_ACTIVITY_PORT: "8767"
      OPENROUTER_MGMT_TOKEN_FILE: /run/secrets/openrouter-management-token
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

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_ACTIVITY_PORT` | `8767` | HTTP listen port |
| `OPENROUTER_MGMT_TOKEN_FILE` | `/run/secrets/openrouter-management-token` | Path to Bearer token file |

## Building

```bash
docker build -t openrouter-activity-service .
```

Or use the GitHub Actions workflow to publish to GHCR.
