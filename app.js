// app.js
import "dotenv/config";
import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";

const app = Fastify({ logger: true });

await app.register(fastifyFormBody);

// Health
app.get("/", async () => ({ ok: true }));

// Twilio webhook (HTTP) — stays on Vercel
app.all("/incoming-call", async (request, reply) => {
  const host = request.headers.host;
  // IMPORTANT: point WebSocket URL to your WS host (not Vercel)
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://customer-service-agent-pi.vercel.app/media-stream" />
  </Connect>
</Response>`.trim();

  reply.type("text/xml").send(twiml);
});

export default app;
