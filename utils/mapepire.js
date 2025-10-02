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
  const m = san.match(/DNS:([^,\s]+)/i);
  return m ? m[1] : null;
}

async function fetchCert(host) {
  const cert = await getCertificate({ host });
  // Some versions expose .pem and .raw; normalize so we always return PEM string and raw Buffer.
  const pem = cert.pem || (cert.raw ? bufferToPem(cert.raw) : undefined);
  const raw = cert.raw || (pem ? Buffer.from(pem) : undefined);
  if (!pem && !raw) throw new Error("Could not obtain server certificate");
  return { pem, raw, subject: cert.subject, san: cert.subjectAltName };
}

function bufferToPem(buf) {
  const b64 = Buffer.isBuffer(buf)
    ? buf.toString("base64")
    : Buffer.from(buf).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

async function ensureCertificate({ host, certPath }) {
  // If a cache path is provided and exists, use it as PEM string
  if (certPath && existsSync(certPath)) {
    const pem = readFileSync(certPath, "utf8");
    return { pem, raw: Buffer.from(pem), subject: null, san: null };
  }
  const cert = await fetchCert(host);
  if (certPath) {
    try {
      mkdirSync(dirname(certPath), { recursive: true });
      writeFileSync(certPath, cert.pem, "utf8");
    } catch {
      /* ignore */
    }
  }
  return cert;
}

export async function buildServerFromEnv() {
  const DB_HOST = process.env.DB_HOST || process.env.DB2_HOST;
  const DB_USER = process.env.DB_ID || process.env.DB2_USER;
  const DB_PASS = process.env.DB_PASSWORD || process.env.DB2_PASS;
  const DB_SNI = process.env.DB_SNI || process.env.DB2_SNI || "";
  const DB_CERT_PATH = process.env.DB_CERT_PATH
    ? process.env.DB_CERT_PATH.startsWith("/")
      ? process.env.DB_CERT_PATH
      : join(process.cwd(), process.env.DB_CERT_PATH)
    : null; // no cache by default; set DB_CERT_PATH=./certs/mapepire.pem to cache

  if (!DB_HOST || !DB_USER || !DB_PASS) {
    throw new Error(
      "Missing DB_HOST/DB2_HOST, DB_ID/DB2_USER, or DB_PASSWORD/DB2_PASS"
    );
  }

  const cert = await ensureCertificate({
    host: DB_HOST,
    certPath: DB_CERT_PATH,
  });

  // Helpful one-time log:
  console.log("Mapepire cert:", { CN: cert.subject?.CN, SAN: cert.san });

  let servername =
    DB_SNI || firstDnsFromSAN(cert.san) || cert.subject?.CN || "";
  const needSni =
    isIpHost(DB_HOST) || (servername && !DB_HOST.startsWith(servername));

  // IMPORTANT: give TLS a concrete ca (string PEM or Buffer). Do NOT pass [undefined].
  const caValue = cert.pem || cert.raw; // prefer PEM string

  const server = {
    host: DB_HOST, // include port; no protocol prefix
    user: DB_USER,
    password: DB_PASS,
    ca: caValue, // <- string or Buffer; valid type
    ignoreUnauthorized: false, // verify using our CA
  };
  if (needSni && servername) server.tls = { servername };

  return server;
}

export class Db {
  constructor() {
    this.pool = undefined;
  }

  // server: { host, user, password, ca, ignoreUnauthorized, tls? }
  async connect(server) {
    // If no CA provided, fetch and attach one now
    if (!server.ca) {
      const cert = await fetchCert(server.host);
      server.ca = cert.pem || cert.raw;
      if (!server.ignoreUnauthorized) server.ignoreUnauthorized = false;
      if ((!server.tls || !server.tls.servername) && isIpHost(server.host)) {
        const guess = firstDnsFromSAN(cert.san) || cert.subject?.CN || "";
        if (guess) server.tls = { ...(server.tls || {}), servername: guess };
      }
    }
    this.pool = new Pool({ creds: server, maxSize: 5, startingSize: 1 });
    await this.pool.init();
  }

  async query(statement, bindingsValues = []) {
    if (!this.pool) throw new Error("Database not connected");
    return this.pool.execute(statement, { parameters: bindingsValues });
  }
}

// Ready-to-use server from env (keep your old shape)
export const DatabaseServer = await buildServerFromEnv();
