import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { env } from "./config/env.js";
import { healthRoute } from "./routes/health.route.js";
import { voiceWebWsRoute, voiceWsRoute } from "./ws/voice.ws.js";
import { phoneWsRoute } from "./ws/phone.ws.js";
import { connectMongo } from "./db/mongo.js";

async function main() {
  await connectMongo();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "info" : "warn",
    },
  });

  await app.register(websocket);

  // ── Routes ─────────────────────────────────────────────────────────────────

  await app.register(healthRoute);

  // New browser voice route — use this in your updated frontend
  await app.register(voiceWebWsRoute);  // ws://host/voice/web

  // Legacy route — kept for backward compat; remove after frontend migration
  await app.register(voiceWsRoute);     // ws://host/voice/ws  (deprecated)

  // Phone stream route — Twilio / SIP placeholder, not yet active
  await app.register(phoneWsRoute);     // ws://host/voice/twilio

  // ── Start ──────────────────────────────────────────────────────────────────

  await app.listen({
    port: env.PORT,
    host: "0.0.0.0",
  });

  app.log.info(`Server running on http://localhost:${env.PORT}`);
  app.log.info(`WebSocket (browser) → ws://localhost:${env.PORT}/voice/web`);
  app.log.info(`WebSocket (legacy)  → ws://localhost:${env.PORT}/voice/ws  [deprecated]`);
  app.log.info(`WebSocket (phone)   → ws://localhost:${env.PORT}/voice/twilio [stub]`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});