// api/room/claim-room.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiOk = {
  ok: true;
  session: {
    role: "NSU_SESSION";
    room: string;
    expires_at: string;
    turn_s: number;
  };
};
type ApiErr = { ok: false; error: string };

type Body = { token?: string; room?: string };

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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");
    res.setHeader("Vary", "Origin");
    return true;
  }
  if (!origin) return true;
  return false;
}

// ---- helpers base64url / HMAC ----
function b64urlToBuf(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64");
}
function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function signRoom(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const secret = process.env.ROOM_SESSION_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing ROOM_SESSION_SECRET" });

  // parse body
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

  const [payloadB64, sig] = parts;

  let payloadJson = "";
  let payload: any = null;
  try {
    payloadJson = b64urlToBuf(payloadB64).toString("utf8");
    payload = JSON.parse(payloadJson);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token payload" });
  }

  const expectedSig = signRoom(payloadJson, secret);
  if (!safeEqual(sig, expectedSig)) return res.status(401).json({ ok: false, error: "Invalid token signature" });

  if (payload?.type !== "PUBLIC_ROOM") {
    return res.status(401).json({ ok: false, error: "Wrong token type" });
  }

  const room = String(payload?.room || "").trim();
  if (!room) return res.status(400).json({ ok: false, error: "Missing room in token" });

  // opzionale: controllo che la room nella URL/body combaci
  if (body.room && String(body.room).trim() !== room) {
    return res.status(401).json({ ok: false, error: "Room mismatch" });
  }

  const exp_ms = typeof payload?.exp === "number" ? payload.exp : 0;
  if (!exp_ms) return res.status(400).json({ ok: false, error: "Missing exp in token" });

  if (Date.now() >= exp_ms) {
    return res.status(410).json({ ok: false, error: "Room expired" });
  }

  const turn_s = Math.max(15, Math.min(Number(payload?.turn_s ?? 60), 600));

  return res.status(200).json({
    ok: true,
    session: {
      role: "NSU_SESSION",
      room,
      expires_at: new Date(exp_ms).toISOString(),
      turn_s,
    },
  });
}
