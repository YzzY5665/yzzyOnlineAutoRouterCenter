# Cascade

AI middleware that acts as a single endpoint in front of multiple LLM providers (Gemini, Groq, Mistral, Cerebras), with:

- **Difficulty-based routing** — a `difficulty` value (0.0–1.0) picks a starting model, from cheapest/fastest to most capable.
- **Full-sweep cascade** — if a model errors out, the request falls back to the next untried model; if a model reports the task is too complex, it climbs to a stronger one.
- **Key rotation** — multiple API keys per provider, tried in order on rate limits/auth failures.
- **Per-IP rate limiting** on the `/ask-ai` endpoint.

## Setup

```bash
npm install
cp .env.example .env
# fill in your provider API keys and MY_APP_SECRET in .env
npm start
```

## Configuration

See [.env.example](.env.example) for all supported environment variables (provider API keys, shared secret, rate limit, and timeout settings).

## API

### `GET /health`

Returns server uptime, configured model/key counts, and current rate-limit/timeout settings. No auth required.

### `GET /wake`

Simple liveness check, useful for keeping a free-tier host warm.

### `POST /ask-ai`

Requires the shared secret in an `x-api-key` header.

```bash
curl -X POST https://your-host/ask-ai \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MY_APP_SECRET" \
  -d '{"difficulty": 0.3, "prompt": "Summarize this text..."}'
```

Request body:

| Field        | Type   | Description                                  |
|--------------|--------|-----------------------------------------------|
| `difficulty` | number | 0.0–1.0, picks the starting model in the cascade |
| `prompt`     | string | The task/prompt to send to the model          |

Response:

```json
{
  "state": "complete",
  "package": { "...": "model's JSON response" },
  "answeredBy": { "index": 4, "provider": "gemini", "model": "gemini-2.5-flash" }
}
```

`package` is whatever the model returned. Note that it comes back as a JSON
object from some providers and as a JSON-encoded **string** from others, so
callers should handle both. A `403` is returned as the plain text `Forbidden`,
not as JSON.

### Keeping the model list honest

`MODELS` in [script.js](script.js) must contain only ids the configured keys
can actually reach. A stale id returns 404, and because the cascade walks
*downward* on error, one dead entry is paid for by every request that falls
past it — ten dead entries turned a transient blip into an 18-second failure.
Verify ids against each provider's `/models` endpoint before adding them; the
commands are in the comment above `MODELS`.

If every model in the cascade fails, responds with `503` and `{ "state": "error", "content": "All models exhausted" }`.

## License

MIT — see [LICENSE](LICENSE).
