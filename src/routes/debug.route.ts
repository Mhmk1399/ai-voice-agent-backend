import type { FastifyInstance } from "fastify";
import { stateManager } from "../state/in-memory-state.manager.js";
import { memoryStore } from "../memory/in-memory-memory.store.js";
import {
  getMetrics,
  getRecentTraces,
  getTrace,
} from "../observability/metrics-recorder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Debug routes
// GET /debug/session/:sessionId  — inspect session state
// GET /debug/metrics             — aggregated KPIs
// GET /debug/trace/:turnId       — a specific turn trace
// ─────────────────────────────────────────────────────────────────────────────

export async function debugRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { sessionId: string } }>(
    "/debug/session/:sessionId",
    async (req, reply) => {
      const { sessionId } = req.params;
      const draft = await stateManager.load(sessionId);
      const memory = await memoryStore.read(sessionId);
      const stateStats = await stateManager.stats();

      return reply.send({
        sessionId,
        draft,
        transcript: memory.transcript,
        turnCount: memory.turnCount,
        stats: stateStats,
      });
    }
  );

  app.get("/debug/metrics", async (_req, reply) => {
    const stateStats = await stateManager.stats();
    const memStats = await memoryStore.stats();
    const metrics = getMetrics();

    // Patch active_sessions from live state
    metrics.global.active_sessions = stateStats.activeSessions;

    return reply.send({
      metrics,
      stateStats,
      memStats,
      collectedAt: new Date().toISOString(),
    });
  });

  app.get("/debug/traces", async (_req, reply) => {
    return reply.send({ traces: getRecentTraces(20) });
  });

  app.get<{ Params: { turnId: string } }>(
    "/debug/trace/:turnId",
    async (req, reply) => {
      const trace = getTrace(req.params.turnId);
      if (!trace) {
        return reply.status(404).send({ error: "Trace not found" });
      }
      return reply.send(trace);
    }
  );
}
