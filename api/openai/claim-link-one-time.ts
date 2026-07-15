/*
  ==================================================
  FantasMIA / Fantasmia - API CREATE LINK ONE-TIME NSU
  (Fase 2 patch — supporto autenticazione SuperUser)
  ==================================================

  NOTA PER L'UTENTE:
  Questo file va COPIATO nel repo Vercel `fantasmia-ai` al percorso:
      pages/api/openai/create-link-one-time.ts
  (sostituendo la versione precedente).

  ENV VARS RICHIESTE:
    - ADMIN_JWT_SECRET    (già presente)
    - NSU_ONE_TIME_SECRET (già presente)
    - PUBLIC_BASE_URL     (già presente, opzionale)
    - SU_SHARED_PASSWORD  (NUOVA) — password singola condivisa dai SuperUser.
                                     Es. "ssss" o valore scelto in Vercel.

  DIFFERENZE RISPETTO ALLA VERSIONE PRECEDENTE:
    1) L'autorizzazione ora ha DUE canali:
       - ADMIN: header Authorization: Bearer <JWT> (comportamento invariato).
       - SU:    body.password uguale a SU_SHARED_PASSWORD.
       Se manca il Bearer si prova la SU password nel body.
    2) Il body viene parsato PRIMA della verifica di autorizzazione,
       così `verifySuPassword` può leggerlo.
    3) I SU NON possono creare link permanenti: se `permanent: true`
       viene inviato da un SU, la risposta è 403.
       Gli ADMIN mantengono il pieno controllo (permanent OK).
    4) Nel payload firmato viene aggiunto `created_by` ("ADMIN" | "SU")
       per tracciabilità (usato dalla notifica email OT lato frontend).
    5) Nessun'altra modifica: firma HMAC, CORS, formato risposta,
       claim-link-one-time restano invariati.
*/

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

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
  created_by?: "ADMIN" | "SU";
};

type ApiErr = { ok: false; error: string };

type Body = {
  username?: string;
  label?: string;
  ttl_h?: number;
  permanent?: boolean;
  client_email?: string;
  su_email?: string;
  /** Password SU (alternativa al Bearer ADMIN) */
  password?: string;
};

// ✅ CORS allowlist (con credentials non puoi usare "*")
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  "https://fantas-ia.it",
  "https://www.fantas-ia.it",
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
// Helpers base64url / HMAC
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

// --------------------
// ADMIN Bearer JWT verify (HS256)
// --------------------
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
// SU shared-password verify
// --------------------
function verifySuPassword(body: Body): { ok: true } | { ok: false; error: string } {
  const expected = process.env.SU_SHARED_PASSWORD;
  if (!expected) return { ok: false, error: "SU auth not configured" };
  const provided = typeof body.password === "string" ? body.password : "";
  if (!provided) return { ok: false, error: "Missing SU password" };
  if (!safeEqual(provided, expected)) return { ok: false, error: "Invalid SU password" };
  return { ok: true };
}

// --------------------
// One-time token helpers
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

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }
  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Body parsing PRIMA dell'autorizzazione (serve a verifySuPassword)
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  // ✅ Autorizzazione a due canali: ADMIN Bearer JWT OPPURE SU password
  let caller: "ADMIN" | "SU";
  const hasBearer = (req.headers.authorization || "").toLowerCase().startsWith("bearer ");
  if (hasBearer) {
    const adminCheck = verifyAdminBearer(req);
    if (!adminCheck.ok) return res.status(401).json({ ok: false, error: adminCheck.error });
    caller = "ADMIN";
  } else {
    const suCheck = verifySuPassword(body);
    if (!suCheck.ok) return res.status(401).json({ ok: false, error: suCheck.error });
    caller = "SU";
  }

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

  const username = (body.username || "").trim() || randomUsername();

  // ttl_h: 1..24 (durata sessione dopo claim)
  const ttlRaw = typeof body.ttl_h === "number" ? body.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttlRaw), 24));

  // ⛔ SU non può creare link permanenti
  const requestedPermanent = body.permanent === true;
  if (caller === "SU" && requestedPermanent) {
    return res.status(403).json({ ok: false, error: "SU non può creare link permanenti" });
  }
  const permanent = requestedPermanent;

  const client_email = normalizeOptionalString(body.client_email);
  const su_email = normalizeOptionalString(body.su_email);
  const label = normalizeOptionalString(body.label);

  const now = Date.now();
  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const invite_exp_ms = permanent ? now + TEN_YEARS_MS : now + 12 * 60 * 60 * 1000;

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
    created_by: caller, // "ADMIN" | "SU"
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
    created_by: caller,
  });
}
