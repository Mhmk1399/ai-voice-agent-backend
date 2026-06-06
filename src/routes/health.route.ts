import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      ok: true,
      service: "voice-agent-api",
      time: new Date().toISOString(),
    };
  });
}