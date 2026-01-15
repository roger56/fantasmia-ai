import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiOk = {
  ok: true;
  user: { username: string; type: "NSU_ONE_TIME" };
  first_login_at: string;
  expires_at: string;
  ttl_h: number;
};
type ApiErr = { ok: false; error: string };

type Body = { token?: string };

// CORS allowlist (puoi restringere a fantasmia.it se vuoi)
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

// base64url decode to utf8 string
function b64urlToString(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

// HMAC sign payload JSON -> base64url digest
function sign(payloadJson: string, secret: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadJson)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

  // Body parsing robusto
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const token = (body.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

  const parts = token.split(".");
  if (parts.length !== 2) return res.status(400).json({ ok: false, error: "Invalid token format" });

  const payloadB64 = parts[0];
  const sig = parts[1];

  let payloadJson = "";
  try {
    payloadJson = b64urlToString(payloadB64);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token payload" });
  }

  const expectedSig = sign(payloadJson, secret);
  if (sig !== expectedSig) return res.status(401).json({ ok: false, error: "Invalid token signature" });

  let payload: any = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token JSON" });
  }

  // Validate payload
  const username = typeof payload?.username === "string" ? payload.username.trim() : "";
  const ttl_h_raw = typeof payload?.ttl_h === "number" ? payload.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttl_h_raw), 24));

  const inviteExp = typeof payload?.invite_exp === "number" ? payload.invite_exp : 0;
  const now = Date.now();

  if (payload?.type !== "NSU_ONE_TIME" || !username) {
    return res.status(400).json({ ok: false, error: "Token payload not valid" });
  }

  // Invite expiration: 12h from create
  if (!inviteExp || now > inviteExp) {
    return res.status(410).json({ ok: false, error: "Invite expired" });
  }

  // Claim: in versione stateless, first login = adesso
  const first = new Date(now);
  const expires = new Date(now + ttl_h * 60 * 60 * 1000);

  return res.status(200).json({
    ok: true,
    user: { username, type: "NSU_ONE_TIME" },
    first_login_at: first.toISOString(),
    expires_at: expires.toISOString(),
    ttl_h,
  });
}
