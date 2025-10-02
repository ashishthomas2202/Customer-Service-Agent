# IRis Voice Agent (Twilio ↔ OpenAI Realtime ↔ IBM i / Db2 via Mapepire)

Realtime, phone-based customer service agent for a fictional electronics brand **IRis**.
The agent talks to callers, **reads/writes** live data in **Db2 for i** via **Mapepire**, and gates writes (tickets/notes) behind approval.

## What you get

- **Voice agent** (OpenAI Realtime API) bridged to **Twilio** via WebSocket
- **Db2 for i** access using **@ibm/mapepire-js**
- Tools the agent can call:

  - `get_product`, `get_customer`, `get_order`, `track_order`
  - `create_ticket` (WRITE, approval), `add_order_note` (WRITE, approval)
  - `apology_haiku` (fun)

- Example **IRis** product catalog (phone, buds, watch, tablet)
- Realtime **barge-in** handling (interrupt with “stop”)
- **PII masking** in speech (email/phone)

---

## Requirements

- **Node.js** 20+ (macOS, Linux, or IBM i PASE)
- A **Twilio** account with a voice-capable phone number
- An **OpenAI API key** with Realtime access
- IBM i **Db2** network access (host/port, user, password)

---

## 1) Clone & install

```bash
git clone git@github.com:ashishthomas2202/Customer-Service-Agent.git realtime-agent
cd realtime-agent
npm i
```

---

## 2) Configure environment

Create `.env` in the project root:

```ini
# OpenAI
OPENAI_API_KEY=sk-...

# Server
PORT=4000

# Db2 for i (Mapepire)
DB_HOST=youribmi.yourdomain.com:64999   # host:port for Db2/Mapepire
DB_ID=MYUSER                            # IBM i profile
DB_PASSWORD=********
DB_SCHEMA=QGPL                          # library that holds your demo tables
```

> **Note on DB_SCHEMA:**
> Set this to the **library** where your tables live. If you follow the creation steps below and put tables in `QGPL`, use `DB_SCHEMA=QGPL`. If you created `IRISLIB`, set `DB_SCHEMA=IRISLIB`.

---

## 3) Create tables & seed data (Db2 for i)

Run the SQL below **in the library you chose** (e.g., `QGPL` or `IRISLIB`).
You can either:

- Prefix each object with the library, e.g. `QGPL.PRODUCTS`, or
- Run `SET CURRENT SCHEMA QGPL;` first, then run the unqualified DDL exactly as below.

```sql
-- PRODUCTS & SPECS
CREATE TABLE PRODUCTS (
  SKU         VARCHAR(32)    NOT NULL PRIMARY KEY,
  NAME        VARCHAR(64)    NOT NULL,
  CATEGORY    VARCHAR(24)    NOT NULL,
  PRICE       DECIMAL(10,2)  NOT NULL,
  SHORT_DESC  VARCHAR(256)
);

CREATE TABLE PRODUCT_SPECS (
  SKU       VARCHAR(32) NOT NULL,
  SPEC_KEY  VARCHAR(48) NOT NULL,
  SPEC_VAL  VARCHAR(96) NOT NULL,
  PRIMARY KEY (SKU, SPEC_KEY),
  FOREIGN KEY (SKU) REFERENCES PRODUCTS(SKU)
);

-- CUSTOMERS
CREATE TABLE CUSTOMERS (
  CUSTOMER_ID     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  NAME            VARCHAR(64),
  EMAIL           VARCHAR(128),
  PHONE           VARCHAR(32),
  TIER            VARCHAR(12),
  LIFETIME_VALUE  DECIMAL(12,2) DEFAULT 0
);

-- ORDERS & LINES
CREATE TABLE ORDERS (
  ORDER_NO     INTEGER PRIMARY KEY,
  CUSTOMER_ID  INTEGER NOT NULL,
  ORDER_DATE   DATE,
  STATUS       VARCHAR(20),
  TOTAL        DECIMAL(12,2),
  CARRIER      VARCHAR(20),
  TRACKING_NO  VARCHAR(32),
  DEST_CITY    VARCHAR(32),
  DEST_STATE   CHAR(2),
  ETA_DATE     DATE,
  FOREIGN KEY (CUSTOMER_ID) REFERENCES CUSTOMERS(CUSTOMER_ID)
);

CREATE TABLE ORDER_LINES (
  ORDER_NO     INTEGER,
  LINE_NO      INTEGER,
  SKU          VARCHAR(32),
  DESCRIPTION  VARCHAR(128),
  QTY          INTEGER,
  UNIT_PRICE   DECIMAL(10,2),
  PRIMARY KEY (ORDER_NO, LINE_NO),
  FOREIGN KEY (ORDER_NO) REFERENCES ORDERS(ORDER_NO),
  FOREIGN KEY (SKU) REFERENCES PRODUCTS(SKU)
);

-- SHIPPING EVENTS TIMELINE
CREATE TABLE SHIP_EVENTS (
  TRACKING_NO VARCHAR(32),
  TS          TIMESTAMP,
  CODE        VARCHAR(16),
  LOCATION    VARCHAR(64),
  NOTE        VARCHAR(128)
);

-- SUPPORT WRITES
CREATE TABLE SUPPORT_TICKETS (
  TICKET_ID    VARCHAR(16) PRIMARY KEY,
  CUSTOMER_ID  INTEGER,
  ORDER_NO     INTEGER,
  TOPIC        VARCHAR(48),
  SUMMARY      VARCHAR(256),
  STATUS       VARCHAR(16),
  CREATED_AT   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ORDER_NOTES (
  ORDER_NO  INTEGER,
  TS        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  NOTE      VARCHAR(256)
);

---------------------
-- SEED DATA
---------------------
-- Products (IRis brand)
INSERT INTO PRODUCTS VALUES
('IRIS-ONE',  'IRis One',  'PHONE',   699.00, 'All-day battery, great low-light camera'),
('IRIS-BUDS', 'IRis Buds', 'AUDIO',   129.00, 'Comfy fit, solid ANC, 24h case'),
('IRIS-WATCH','IRis Watch','WEARABLE',199.00, 'Heart rate, sleep, 7-day battery'),
('IRIS-TAB',  'IRis Tab',  'TABLET',  399.00, '11-inch display, split-screen, stylus');

INSERT INTO PRODUCT_SPECS VALUES
('IRIS-ONE','Battery','5000 mAh'),('IRIS-ONE','Camera','50MP main, Night mode'),('IRIS-ONE','Storage','128GB'),
('IRIS-BUDS','ANC','Hybrid ANC'),('IRIS-BUDS','Battery','6h buds + 18h case'),
('IRIS-WATCH','Battery','7 days'),('IRIS-WATCH','Sensors','HR, SpO2, sleep'),
('IRIS-TAB','Display','11-inch 1200p'),('IRIS-TAB','RAM','6GB'),('IRIS-TAB','Stylus','Supported');

-- Customers
INSERT INTO CUSTOMERS (NAME, EMAIL, PHONE, TIER, LIFETIME_VALUE) VALUES
('John Smith','john@example.com','555-2010','VIP',12000.00),
('Mia Chen','mia@example.com','555-3030','STD',3400.50);

-- Orders & lines
INSERT INTO ORDERS (ORDER_NO, CUSTOMER_ID, ORDER_DATE, STATUS, TOTAL, CARRIER, TRACKING_NO, DEST_CITY, DEST_STATE, ETA_DATE) VALUES
(102456, 1, CURRENT_DATE - 3 DAYS, 'IN_TRANSIT', 699.00, 'UPS', '1Z999AA', 'Queens', 'NY', CURRENT_DATE + 2 DAYS),
(102457, 2, CURRENT_DATE - 1 DAYS, 'PICKED',     199.00, 'FEDEX','777ABC', 'Newark', 'NJ', CURRENT_DATE + 3 DAYS);

INSERT INTO ORDER_LINES VALUES
(102456, 1, 'IRIS-ONE',  'IRis One smartphone', 1, 699.00),
(102457, 1, 'IRIS-WATCH','IRis Watch',          1, 199.00);

-- Shipping timeline
INSERT INTO SHIP_EVENTS VALUES
('1Z999AA', CURRENT_TIMESTAMP - 2 DAYS, 'PICKED',   'Warehouse',  'Picked'),
('1Z999AA', CURRENT_TIMESTAMP - 1 DAYS, 'DEPARTED', 'Secaucus NJ','Departed facility'),
('1Z999AA', CURRENT_TIMESTAMP - 6 HOURS,'ARRIVED',  'Maspeth NY', 'Arrived facility');
```

**Verify quickly:**

```sql
SELECT COUNT(*) FROM PRODUCTS;
SELECT COUNT(*) FROM ORDERS;
```

If you put these in `QGPL`, ensure `.env` has `DB_SCHEMA=QGPL`. If you created `IRISLIB`, set `DB_SCHEMA=IRISLIB`.

> **IBM i tip:** If you created tables in a user library (e.g., `ASHISH`) and want to use unqualified names, add it to the job’s library list:
> `CALL QSYS2.QCMDEXC('ADDLIBLE LIB(ASHISH) POSITION(*FIRST)')`

---

## 4) Start the server

```bash
npm start
```

You should see logs like:

```
Listening on :4000
Realtime session connected.
```

---

## 5) Expose the server publicly (ngrok)

```bash
ngrok http 4000
```

Copy the **https** URL it prints (e.g., `https://abc123.ngrok.io`).

---

## 6) Wire Twilio to your server

1. Log in to **Twilio Console** → **Phone Numbers** → select your number.
2. Under **Voice & Fax → A CALL COMES IN**, set:

   - **Webhook URL**: `https://<your-ngrok-subdomain>.ngrok.io/incoming-call`
   - **HTTP Method**: `POST`

3. Save.

> This tells Twilio: on incoming calls, fetch `/incoming-call`, then open a **WebSocket** to `/media-stream` to stream PCM audio both ways.

---

## 7) Use it

- Call your Twilio number.
- The agent connects in real time. Try:

  - “Tell me about **IRis One**.”
  - “What’s the status of **order 102456**?”
  - “**Track** that order.”
  - “The phone arrived **cracked**. **Open a support ticket**.” → say “**Approved**.”
  - “**Add a note** to order 102456: **customer prefers morning delivery**.” → “**Approved**.”
  - (Interrupt while it’s talking) “**Stop. Just the ETA.**”
  - “Give me an **apology haiku**.”

Watch your terminal for **tool calls and SQL** (success and row counts).

---

## How it works (high level)

**Phone Call → Twilio → WebSocket → `TwilioRealtimeTransportLayer` → OpenAI Realtime API**
                        ↓
                    **RealtimeAgent + Tools → Db2 (Mapepire)**
                        ↓
**Audio Response → Twilio → Phone Call**

- **`TwilioRealtimeTransportLayer`** bridges Twilio Media Streams to OpenAI Realtime:

  - Handles protocol differences, audio formats (μ-law 8kHz), chunking, and interruptions.

- The **agent** decides when to call **tools**. Each tool runs SQL via **@ibm/mapepire-js**.
- **Writes** (`create_ticket`, `add_order_note`) require **approval**.

---

## Troubleshooting

- **“SQL0204 … \*FILE not found”**
  Your `.env: DB_SCHEMA` doesn’t match the library where you created tables.

  - Check where they are:

    ```sql
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM QSYS2.SYSTABLES
    WHERE TABLE_NAME IN ('PRODUCTS','ORDERS','ORDER_LINES','CUSTOMERS',
                         'PRODUCT_SPECS','SHIP_EVENTS','SUPPORT_TICKETS','ORDER_NOTES');
    ```

  - Set `DB_SCHEMA` to that `TABLE_SCHEMA`, restart.

- **Agent says “technical difficulty” after a tool call**
  Look at server logs for `SQL FAIL:`. Fix the SQL or schema; try again.
- **No audio / call drops**

  - Confirm Twilio webhook points to your current **ngrok** HTTPS URL.
  - Keep server running and reachable on the same port as `ngrok http 4000`.

- **Latency or choppy audio**

  - Proximity matters: Twilio ↔ your server ↔ OpenAI. Prefer regions close to your server.

- **Permissions** (rare)
  Ensure your IBM i user has _USE_ authority on the library and _EXECUTE_ on the library object.
  Example (ask an admin):

  ```
  GRTOBJAUT OBJ(QGPL/*ALL) OBJTYPE(*FILE) USER(MYUSER) AUT(*USE)
  GRTOBJAUT OBJ(QGPL) OBJTYPE(*LIB) USER(MYUSER) AUT(*EXECUTE)
  ```

---

## Demo script (quick)

1. “Tell me about **IRis One**.”
2. “Compare it with **IRis Tab** for **travel**.”
3. “What’s the status of **order 102456**?”
4. “**Track** that order.”
5. “Open a **support ticket**: **screen cracked**.” → “**Approved**.”
6. “**Add a note** to order 102456: **customer prefers morning delivery**.” → “**Approved**.”
7. (Interrupt) “**Stop. ETA only.**”
8. “An **apology haiku**, please.”

---

## Notes

- The code auto-masks PII (email/phone) in voice responses.
- The agent can reply in whatever language the caller speaks (no settings required).
- You can customize tools, approvals, and prompts in `csrAgent.js` (or your agent file).

Happy demoing! 🎤📞💬🗄️
