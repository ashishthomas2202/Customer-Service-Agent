// server.js (ESM)
// Run with: node server.js
import "dotenv/config";
import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { RealtimeSession } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import csrAgent from "./csrAgent.js";
import { getDb } from "./utils/mapepire.js"; // ← for /db-ping

const { OPENAI_API_KEY, PORT = 5050 } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const fastify = Fastify({
  logger: false, // flip to true if you want Fastify's built-in logger
});

// Extra safety: surface unexpected errors without crashing silently
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) =>
  console.error("unhandledRejection:", e)
);

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// Health
fastify.get("/", async () => ({ ok: true }));

// DB quick check (optional but very handy in Koyeb)
fastify.get("/db-ping", async () => {
  const db = await getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  try {
    const r = await db.query("VALUES CURRENT_DATE");
    return { ok: true, rows: r?.data ?? r };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

// Twilio webhook → open a media stream. No <Say>; agent greets first.
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers.host;
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`.trim();
  reply.type("text/xml").send(twiml);
});

// Media stream WebSocket (Twilio PCM ↔ Realtime)
fastify.register(async (app) => {
  app.get("/media-stream", { websocket: true }, async (connection) => {
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: connection,
    });

    const session = new RealtimeSession(csrAgent, {
      transport,
      model: "gpt-realtime",
      config: {
        audio: { output: { voice: "coral" } },
        inputAudioTranscription: { model: "gpt-4o-mini-transcribe" },
        turnDetection: {
          type: "semantic_vad",
          eagerness: "medium",
          createResponse: true,
          interruptResponse: true,
        },
      },
    });

    session.on("error", (e) => {
      console.error("Realtime session error:", e);
    });

    // Demo: auto-approve actions that need approval (flip off in prod)
    session.on("tool_approval_requested", (_ctx, _ag, req) => {
      const name = req?.approvalItem?.rawItem?.name;
      console.log(`Auto-approving tool: ${name}`);
      session
        .approve(req.approvalItem)
        .catch((e) => console.error("Approval failed", e));
    });

    try {
      await session.connect({ apiKey: OPENAI_API_KEY });
      console.log("Realtime session connected.");
      // Nudge the agent to greet immediately.
      await (session.createResponse
        ? session.createResponse({
            instructions:
              "Caller connected. Greet briefly and ask how you can help.",
          })
        : session.sendUserMessage?.(
            "Caller connected. Please greet briefly and ask how to help."
          ));
    } catch (e) {
      console.error("Realtime connect failed:", e);
      try {
        connection.close();
      } catch {}
    }
  });
});

fastify.listen({ port: Number(PORT), host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Listening on :${PORT}`);
});

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach((s) =>
  process.on(s, async () => {
    console.log(`\n${s} received, shutting down…`);
    await fastify.close().catch(() => {});
    process.exit(0);
  })
);

// // server.js (ESM)
// // Run with: node server.js
// import "dotenv/config";
// import Fastify from "fastify";
// import fastifyFormBody from "@fastify/formbody";
// import fastifyWs from "@fastify/websocket";
// import { RealtimeSession } from "@openai/agents/realtime";
// import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
// import csrAgent from "./csrAgent.js";

// const { OPENAI_API_KEY, PORT = 5050 } = process.env;
// if (!OPENAI_API_KEY) {
//   console.error("Missing OPENAI_API_KEY");
//   process.exit(1);
// }

// const fastify = Fastify();
// await fastify.register(fastifyFormBody);
// await fastify.register(fastifyWs);

// // Health
// fastify.get("/", async (_req, reply) => reply.send({ ok: true }));

// // Twilio webhook → open a media stream. No <Say>; agent greets first.
// fastify.all("/incoming-call", async (request, reply) => {
//   const host = request.headers.host;
//   const twiml = `
// <?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Connect>
//     <Stream url="wss://${host}/media-stream" />
//   </Connect>
// </Response>`.trim();
//   reply.type("text/xml").send(twiml);
// });

// // Media stream WebSocket (Twilio PCM ↔ Realtime)
// fastify.register(async (app) => {
//   app.get("/media-stream", { websocket: true }, async (connection) => {
//     const transport = new TwilioRealtimeTransportLayer({
//       twilioWebSocket: connection,
//     });

//     const session = new RealtimeSession(csrAgent, {
//       transport,
//       model: "gpt-realtime",
//       config: {
//         audio: { output: { voice: "coral" } },
//         inputAudioTranscription: { model: "gpt-4o-mini-transcribe" },
//         turnDetection: {
//           type: "semantic_vad",
//           eagerness: "medium",
//           createResponse: true,
//           interruptResponse: true,
//         },
//       },
//     });

//     session.on("error", (e) => {
//       console.error("Realtime session error:", e);
//     });

//     // Demo: auto-approve actions that need approval (flip off in prod)
//     session.on("tool_approval_requested", (_ctx, _ag, req) => {
//       const name = req?.approvalItem?.rawItem?.name;
//       console.log(`Auto-approving tool: ${name}`);
//       session
//         .approve(req.approvalItem)
//         .catch((e) => console.error("Approval failed", e));
//     });

//     try {
//       await session.connect({ apiKey: OPENAI_API_KEY });
//       console.log("Realtime session connected.");
//       // Nudge the agent to greet immediately.
//       await (session.createResponse
//         ? session.createResponse({
//             instructions:
//               "Caller connected. Greet briefly and ask how you can help.",
//           })
//         : session.sendUserMessage?.(
//             "Caller connected. Please greet briefly and ask how to help."
//           ));
//     } catch (e) {
//       console.error("Realtime connect failed:", e);
//       try {
//         connection.close();
//       } catch {}
//     }
//   });
// });

// fastify.listen({ port: Number(PORT), host: "0.0.0.0" }, (err) => {
//   if (err) {
//     console.error(err);
//     process.exit(1);
//   }
//   console.log(`Listening on :${PORT}`);
// });

// // Graceful shutdown
// ["SIGINT", "SIGTERM"].forEach((s) =>
//   process.on(s, async () => {
//     console.log(`\n${s} received, shutting down…`);
//     await fastify.close().catch(() => {});
//     process.exit(0);
//   })
// );
