# OpenAI Decisions API (condensed reference)

Source: https://developers.openai.com/api/reference/resources/decisions/methods/create
and https://developers.openai.com/api/docs/guides/decisions (read 2026-10-23).
Generally available since October 2026.

## Request

`POST https://api.openai.com/v1/decisions`, header `Authorization: Bearer $OPENAI_API_KEY`.

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string | Only `gpt-6-luna`. |
| `input` | string, or array of messages | Evaluated once for every question. A user message is `{ "role": "user", "content": string \| parts[] }`; parts are `{ "type": "input_text", "text" }`, `{ "type": "input_image", "image_url" }` or `{ "type": "input_json", "data" }`. Developer and system messages take text only. |
| `questions` | array, 1–400 | Answers come back in the same order. |
| `prompt_cache_key` | string, optional, ≤ 64 chars | Partitions prompt-cache reuse. |
| `prompt_cache_options` | object, optional | `{ "mode": "implicit" \| "explicit", "ttl": "30m" }`. A text part can carry `"prompt_cache_breakpoint": { "mode": "explicit" }`. |
| `safety_identifier` | string, optional, ≤ 128 chars | Opaque end-user id. |

### Question types

Every question has `type`, an optional `name` and `instructions` (a string, or
parts like the input's).

- `predicate`: how likely a statement about the input is true.
  `{ "type": "predicate", "name": "delivers", "instructions": "..." }`
- `choice`: pick one of 2–255 unique `choices`, each `{ "value": string | boolean, "description"?: string }`.
- `score`: rate against 2–10 ordered `levels`, each `{ "label": string, "description"?: string }`.

## Response

```json
{
  "model": "gpt-6-luna",
  "answers": [
    { "type": "predicate", "name": "delivers", "probability": 0.91 },
    { "type": "choice", "name": "payoff", "choice": "S7", "confidence": 0.82,
      "probabilities": [{ "value": "S7", "probability": 0.84 }, { "value": "S8", "probability": 0.1 }] },
    { "type": "score", "name": "substance_S1", "score": 0.4, "confidence": 0.7,
      "probabilities": [{ "label": "filler", "value": 0, "probability": 0.62 }, { "label": "context", "value": 1, "probability": 0.36 }, { "label": "substance", "value": 2, "probability": 0.02 }] },
    { "type": "refusal", "name": "substance_S2" }
  ],
  "usage": { "input_tokens": 4210, "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
             "output_tokens": 0, "output_tokens_details": { "reasoning_tokens": 0 }, "total_tokens": 4210 }
}
```

- `score` is the probability-weighted average of the level indices (0-based).
- Any question can come back as `{ "type": "refusal", "name": ... }`; the others still get answers.
- Choice `probabilities` may omit unlikely values; treat a missing value as 0.

## Pricing and limits

- $0.10 per 1M uncached input tokens; output tokens are free. Cache hits are discounted.
- Text parts up to 10 MiB each; `input_json` up to 256 KiB.
- Errors: `429 insufficient_quota` / `credit_balance_exhausted` when the account has no credits.
