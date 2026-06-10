# SuccessVan AI Receptionist — Backend

A clean, layered AI voice-agent orchestration backend for the SuccessVan van rental business.

This is **not** a generic agent platform. It is a focused, well-layered orchestration engine for the SuccessVan receptionist, built so it *can* be generalized later without having to be generalized now.

---

## Architecture Overview

Every customer turn goes through this pipeline:

```
input event
→ channel adapter          (web-chat, web-voice, realtime)
→ state manager            (loads BookingDraft from session)
→ memory                   (loads conversation transcript)
→ context/RAG              (loads offices, categories, add-ons from MongoDB)
→ deterministic extraction (age, gear, confirmation, cancellation, phone)
→ tool registry            (resolveOffice, resolveCategory)
→ LLM provider             (extraction only if deterministic insufficient)
→ rule engine              (conversation and reservation rules)
→ workflow graph           (decides next step deterministically)
→ tool registry            (calculatePricePreview if all fields collected)
→ guardrails               (verifies and optionally rewrites response)
→ state manager            (saves updated BookingDraft)
→ memory                   (appends turn to transcript)
→ metrics/evaluation       (records KPIs, TurnTrace, evaluation scores)
→ response returned to client
```

---

## Layer Responsibilities

| Layer | Folder | Responsibility |
|-------|--------|---------------|
| Engine | `src/engine/` | Orchestration loop; the single entrypoint |
| LLM Provider | `src/llm/` | OpenAI calls; structured extraction; response generation |
| Tools | `src/tools/` | Explicit functions with schemas; resolveOffice, resolveCategory, calculatePrice |
| Rules | `src/rules/` | Typed, deterministic rule objects; hard and soft violations |
| State | `src/state/` | BookingDraft shape; in-memory state manager with interface for Redis swap |
| Workflow | `src/workflow/` | Step graph; transition logic; one-question enforcement |
| Memory | `src/memory/` | Per-session transcript; pruned circular buffer |
| Context | `src/context/` | MongoDB → offices/categories/add-ons with TTL cache |
| RAG | `src/rag/` | No-op implementation; interface ready for vector search |
| Guardrails | `src/guardrails/` | Post-LLM safety checks; rewrite invented prices/offices |
| Channels | `src/channels/` | Transport adapters (text, voice, realtime); not the brain |
| Observability | `src/observability/` | TurnTrace, KPI counters, evaluation scorer |
| Pricing | `src/pricing/` | `calculatePrice` matching frontend `usePriceCalculation` hook |
| Time Slots | `src/time/` | `getTimeSlotsForDate`, extension pricing, lead time check |
| Validation | `src/validation/` | Final payload validator before reservation creation |
| Config | `src/config/` | Zod-validated env with feature flags |
| DB | `src/db/` | Mongoose connection; loose read models |
| Utils | `src/utils/` | `normalizeText`, `extractAge`, `isAffirmative`, `safeJsonParse` |

---

## Endpoints

### `GET /health`
Service health check.

### `POST /agent/successvan/text-turn`
Primary endpoint for testing the engine without voice.

**Request:**
```json
{
  "sessionId": "optional",
  "message": "I want a Luton van tomorrow"
}
```

**Response:**
```json
{
  "sessionId": "...",
  "reply": "Which office would you like to collect from?",
  "bookingDraft": { ... },
  "workflowStep": "collect_office",
  "missingFields": ["officeId", "pickupDateText", "returnDateText", "driverAge"],
  "toolCalls": [...],
  "metrics": { "totalMs": 145, ... },
  "evaluation": { "extractionAccuracy": 1.0, ... }
}
```

### `WS /voice/web`
Browser WebSocket channel. Sends `{ type: "text", content: "..." }` for engine testing.
Audio support planned: receives `{ type: "audio", content: "<base64>" }`.

### `GET /realtime/session`
Creates an OpenAI Realtime ephemeral session token for browser WebRTC.
`OPENAI_API_KEY` never reaches the browser.

### `GET /debug/session/:sessionId`
Returns current BookingDraft + transcript for a session.

### `GET /debug/metrics`
Returns all aggregated KPIs across every layer.

### `GET /debug/traces`
Returns 20 most recent TurnTrace objects.

### `GET /debug/trace/:turnId`
Returns a single TurnTrace with full detail.

---

## SuccessVan Workflow Steps

1. `greeting` → ask what type of van they need
2. `collect_office` → ask which office
3. `collect_category` → ask which van type
4. `collect_pickup_datetime` → ask pickup date/time
5. `collect_return_datetime` → ask return date/time
6. `collect_driver_age` → ask driver age
7. `resolve_ambiguity` → ask for clarification when resolver cannot choose
8. `price_preview` → calculate and present price
9. `confirmation` → ask customer to confirm
10. `ready_for_reservation` → collect name and phone
11. `human_handoff` → connect to team (triggers on request or repeated failures)
12. `completed` → booking submitted

---

## KPI System

Metrics are collected in memory for every layer. Use `GET /debug/metrics` to inspect.

Key KPI groups:
- **global** — turns, latency, error rate, sessions
- **llm** — calls, token usage, latency, parse failures, estimated cost
- **tools** — calls per tool, errors, latency
- **rules** — violations by rule ID, hard blocks, soft warnings
- **state** — sessions created/loaded, booking completion rate
- **workflow** — step transitions, repetition count, completion rate
- **memory** — reads/writes, pruned messages
- **context** — cache hit/miss rate, load latency
- **guardrails** — blocks by type (invented price, invented office, etc.)
- **channels** — text/voice turns, WebSocket connections
- **evaluation** — extraction accuracy, rule compliance, task progress, response quality
- **pricing** — calculations, tier fallbacks, gear/addon extras
- **availability** — time slot generation, closed dates, reserved slot conflicts

See `src/observability/metrics.types.ts` for the complete list.

---

## Manual Test Script

Start the server:
```bash
npm run dev
```

Run a full conversation (5 turns):
```bash
# Turn 1 — category resolved, asks office
curl -s -X POST http://localhost:4010/agent/successvan/text-turn \
  -H "Content-Type: application/json" \
  -d '{"message": "I want a Luton van"}' | jq '{reply, workflowStep, missingFields: .missingFields}'

# Turn 2 — office resolved to real office, asks pickup date
# Use the sessionId returned from Turn 1
curl -s -X POST http://localhost:4010/agent/successvan/text-turn \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID", "message": "From London office"}' | jq '{reply, workflowStep}'

# Turn 3 — pickupDateText set, asks return date
curl -s -X POST http://localhost:4010/agent/successvan/text-turn \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID", "message": "Tomorrow at 10"}' | jq '{reply, workflowStep}'

# Turn 4 — returnDateText set, asks driver age
curl -s -X POST http://localhost:4010/agent/successvan/text-turn \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID", "message": "Friday evening"}' | jq '{reply, workflowStep}'

# Turn 5 — driverAge set, moves to price_preview
curl -s -X POST http://localhost:4010/agent/successvan/text-turn \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID", "message": "I am 28"}' | jq '{reply, workflowStep, bookingDraft}'

# Check debug metrics
curl -s http://localhost:4010/debug/metrics | jq '.metrics.global'
```

---

## Environment Variables

```bash
OPENAI_API_KEY=sk-...               # Required
MONGODB_URI=mongodb://...           # Required
PORT=4010                           # Default: 4010
NODE_ENV=development                # development | production | test

# Feature flags
ENABLE_RESERVATION_CREATION=false   # Default: false — keep disabled until safe

# LLM config
OPENAI_EXTRACTION_MODEL=gpt-4o-mini
OPENAI_RESPONSE_MODEL=gpt-4o-mini
LLM_TIMEOUT_MS=10000

# Context cache
CONTEXT_CACHE_TTL_MS=60000
```

---

## How to Add a New Tool

1. Create `src/tools/successvan/my-new.tool.ts`:
   ```ts
   import type { Tool } from "../tool.types.js";
   export const myNewTool: Tool = {
     name: "myNewTool",
     description: "...",
     async execute(input) {
       return { success: true, data: ... };
     },
   };
   ```
2. Register it in `src/bootstrap.ts`:
   ```ts
   import { myNewTool } from "./tools/successvan/my-new.tool.js";
   registerTool(myNewTool);
   ```
3. Call it in `src/engine/run-agent-turn.ts` when appropriate, or add a workflow step that triggers it.

---

## How to Add a New Rule

1. Create or add to a rules file in `src/rules/`:
   ```ts
   export const MY_RULE: Rule<ConversationRuleContext> = {
     id: "MY_RULE",
     severity: "hard",
     description: "...",
     check(ctx): RuleResult {
       return { ruleId: "MY_RULE", severity: "hard", passed: true };
     },
   };
   ```
2. Add it to the rules array exported by that file.
3. It will be registered automatically via `bootstrap.ts`.

---

## How This Can Become a Dynamic Platform

This codebase is intentionally SuccessVan-specific. When you are ready to generalize:

1. The `contextProvider` can be made configurable per tenant.
2. The `workflowState` step graph can be loaded from a config file or database.
3. Tools can be tagged by tenant and filtered at runtime.
4. Rules and guardrails can be loaded from a rule engine DSL.
5. The `stateManager`, `memoryStore`, and metrics recorder all implement interfaces — swap to Redis/MongoDB/Prometheus by creating a new implementation.

The pattern is: **SuccessVan first, platform second**.

---

## Reservation Rules Reference

See `RESERVATION_RULES.md` for the full source of truth for reservation business rules.

See `docs/rules-mapping.md` for the mapping of each rule to its implementation status.
