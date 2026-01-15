import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiOk = {
  ok: true;
  username: string;
  ttl_h: number;
  invite_exp_at: string;
  token: string;
  link: string;
};
type ApiErr = { ok: false; error: string };

type Body = { username?: string; label?: string; ttl_h?: number };

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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");
    res.setHeader("Vary", "Origin");
    return true;
  }
  if (!origin) return true; // server-to-server
  return false;
}

// Admin check (DEMO): cookie "admin_session=ok"
function requireAdmin(req: NextApiRequest): boolean {
  return (req.headers.cookie || "").includes("admin_session=ok");
}

// base64url encode
function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// HMAC sign
function sign(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function randomUsername() {
  // es: NSU-7K4Q2H
  const s = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `NSU-${s}`;
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

  if (!requireAdmin(req)) return res.status(401).json({ ok: false, error: "Admin only" });

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

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

  const now = Date.now();
  const invite_exp_ms = now + 12 * 60 * 60 * 1000; // scadenza invito: 12 ore

  // Payload minimale (firmato)
  const payload = {
    v: 1,
    type: "NSU_ONE_TIME",
    username,
    ttl_h,               // durata sessione dal claim (ore)
    iat: now,            // issued at
    invite_exp: invite_exp_ms, // scadenza invito (ms epoch)
    label: (body.label || "").trim() || undefined,
  };

  const payloadJson = JSON.stringify(payload);
  const sig = sign(payloadJson, secret);
const token = `${b64url(payloadJson)}.${sig}`;

  const baseUrl = (process.env.PUBLIC_BASE_URL || "https://fantasmia.it").replace(/\/$/, "");
  const link = `${baseUrl}/one-time?token=${encodeURIComponent(token)}`;

  return res.status(200).json({
    ok: true,
    username,
    ttl_h,
    invite_exp_at: new Date(invite_exp_ms).toISOString(),
    token,
    link,
  });
}
