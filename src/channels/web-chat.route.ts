import type { FastifyInstance } from "fastify";
import { runAgentTurn } from "../engine/run-agent-turn.js";

// ─────────────────────────────────────────────────────────────────────────────
// POST /agent/successvan/text-turn
// Primary text channel for debugging the engine without voice.
// ─────────────────────────────────────────────────────────────────────────────

interface TextTurnBody {
  sessionId?: string;
  message: string;
}

export async function webChatRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: TextTurnBody }>(
    "/agent/successvan/text-turn",
    async (req, reply) => {
      const { sessionId, message } = req.body;

      if (!message || typeof message !== "string" || message.trim().length === 0) {
        return reply.status(400).send({ error: "message is required" });
      }

      const result = await runAgentTurn({
        sessionId,
        message: message.trim(),
        channel: "text",
      });

      return reply.send({
        sessionId: result.sessionId,
        reply: result.reply,
        bookingDraft: result.bookingDraft,
        workflowStep: result.workflowStep,
        missingFields: result.missingFields,
        toolCalls: result.toolCalls.map((tc) => ({
          tool: tc.toolName,
          success: tc.output.success,
          latencyMs: tc.latencyMs,
        })),
        metrics: result.metrics,
        evaluation: result.evaluation,
      });
    }
  );
}
