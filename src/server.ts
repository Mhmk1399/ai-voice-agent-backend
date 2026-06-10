import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { env } from "./config/env.js";
import { connectMongo } from "./db/mongo.js";
import { bootstrap } from "./bootstrap.js";

// Routes
import { healthRoute } from "./routes/health.route.js";
import { debugRoute } from "./routes/debug.route.js";

// Channels
import { webChatRoute } from "./channels/web-chat.route.js";
import { webVoiceRoute } from "./channels/web-voice.route.js";
import { realtimeSessionRoute } from "./channels/realtime-session.route.js";

async function main(): Promise<void> {
  await connectMongo();
  bootstrap();

  const app = Fastify({
    logger: { level: env.NODE_ENV === "development" ? "info" : "warn" },
  });

  await app.register(websocket);

  await app.register(healthRoute);
  await app.register(webChatRoute);
  await app.register(webVoiceRoute);
  await app.register(realtimeSessionRoute);
  await app.register(debugRoute);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  app.log.info(`SuccessVan Agent Backend → http://localhost:${env.PORT}`);
  app.log.info(`Text turn  → POST http://localhost:${env.PORT}/agent/successvan/text-turn`);
  app.log.info(`Voice WS   → ws://localhost:${env.PORT}/voice/web`);
  app.log.info(`Realtime   → GET  http://localhost:${env.PORT}/realtime/session`);
  app.log.info(`Debug      → GET  http://localhost:${env.PORT}/debug/metrics`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
