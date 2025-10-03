// csrAgent.js
import { RealtimeAgent, tool, backgroundResult } from "@openai/agents/realtime";
import { z } from "zod";
// import { Db, DatabaseServer } from "./utils/mapepire.js";

import { getDb } from "./utils/mapepire.js";

// ---------- DB init + helpers ----------
// const db = new Db();
// await db.connect(DatabaseServer);

// Pick your library/schema via env (default IRISLIB). Db2 for i likes uppercase schema names.
const SCHEMA = (process.env.DB_SCHEMA || "IRISLIB").toUpperCase();
const T = (name) => `${SCHEMA}.${name}`;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return true;
  const db = await getDb();
  if (!db) return false; // ← let caller decide what to do
  try {
    await db.query(`SET CURRENT SCHEMA ${SCHEMA}`);
    console.log(`Current schema set to ${SCHEMA}`);
  } catch (e) {
    console.warn(
      "Could not SET CURRENT SCHEMA; relying on qualified names only.",
      e?.message || e
    );
  }
  schemaReady = true;
  return true;
}

// Set the default/current schema once (so unqualified names still work if you add any later)
// try {
//   await db.query(`SET CURRENT SCHEMA ${SCHEMA}`);
//   console.log(`Current schema set to ${SCHEMA}`);
// } catch (e) {
//   console.warn(
//     "Could not SET CURRENT SCHEMA; will rely on qualified names only.",
//     e?.message || e
//   );
// }

// Simple query helper with strong logging + lazy DB
async function q(sql, params = []) {
  const db = await getDb();
  if (!db) throw new Error("db_unavailable");
  await ensureSchema();
  try {
    const res = await db.query(sql, params);
    const rows = res?.data || res?.rows || res || [];
    console.log(
      "SQL OK:",
      sql,
      params,
      "→",
      Array.isArray(rows) ? rows.length : typeof rows
    );
    return rows;
  } catch (err) {
    console.error("SQL FAIL:", sql, params, "\n", err?.message || err);
    throw err;
  }
}
// // Simple query helper with strong logging
// async function q(sql, params = []) {
//   try {
//     const res = await db.query(sql, params);
//     const rows = res?.data || res?.rows || res || [];
//     console.log(
//       "SQL OK:",
//       sql,
//       params,
//       "→",
//       Array.isArray(rows) ? rows.length : typeof rows
//     );
//     return rows;
//   } catch (err) {
//     console.error("SQL FAIL:", sql, params, "\n", err?.message || err);
//     throw err;
//   }
// }

const maskEmail = (e) => (e ? e.replace(/(.).+(@.+)/, "$1***$2") : "");
const maskPhone = (p) => (p ? p.replace(/(\d{3}).+(\d{2})$/, "$1***$2") : "");

// ---------------- TOOLS ----------------

// 1) get_product: both strings REQUIRED; pass "" for the one you don't use
const getProduct = tool({
  name: "get_product",
  description:
    "Fetch a product by SKU or by name fragment. If one is unknown, pass an empty string for it.",
  parameters: z.object({
    sku: z.string(), // REQUIRED (use "")
    name_query: z.string(), // REQUIRED (use "")
  }),
  async execute({ sku, name_query }) {
    try {
      console.log("get_product", { sku, name_query });
      const s = (sku || "").trim();
      const nq = (name_query || "").trim();
      if (!s && !nq)
        return { found: false, reason: "Provide sku or name_query" };

      let rows = [];
      if (s) {
        rows = await q(
          `SELECT SKU, NAME, CATEGORY, PRICE, SHORT_DESC
             FROM ${T("PRODUCTS")}
            WHERE UPPER(SKU)=UPPER(?)`,
          [s]
        );
      } else {
        // Db2 for i: use || concat and UPPER(?) inside the pattern
        rows = await q(
          `SELECT SKU, NAME, CATEGORY, PRICE, SHORT_DESC
             FROM ${T("PRODUCTS")}
            WHERE UPPER(NAME) LIKE '%' || UPPER(?) || '%'
            FETCH FIRST 5 ROWS ONLY`,
          [nq]
        );
      }

      if (!Array.isArray(rows) || rows.length === 0) return { found: false };

      const p = rows[0];
      const specs = await q(
        `SELECT SPEC_KEY, SPEC_VAL
           FROM ${T("PRODUCT_SPECS")}
          WHERE SKU = ?
          ORDER BY SPEC_KEY`,
        [p.SKU]
      );

      return {
        found: true,
        product: {
          sku: p.SKU,
          name: p.NAME,
          category: p.CATEGORY,
          price: Number(p.PRICE),
          short_desc: p.SHORT_DESC,
          specs,
        },
      };
    } catch (e) {
      console.error("get_product error:", e);
      return { found: false, reason: "db_error" };
    }
  },
});

// 2) get_customer: both REQUIRED; pass 0 or "" when unknown; validate in execute
const getCustomer = tool({
  name: "get_customer",
  description:
    "Fetch a customer by ID or email. If one is unknown, pass 0 (id) or '' (email).",
  parameters: z.object({
    customer_id: z.number(), // REQUIRED (use 0)
    email: z.string(), // REQUIRED (use "")
  }),
  async execute({ customer_id, email }) {
    try {
      console.log("get_customer", { customer_id, email });
      const id = Number.isFinite(customer_id) ? customer_id : 0;
      const em = (email || "").trim();

      if (!(id > 0) && !em) {
        return {
          found: false,
          reason: "Provide a positive customer_id or a non-empty email",
        };
      }

      const rows =
        id > 0
          ? await q(
              `SELECT CUSTOMER_ID, NAME, EMAIL, PHONE, TIER, LIFETIME_VALUE
                 FROM ${T("CUSTOMERS")}
                WHERE CUSTOMER_ID = ?`,
              [id]
            )
          : await q(
              `SELECT CUSTOMER_ID, NAME, EMAIL, PHONE, TIER, LIFETIME_VALUE
                 FROM ${T("CUSTOMERS")}
                WHERE UPPER(EMAIL)=UPPER(?)`,
              [em]
            );

      if (!rows.length) return { found: false };

      const c = rows[0];
      const recent = await q(
        `SELECT ORDER_NO, ORDER_DATE, STATUS, TOTAL
           FROM ${T("ORDERS")}
          WHERE CUSTOMER_ID = ?
          ORDER BY ORDER_DATE DESC
          FETCH FIRST 5 ROWS ONLY`,
        [c.CUSTOMER_ID]
      );

      return {
        found: true,
        customer: {
          id: c.CUSTOMER_ID,
          name: c.NAME,
          email: maskEmail(c.EMAIL),
          phone: maskPhone(c.PHONE),
          tier: c.TIER,
          lifetime_value: Number(c.LIFETIME_VALUE),
        },
        recent_orders: recent.map((o) => ({
          order_no: o.ORDER_NO,
          order_date: o.ORDER_DATE,
          status: o.STATUS,
          total: Number(o.TOTAL),
        })),
      };
    } catch (e) {
      console.error("get_customer error:", e);
      return { found: false, reason: "db_error" };
    }
  },
});

// 3) get_order
const getOrder = tool({
  name: "get_order",
  description:
    "Fetch an order by number with line items and masked customer snapshot.",
  parameters: z.object({ order_no: z.number() }),
  async execute({ order_no }) {
    try {
      console.log("get_order", { order_no });
      const header = await q(
        `SELECT * FROM ${T("ORDERS")} WHERE ORDER_NO = ?`,
        [order_no]
      );
      if (!header.length) return { found: false };

      const o = header[0];
      const lines = await q(
        `SELECT LINE_NO, SKU, DESCRIPTION, QTY, UNIT_PRICE
           FROM ${T("ORDER_LINES")}
          WHERE ORDER_NO = ?
          ORDER BY LINE_NO`,
        [order_no]
      );
      const cust = await q(
        `SELECT CUSTOMER_ID, NAME, EMAIL, PHONE, TIER
           FROM ${T("CUSTOMERS")}
          WHERE CUSTOMER_ID = ?`,
        [o.CUSTOMER_ID]
      );
      const c = cust[0];

      return {
        found: true,
        order: {
          order_no: o.ORDER_NO,
          status: o.STATUS,
          order_date: o.ORDER_DATE,
          total: Number(o.TOTAL),
          carrier: o.CARRIER,
          tracking_no: o.TRACKING_NO,
          dest_city: o.DEST_CITY,
          dest_state: o.DEST_STATE,
          eta_date: o.ETA_DATE,
        },
        customer: c
          ? {
              id: c.CUSTOMER_ID,
              name: c.NAME,
              email: maskEmail(c.EMAIL),
              phone: maskPhone(c.PHONE),
              tier: c.TIER,
            }
          : null,
        lines: lines.map((l) => ({
          line_no: l.LINE_NO,
          sku: l.SKU,
          description: l.DESCRIPTION,
          qty: l.QTY,
          unit_price: Number(l.UNIT_PRICE),
          line_total: Number(l.QTY) * Number(l.UNIT_PRICE),
        })),
      };
    } catch (e) {
      console.error("get_order error:", e);
      return { found: false, reason: "db_error" };
    }
  },
});

// 4) track_order
const trackOrder = tool({
  name: "track_order",
  description: "Return shipping timeline for a given order number.",
  parameters: z.object({ order_no: z.number() }),
  async execute({ order_no }) {
    try {
      console.log("track_order", { order_no });
      const oarr = await q(
        `SELECT CARRIER, TRACKING_NO, ETA_DATE FROM ${T(
          "ORDERS"
        )} WHERE ORDER_NO = ?`,
        [order_no]
      );
      const o = oarr[0];
      if (!o || !o.TRACKING_NO) return { found: false };

      const events = await q(
        `SELECT TS, CODE, LOCATION, NOTE
           FROM ${T("SHIP_EVENTS")}
          WHERE TRACKING_NO = ?
          ORDER BY TS`,
        [o.TRACKING_NO]
      );

      return {
        found: true,
        carrier: o.CARRIER,
        tracking_no: o.TRACKING_NO,
        eta_date: o.ETA_DATE,
        events,
      };
    } catch (e) {
      console.error("track_order error:", e);
      return { found: false, reason: "db_error" };
    }
  },
});

// 5) create_ticket (WRITE; approval)
const createTicket = tool({
  name: "create_ticket",
  description: "Create a support ticket (WRITE). Requires approval.",
  needsApproval: true,
  parameters: z.object({
    customer_id: z.number(),
    order_no: z.number(),
    topic: z.string(),
    summary: z.string(),
  }),
  async execute({ customer_id, order_no, topic, summary }) {
    try {
      console.log("create_ticket", { customer_id, order_no, topic, summary });
      const tid =
        "TCK-" +
        Math.floor(Math.random() * 1e6)
          .toString()
          .padStart(6, "0");
      await q(
        `INSERT INTO ${T("SUPPORT_TICKETS")}
           (TICKET_ID, CUSTOMER_ID, ORDER_NO, TOPIC, SUMMARY, STATUS, CREATED_AT)
         VALUES (?, ?, ?, ?, ?, 'OPEN', CURRENT_TIMESTAMP)`,
        [tid, customer_id, order_no, topic, summary]
      );
      return { ticket_id: tid, status: "OPEN" };
    } catch (e) {
      console.error("create_ticket error:", e);
      return { ok: false, reason: "db_error" };
    }
  },
});

// 6) add_order_note (WRITE; approval)
const addOrderNote = tool({
  name: "add_order_note",
  description: "Attach a note to an order (WRITE). Requires approval.",
  needsApproval: true,
  parameters: z.object({
    order_no: z.number(),
    note: z.string().min(3),
  }),
  async execute({ order_no, note }) {
    try {
      await q(
        `INSERT INTO ${T("ORDER_NOTES")} (ORDER_NO, TS, NOTE)
         VALUES (?, CURRENT_TIMESTAMP, ?)`,
        [order_no, note]
      );
      return backgroundResult(`Note added to order ${order_no}.`);
    } catch (e) {
      console.error("add_order_note error:", e);
      return { ok: false, reason: "db_error" };
    }
  },
});

// 7) apology_haiku
const apologyHaiku = tool({
  name: "apology_haiku",
  description: "Friendly haiku for delays.",
  parameters: z.object({ topic: z.string() }),
  async execute({ topic }) {
    const list = [
      `boxes on their path\npatience rides each mile with care\nsoon—a knock, a smile`,
      `winds slow the journey\nbut your parcel finds its way\nthank you for waiting`,
      `routes across the night\ntracking stars and city lights\nmorning brings your box`,
    ];
    return list[Math.floor(Math.random() * list.length)];
  },
});

// ---------- Agent ----------
const csrAgent = new RealtimeAgent({
  name: "IRis CSR",
  instructions: `
You are a voice Customer Service agent for IRis (electronics).
Be concise, use tools for facts, mask PII, and seek approval for any writes.
Product lineup:
- IRis One (smartphone) – all-day battery, great low-light camera
- IRis Buds (earbuds) – comfy fit, ANC, 24h case
- IRis Watch (smartwatch) – HR, sleep, 7-day battery
- IRis Tab (tablet) – 11", split-screen, stylus

Flows:
- Product Qs → get_product (by sku or name fragment; pass "" when unknown)
- Order status → get_order then track_order
- Issue → create_ticket (approval), offer apology_haiku
- Add note → add_order_note (approval)
`,
  tools: [
    getProduct,
    getCustomer,
    getOrder,
    trackOrder,
    createTicket,
    addOrderNote,
    apologyHaiku,
  ],
});

export default csrAgent;
