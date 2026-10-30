# OpenRouter Decisions API (condensed reference)

Source: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request, the Decisions
schemas in https://openrouter.ai/openapi.json and https://openrouter.ai/skills/openrouter-decisions (read
2026-10-30). The endpoint is an **alpha**: check the reference again before changing `pipeline/openrouter.ts`.

One endpoint serves every decision model OpenRouter lists, from several publishers, with one OpenRouter key.
`pipeline/openrouter.ts` translates our OpenAI-shaped request (docs/decisions-api.md) into this one and the answers
back.

## Request

`POST https://openrouter.ai/api/alpha/decisions`, header `Authorization: Bearer <OpenRouter key>`.

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string | A decision model id, e.g. `openai/gpt-6-luna-decisions` or `typesafe/jev-1.14`. Ids starting with `~` are aliases that can move: never pin one. |
| `state` | string, object or array | What the questions read. We send the same text as OpenAI's `input`. |
| `questions` | object | Question name → question. Names are for code; the model does not see them. |
| `provider` | object, optional | Routing preferences (`order`, `only`, `data_collection`, `zdr`, …). |
| `session_id`, `user`, `trace` | optional | Observability only. |

### Question types

- `noul` (our `predicate`): `instructions`, `criteria: { "true": string, "false": string }` (both keys required).
- `choice`: `instructions`, `criteria`: option name → guidance. Name the option inside its criterion.
- `score`: `instructions`, `criteria`: an ordered array of level descriptions (lowest first).
- `box` (images only, not used).

There is no `prompt_cache_key` and no documented limit on questions or choices.

## Response

```json
{
  "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": { "type": "choice", "choice": "payments", "confidence": 0.75,
              "probabilities": { "account": 0, "frontend": 0.16, "payments": 0.84 } },
    "urgency": { "type": "score", "score": 1.99, "confidence": 0.99,
                 "legend": { "0": "Can wait for the next release", "1": "Should be fixed this week", "2": "Blocking revenue right now" },
                 "probabilities": { "0": 0, "1": 0.01, "2": 0.99 } }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

- `answers` is an object keyed by question name, not a list. `noul` is the probability of `true`.
- A score's `probabilities` are keyed by level index as a string; `score` is the probability-weighted index.
- Only `choice` and `score` are required in their answers: `confidence` and `probabilities` may be missing.
- There is no refusal answer type. We treat a missing answer as a refusal.
- `usage` has no cached-token count.
- Probabilities are rounded to two decimals, so they may not sum to exactly 1.

## Errors

`{ "error": { "code": <number>, "message": string } }`. Statuses: 400 bad request, 401 bad key, 402 no credits,
403 forbidden, 404, 413 payload too large, 429 rate limit, 500, 502 upstream failure, 503, 524 timeout,
529 provider overloaded. As with OpenAI, we keep only the status: messages can echo request content.

## Models

The catalog changes: list it with `GET https://openrouter.ai/api/v1/models?output_modalities=decisions` (no key
needed). On 2026-10-30 it held 34 models, input-only pricing, context from 8K to 1M tokens. A long video's main
request can reach tens of thousands of tokens, so pick models with at least 128K of context.
