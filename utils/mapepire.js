// utils/mapepire.js
import mapepire from "@ibm/mapepire-js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const { Pool, getCertificate } = mapepire;
const __dirname = dirname(fileURLToPath(import.meta.url));

function isIpHost(hostWithPort = "") {
  const host = String(hostWithPort).split(":")[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":"); // ipv4/ipv6
}
function firstDnsFromSAN(san = "") {
  const m = san?.match?.(/DNS:([^,\s]+)/i);
  return m ? m[1] : null;
}
function bufferToPem(buf) {
  const b64 = Buffer.isBuffer(buf)
    ? buf.toString("base64")
    : Buffer.from(buf).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

async function fetchCert(host) {
  const cert = await getCertificate({ host });
  const pem = cert.pem || (cert.raw ? bufferToPem(cert.raw) : undefined);
  const raw = cert.raw || (pem ? Buffer.from(pem) : undefined);
  return { pem, raw, subject: cert.subject, san: cert.subjectAltName };
}

function readDbEnv() {
  const DB_HOST = process.env.DB_HOST || process.env.DB2_HOST;
  const DB_USER = process.env.DB_ID || process.env.DB2_USER;
  const DB_PASS = process.env.DB_PASSWORD || process.env.DB2_PASS;
  const DB_SNI = process.env.DB_SNI || process.env.DB2_SNI || "";
  const DB_CERT_PATH = process.env.DB_CERT_PATH
    ? process.env.DB_CERT_PATH.startsWith("/")
      ? process.env.DB_CERT_PATH
      : join(process.cwd(), process.env.DB_CERT_PATH)
    : null;
  const DB_CA_PEM = process.env.DB_CA_PEM || ""; // inline PEM
  const DB_TLS_INSECURE = /^true|1$/i.test(
    process.env.DB_TLS_INSECURE || "false"
  );
  const DB_LOG_CONFIG = /^true|1$/i.test(process.env.DB_LOG_CONFIG || "false");
  return {
    DB_HOST,
    DB_USER,
    DB_PASS,
    DB_SNI,
    DB_CERT_PATH,
    DB_CA_PEM,
    DB_TLS_INSECURE,
    DB_LOG_CONFIG,
  };
}

function pemFromEnvOrFile({ DB_CERT_PATH, DB_CA_PEM }) {
  if (DB_CA_PEM && DB_CA_PEM.includes("BEGIN CERTIFICATE")) return DB_CA_PEM;
  if (DB_CERT_PATH && existsSync(DB_CERT_PATH))
    return readFileSync(DB_CERT_PATH, "utf8");
  return null;
}

async function ensureCertificate({ host, certPath, inlinePem }) {
  // 1) Inline/file PEM → no network
  if (inlinePem)
    return {
      pem: inlinePem,
      raw: Buffer.from(inlinePem),
      subject: null,
      san: null,
    };
  if (certPath && existsSync(certPath)) {
    const pem = readFileSync(certPath, "utf8");
    return { pem, raw: Buffer.from(pem), subject: null, san: null };
  }
  // 2) Fallback to live fetch (requires open port)
  const cert = await fetchCert(host);
  if (certPath) {
    try {
      mkdirSync(dirname(certPath), { recursive: true });
      writeFileSync(certPath, cert.pem, "utf8");
    } catch {}
  }
  return cert;
}

let cachedServer = null;
export async function getDatabaseServer() {
  if (cachedServer) return cachedServer;

  const env = readDbEnv();
  const {
    DB_HOST,
    DB_USER,
    DB_PASS,
    DB_SNI,
    DB_CERT_PATH,
    DB_CA_PEM,
    DB_TLS_INSECURE,
    DB_LOG_CONFIG,
  } = env;

  if (!DB_HOST || !DB_USER || !DB_PASS) {
    console.warn(
      "DB env missing; database will be unavailable (boot continues)."
    );
    return null;
  }

  // ---------- IMPORTANT: In INSECURE mode, do NOT fetch any certs ----------
  if (DB_TLS_INSECURE) {
    const server = {
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASS,
      ignoreUnauthorized: true, // ← accept self-signed / no CA
    };
    // still set SNI if you supplied it or it’s needed for IP hostnames
    const needSni = isIpHost(DB_HOST) || !!DB_SNI;
    const servername = DB_SNI || "";
    if (needSni && servername) server.tls = { servername };
    if (DB_LOG_CONFIG) {
      console.log("DB server (insecure):", {
        host: DB_HOST,
        sni: servername || null,
      });
    }
    cachedServer = server;
    return cachedServer;
  }

  // ---------- Secure mode: use inline PEM / file / (last resort) fetch ----------
  try {
    const inlinePem = pemFromEnvOrFile({ DB_CERT_PATH, DB_CA_PEM });
    const cert = await ensureCertificate({
      host: DB_HOST,
      certPath: inlinePem ? null : DB_CERT_PATH,
      inlinePem,
    });

    let servername =
      DB_SNI || firstDnsFromSAN(cert.san) || cert.subject?.CN || "";
    const needSni =
      isIpHost(DB_HOST) || (servername && !DB_HOST.startsWith(servername));
    const caValue = cert.pem || cert.raw;

    const server = {
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASS,
      ca: caValue,
      ignoreUnauthorized: false,
    };
    if (needSni && servername) server.tls = { servername };
    if (DB_LOG_CONFIG) {
      console.log("DB server (secure):", {
        host: DB_HOST,
        sni: servername || null,
        caProvided: !!caValue,
      });
    }
    cachedServer = server;
    return cachedServer;
  } catch (e) {
    console.error("DB certificate preparation failed:", e?.message || e);
    return null;
  }
}

export class Db {
  constructor() {
    this.pool = undefined;
  }
  async connect(server) {
    if (!server) throw new Error("No database server config");
    // If secure mode AND no CA present, try to fetch as last resort (won’t run in insecure mode)
    if (!server.ignoreUnauthorized && !server.ca) {
      const cert = await fetchCert(server.host);
      server.ca = cert.pem || cert.raw;
      if ((!server.tls || !server.tls.servername) && isIpHost(server.host)) {
        const guess = firstDnsFromSAN(cert.san) || cert.subject?.CN || "";
        if (guess) server.tls = { ...(server.tls || {}), servername: guess };
      }
      if (!server.ignoreUnauthorized) server.ignoreUnauthorized = false;
    }
    this.pool = new Pool({ creds: server, maxSize: 5, startingSize: 1 });
    await this.pool.init();
  }
  async query(sql, params = []) {
    if (!this.pool) throw new Error("Database not connected");
    return this.pool.execute(sql, { parameters: params });
  }
}

// ---------- Lazy singleton with invalidation & single-flight ----------
let cachedDb = null;
let connecting = null;

export function invalidateDb() {
  cachedDb = null;
  connecting = null;
}

export async function getDb() {
  if (cachedDb) return cachedDb;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const server = await getDatabaseServer();
      if (!server) return null;
      const db = new Db();
      await db.connect(server);
      cachedDb = db;
      return cachedDb;
    } catch (e) {
      console.error("DB connect failed:", e?.message || e);
      cachedDb = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}
