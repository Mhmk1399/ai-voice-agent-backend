# Legacy Code

This directory contains the original prototype/lab code that was replaced during the
SuccessVan receptionist orchestration refactor.

## What is here

| Directory | What it was |
|-----------|------------|
| `agent/` | Original booking agent with agent-orchestrator, entity-resolver, booking-draft, booking-question, booking-state, booking-validator |
| `ai/` | Direct OpenAI client wrapper |
| `sessions/` | Voice session store and manager (in-memory) |
| `voice/` | STT, TTS, transcription batch services |
| `ws/` | WebSocket handlers (voice.ws, phone.ws) |
| `realtime.route.ts` | Original /realtime/session route |
| `tools.route.ts` | Original /tools/process-booking-turn route |

## Why deprecated

The prototype mixed orchestration, voice transport, and business logic together.
The new architecture separates every concern into clean layers under `src/engine/`.

The entity resolver and context cache logic have been preserved and improved in:
- `src/context/successvan-context.provider.ts`
- `src/utils/normalize-text.ts`

The original booking types have been replaced by `src/state/booking-draft.types.ts`.

Do not import from this directory in production code.
