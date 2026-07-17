import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

/*
==============================================================================
 Fantasmia — claim-link-one-time.ts  (patch allineata a create v:2)
==============================================================================
 File da copiare nel repo Vercel `fantasmia-ai` come:
   pages/api/openai/claim-link-one-time.ts

 Endpoint stateless che valida un token OT (One-Time) firmato via HMAC.
 Il token è nel formato: <payloadB64url>.<hmacSig>

 Payload firmato (prodotto da create-link-one-time.ts v:2):
   - type: "NSU_ONE_TIME"
   - username: string
   - ttl_h: number (1..24)
   - invite_exp: number (ms epoch) — scadenza invito (ignorata se permanent)
   - permanent?: boolean
   - client_email?: string
   - su_email?: string
   - created_by?: "ADMIN" | "SU"   ← nuovo (v:2)
   - v?: number

 Risposta al frontend (letta da src/utils/oneTimeTokenManager.ts):
   - user.username, first_login_at, expires_at (null se permanent),
   - ttl_h, permanent, client_email, su_email,
   - created_by, created_by_su (alias booleano/canale usato dal frontend
     per la notifica email di attivazione OT).

 ENV richieste su Vercel (Production):
   - NSU_ONE_TIME_SECRET  (stessa usata dal create — già configurata)
==============================================================================
*/

type CreatedByChannel = "ADMIN" | "SU";

type ApiOk = {
  ok: true;
  user: { username: string; type: "NSU_ONE_TIME" };
  profileName: string;
  first_login_at: string;
  expires_at: string | null;
  ttl_h: number;
  permanent: boolean;
  client_email?: string;
  su_email?: string;
  created_by?: CreatedByChannel;
  created_by_su?: boolean;
};

type ApiErr = { ok: false; error: string };
type Body = { token?: string };

// CORS allowlist
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");
    res.setHeader("Vary", "Origin");
    return true;
  }
  if (!origin) return true;
  return false;
}

// base64url -> utf8
function b64urlToString(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

// HMAC SHA256 su JSON payload -> base64url
function sign(payloadJson: string, secret: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadJson)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCreatedBy(value: unknown): CreatedByChannel | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toUpperCase();
  if (v === "ADMIN" || v === "SU") return v;
  return undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const token = (body.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

  const parts = token.split(".");
  if (parts.length !== 2) {
    return res.status(400).json({ ok: false, error: "Invalid token format" });
  }

  const payloadB64 = parts[0];
  const sig = parts[1];

  let payloadJson = "";
  try {
    payloadJson = b64urlToString(payloadB64);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token payload" });
  }

  const expectedSig = sign(payloadJson, secret);
  if (sig !== expectedSig) {
    return res.status(401).json({ ok: false, error: "Invalid token signature" });
  }

  let payload: any = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token JSON" });
  }

  const username = typeof payload?.username === "string" ? payload.username.trim() : "";
  const ttl_h_raw = typeof payload?.ttl_h === "number" ? payload.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttl_h_raw), 24));
  const inviteExp = typeof payload?.invite_exp === "number" ? payload.invite_exp : 0;
  const permanent = payload?.permanent === true;
  const client_email = normalizeOptionalString(payload?.client_email);
  const su_email = normalizeOptionalString(payload?.su_email);
  const created_by = normalizeCreatedBy(payload?.created_by);

  const now = Date.now();

  if (payload?.type !== "NSU_ONE_TIME" || !username) {
    return res.status(400).json({ ok: false, error: "Token payload not valid" });
  }

  // Scadenza invito solo per token non permanenti.
  if (!permanent) {
    if (!inviteExp || now > inviteExp) {
      return res.status(410).json({ ok: false, error: "Invite expired" });
    }
  }

  const first = new Date(now);
  const expires = new Date(now + ttl_h * 60 * 60 * 1000);

  return res.status(200).json({
    ok: true,
    user: { username, type: "NSU_ONE_TIME" },
    profileName: username,
    first_login_at: first.toISOString(),
    expires_at: permanent ? null : expires.toISOString(),
    ttl_h,
    permanent,
    client_email,
    su_email,
    created_by,
    created_by_su: created_by === "SU" ? true : created_by === "ADMIN" ? false : undefined,
  });
}
