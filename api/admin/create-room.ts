// api/room/create-room.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiOk = {
  ok: true;
  room: string;
  ttl_h: number;
  expires_at: string;
  token: string;
  link: string;
};
type ApiErr = { ok: false; error: string };

type Body = {
  ttl_h?: number;        // 1..24 ore
  room_name?: string;    // opzionale (solo descrittivo)
  turn_s?: number;       // opzionale: durata turno per "continua tu" (es. 60)
};

// ---- CORS allowlist ----
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
  const origin = (req.headers.origin || "").trim();
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

// ---- helpers base64url / HMAC ----
function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlToBuf(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64");
}
function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---- verify ADMIN Bearer JWT (HS256) ----
function signHS256(data: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}
function verifyAdminBearer(req: NextApiRequest): { ok: true } | { ok: false; error: string } {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return { ok: false, error: "Missing ADMIN_JWT_SECRET" };

  const auth = (req.headers.authorization || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return { ok: false, error: "Missing Bearer token" };

  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Invalid token format" };

  const [hB64, pB64, sig] = parts;
  const toSign = `${hB64}.${pB64}`;
  const expectedSig = signHS256(toSign, secret);
  if (!safeEqual(sig, expectedSig)) return { ok: false, error: "Invalid token signature" };

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

// ---- ROOM token signing (payload JSON + HMAC) ----
function signRoom(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function randomRoomCode() {
  // breve, leggibile: 6 chars base32-ish
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 hex
  return raw.slice(0, 6); // es. "A1B2C3"
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const admin = verifyAdminBearer(req);
  if (!admin.ok) return res.status(401).json({ ok: false, error: admin.error });

  const roomSecret = process.env.ROOM_SESSION_SECRET;
  if (!roomSecret) return res.status(500).json({ ok: false, error: "Missing ROOM_SESSION_SECRET" });

  // parse body
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const ttlRaw = typeof body.ttl_h === "number" ? body.ttl_h : 4;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttlRaw), 24));

  const turnRaw = typeof body.turn_s === "number" ? body.turn_s : 60;
  const turn_s = Math.max(15, Math.min(Math.floor(turnRaw), 600)); // 15..600 sec

  const now = Date.now();
  const exp_ms = now + ttl_h * 60 * 60 * 1000;

  const room = randomRoomCode();

  const payload = {
    v: 1,
    type: "PUBLIC_ROOM",
    room,                 // codice stanza
    ttl_h,                // durata stanza
    iat: now,             // ms
    exp: exp_ms,          // ms
    room_name: (body.room_name || "").trim() || undefined,
    turn_s,               // default turn duration for "continua tu"
  };

  const payloadJson = JSON.stringify(payload);
  const sig = signRoom(payloadJson, roomSecret);
  const token = `${b64url(payloadJson)}.${sig}`;

  const baseUrl = (process.env.PUBLIC_BASE_URL || "https://fantasmia.it").replace(/\/$/, "");
  const link = `${baseUrl}/join/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}`;

  return res.status(200).json({
    ok: true,
    room,
    ttl_h,
    expires_at: new Date(exp_ms).toISOString(),
    token,
    link,
  });
}
