import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "successvan-agent-backend",
      timestamp: new Date().toISOString(),
    };
  });
}