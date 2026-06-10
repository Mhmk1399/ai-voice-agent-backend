import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { env } from "../config/env.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /realtime/session
// Creates an OpenAI Realtime ephemeral session token.
// OPENAI_API_KEY never reaches the browser.
// ─────────────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function realtimeSessionRoute(app: FastifyInstance): Promise<void> {
  app.get("/realtime/session", async (_req, reply) => {
    try {
      // Create an ephemeral token for the browser to connect to OpenAI Realtime
      const session = await (openai.beta as any).realtime?.sessions?.create?.({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
      });

      if (!session) {
        return reply.status(503).send({
          error: "OpenAI Realtime sessions API not available in this SDK version.",
          hint: "Upgrade openai SDK or use the /agent/successvan/text-turn endpoint for text-based testing.",
        });
      }

      return reply.send({
        client_secret: session.client_secret,
        session_id: session.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
