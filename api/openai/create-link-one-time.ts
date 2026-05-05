/*
  ==================================================
  FantasMIA / Fantasmia - API CREATE LINK ONE-TIME NSU
  ==================================================

  SCOPO DEL MODULO

  Questo endpoint Vercel genera un link NSU one-time o permanente
  per accesso a Fantasmia.

  L’endpoint è riservato ad ADMIN e richiede:

  - Authorization: Bearer <ADMIN_JWT>

  Il token generato contiene un payload firmato via HMAC con:

  - username NSU
  - tipo token: NSU_ONE_TIME
  - durata sessione ttl_h
  - scadenza invito invite_exp
  - eventuale flag permanent
  - eventuale label descrittiva
  - eventuali metadati:
      client_email
      su_email

  COMPORTAMENTO TOKEN STANDARD

  Se permanent NON è true:

  - il link ha una finestra di invito temporanea
  - invite_exp viene impostato a circa 12 ore
  - invite_exp_at viene restituito in risposta
  - dopo il claim, la sessione frontend usa ttl_h

  COMPORTAMENTO TOKEN PERMANENTE

  Se permanent = true:

  - il token viene marcato come permanente
  - invite_exp viene impostato a 10 anni nel futuro
  - invite_exp_at viene restituito come null per chiarezza frontend
  - il claim-link corrispondente non blocca il token per scadenza breve

  NOTA REDIS / DATABASE

  Questo endpoint è stateless:

  - non usa Redis / Upstash
  - non salva token
  - non crea sessioni lato database
  - non è direttamente influenzato dal cambio database Redis

  SICUREZZA

  - Il token ADMIN viene verificato con HS256 usando:
      ADMIN_JWT_SECRET

  - Il token NSU viene firmato con HMAC SHA-256 usando:
      NSU_ONE_TIME_SECRET

  - Non inserire segreti nel codice sorgente.
  - Non loggare token, payload sensibili o segreti.

  CONFIGURAZIONE LINK

  Il link finale viene costruito usando:

      PUBLIC_BASE_URL

  Se PUBLIC_BASE_URL non è definito, viene usato il fallback:

      https://fantasmia.it

  Se si vuole usare il nuovo dominio pubblico, impostare in Vercel:

      PUBLIC_BASE_URL=https://fantas-ia.it

  CORS

  Ricordarsi di mantenere allineata la allowlist domini con:

  - fantasmia.it
  - www.fantasmia.it
  - fantas-ia.it
  - www.fantas-ia.it
  - domini preview Lovable
  - localhost di sviluppo
*/
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

/*
Scopo del modulo

Questo endpoint Vercel genera un link one-time per accesso NSU a Fantasmia,
autorizzato da token Bearer ADMIN.

Rispetto alla versione precedente, supporta anche metadati estesi per i link
remoti e/o permanenti:

- permanent: se true il link non scade nella normale finestra breve
- client_email: email del cliente NSU remoto
- su_email: email del Superuser destinatario / riferimento

Scelte implementative

- Il token continua a essere auto-contenuto e firmato via HMAC, senza dipendenze esterne.
- I nuovi campi vengono salvati direttamente nel payload firmato del token.
- Se permanent = true:
  - il token viene marcato come permanente
  - invite_exp viene impostato a 10 anni nel futuro, per compatibilità con
    eventuale codice esistente che si aspetti comunque un campo temporale
- La risposta mantiene i campi già presenti e aggiunge anche "url" come alias
  di "link", così da supportare frontend o test che si aspettano { token, url }.
*/

type ApiOk = {
  ok: true;
  username: string;
  ttl_h: number;
  invite_exp_at: string | null;
  token: string;
  link: string;
  url: string;
  permanent: boolean;
  client_email?: string;
  su_email?: string;
};

type ApiErr = { ok: false; error: string };

type Body = {
  username?: string;
  label?: string;
  ttl_h?: number;
  permanent?: boolean;
  client_email?: string;
  su_email?: string;
};

// ✅ CORS allowlist (con credentials non puoi usare "*")
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  /^https:\/\/.*\.lovableproject\.com$/,
  /^https:\/\/.*\.lovable\.app$/,
  "https://lovable.app",
  "https://www.lovable.app",
  "https://lovable.dev",
  /^https:\/\/.*\.lovable\.dev$/,
  "http://localhost:5173",
  "http://localhost:3000",
];

function isOriginAllowed(origin: string) {
  return allowedOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
}

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, X-Requested-With, Authorization"
    );
    res.setHeader("Vary", "Origin");
    return true;
  }
  if (!origin) return true; // server-to-server
  return false;
}

// --------------------
// ADMIN Bearer JWT verify (HS256) — no deps
// --------------------
function b64urlToBuf(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64");
}

function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHS256(data: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyAdminBearer(req: NextApiRequest): { ok: true } | { ok: false; error: string } {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return { ok: false, error: "Missing ADMIN_JWT_SECRET" };

  const auth = (req.headers.authorization || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "Missing Bearer token" };
  }

  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Invalid token format" };

  const [hB64, pB64, sig] = parts;
  const toSign = `${hB64}.${pB64}`;
  const expectedSig = signHS256(toSign, secret);

  if (!safeEqual(sig, expectedSig)) {
    return { ok: false, error: "Invalid token signature" };
  }

  let payload: any = null;
  try {
    payload = JSON.parse(b64urlToBuf(pB64).toString("utf8"));
  } catch {
    return { ok: false, error: "Invalid token payload" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload?.exp === "number" ? payload.exp : 0;

  if (!exp || nowSec >= exp) return { ok: false, error: "Token expired" };
  if (payload?.role !== "ADMIN") return { ok: false, error: "Not an admin token" };

  return { ok: true };
}

// --------------------
// One-time token helpers (HMAC over payload JSON)
// --------------------
function signOneTime(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function randomUsername() {
  const s = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `NSU-${s}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!corsOk) {
      return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    }
    return res.status(204).end();
  }

  if (!corsOk) {
    return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ✅ Admin authorization via Bearer JWT
  const adminCheck = verifyAdminBearer(req);
  if (!adminCheck.ok) {
    return res.status(401).json({ ok: false, error: adminCheck.error });
  }

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });
  }

  // Body parsing robusto
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const username = (body.username || "").trim() || randomUsername();

  // ttl_h: 1..24 (durata sessione dopo claim)
  const ttlRaw = typeof body.ttl_h === "number" ? body.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttlRaw), 24));

  const permanent = body.permanent === true;
  const client_email = normalizeOptionalString(body.client_email);
  const su_email = normalizeOptionalString(body.su_email);
  const label = normalizeOptionalString(body.label);

  const now = Date.now();

  // Per compatibilità:
  // - link temporaneo: 12 ore
  // - link permanente: 10 anni
  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const invite_exp_ms = permanent
    ? now + TEN_YEARS_MS
    : now + 12 * 60 * 60 * 1000;

  const payload = {
    v: 2,
    type: "NSU_ONE_TIME",
    username,
    ttl_h,
    iat: now,
    invite_exp: invite_exp_ms,
    permanent,
    label,
    client_email,
    su_email,
  };

  const payloadJson = JSON.stringify(payload);
  const sig = signOneTime(payloadJson, secret);
  const token = `${b64url(payloadJson)}.${sig}`;

  const baseUrl = (process.env.PUBLIC_BASE_URL || "https://fantasmia.it").replace(/\/$/, "");
  const link = `${baseUrl}/one-time?token=${encodeURIComponent(token)}`;

  return res.status(200).json({
    ok: true,
    username,
    ttl_h,
    invite_exp_at: permanent ? null : new Date(invite_exp_ms).toISOString(),
    token,
    link,
    url: link,
    permanent,
    client_email,
    su_email,
  });
}
