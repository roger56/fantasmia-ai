/*
  ==================================================
  FantasMIA / Fantasmia - API CREATE LINK ONE-TIME NSU
  Autenticazione SUPERUSER + tracciabilità SU
  ==================================================

  SCOPO
  Questo endpoint crea link/token One-Time per NSU remoti.

  REGOLA ARCHITETTURALE
  - SOLO un SUPERUSER autenticato può creare One-Time Token.
  - ADMIN non può creare One-Time Token.
  - Il SUPERUSER viene identificato tramite JWT firmato con ADMIN_JWT_SECRET.
  - Il nome del SU (su_name) viene ricavato dal JWT verificato
    e NON viene accettato dal body della richiesta.

  TRACCIABILITÀ
  Il payload One-Time firmato contiene anche:
    - su_name: identificativo del SUPERUSER creatore
    - created_by: "SU"

  Questo consente di mantenere il legame:
      One-Time Token -> NSU -> SUPERUSER

  Il legame potrà essere utilizzato anche per:
    - instradamento delle storie NSU verso l'archivio del SU corretto;
    - attribuzione di utilizzi/consumi al SUPERUSER corretto;
    - futura contabilizzazione dei costi associati ai token e ai servizi AI.

  LINK PERMANENTI
  I One-Time Token creati dai SUPERUSER non possono essere permanenti.
  Una richiesta con permanent=true viene rifiutata con HTTP 403.

  ENV VARS RICHIESTE
    - ADMIN_JWT_SECRET
      Segreto usato per verificare il JWT del SUPERUSER.
    - NSU_ONE_TIME_SECRET
      Segreto HMAC usato per firmare il One-Time Token.
    - PUBLIC_BASE_URL
      Base URL pubblica usata per costruire il link (opzionale).

  NOTA
  SU_SHARED_PASSWORD non viene più utilizzata da questo endpoint.
  L'autenticazione legacy tramite password condivisa è stata rimossa.
*/

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiOk = {
  ok: true;
  username: string;
  su_name: string;
  ttl_h: number;
  invite_exp_at: string | null;
  token: string;
  link: string;
  url: string;
  permanent: boolean;
  client_email?: string;
  su_email?: string;
  created_by: "SU";
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
  "https://fantasmia-web.vercel.app",
  // Preview Vercel del frontend Fantasmia
/^https:\/\/fantasmia-web-.*\.vercel\.app$/,
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
// SUPERUSER Bearer JWT verify (HS256)
// Solo un SU autenticato può creare One-Time Token.
// Il nome del SU viene ricavato dal JWT verificato e NON dal body.
// --------------------
function verifySuBearer(
  req: NextApiRequest
): { ok: true; su_name: string } | { ok: false; error: string } {
  const secret = process.env.ADMIN_JWT_SECRET;

  if (!secret) {
    return { ok: false, error: "Missing ADMIN_JWT_SECRET" };
  }

  const auth = String(req.headers.authorization || "").trim();

  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "Missing Superuser Bearer token" };
  }

  const token = auth.slice(7).trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    return { ok: false, error: "Invalid token format" };
  }

  const [hB64, pB64, sig] = parts;
  const toSign = `${hB64}.${pB64}`;
  const expectedSig = signHS256(toSign, secret);

  if (!safeEqual(sig, expectedSig)) {
    return { ok: false, error: "Invalid token signature" };
  }

  let payload: any;

  try {
    payload = JSON.parse(b64urlToBuf(pB64).toString("utf8"));
  } catch {
    return { ok: false, error: "Invalid token payload" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload?.exp === "number" ? payload.exp : 0;

  if (!exp || nowSec >= exp) {
    return { ok: false, error: "Token expired" };
  }

  if (payload?.role !== "SUPERUSER") {
    return { ok: false, error: "Superuser only" };
  }

  const suName =
    typeof payload?.su_name === "string"
      ? payload.su_name.trim().toLowerCase()
      : "";

  if (!suName) {
    return { ok: false, error: "Missing su_name in Superuser token" };
  }

  return {
    ok: true,
    su_name: suName,
  };
}

// --------------------
// SU shared-password verify
// --------------------


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

// Parsing del body della richiesta
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  // Solo un SUPERUSER autenticato può creare One-Time Token.
const suAuth = verifySuBearer(req);

if (!suAuth.ok) {
  return res.status(401).json({
    ok: false,
    error: suAuth.error,
  });
}

	const suName = suAuth.su_name;

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

  const username = (body.username || "").trim() || randomUsername();

  // ttl_h: 1..24 (durata sessione dopo claim)
  const ttlRaw = typeof body.ttl_h === "number" ? body.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttlRaw), 24));

  // ⛔ SU non può creare link permanenti
  const requestedPermanent = body.permanent === true;

if (requestedPermanent) {
  return res.status(403).json({
    ok: false,
    error: "Il Superuser non può creare link permanenti",
  });
}

const permanent = false;

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
	su_name: suName,
    ttl_h,
    iat: now,
    invite_exp: invite_exp_ms,
    permanent,
    label,
    client_email,
    su_email,
    created_by: "SU",
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
	su_name: suName,
    created_by: "SU",
  });
}
