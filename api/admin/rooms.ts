 import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

type ApiErr = { ok: false; error: string };

type CreateBody = {
  action: "create";
  ttl_h?: number;       // 1..24
  room_name?: string;   // opzionale
  turn_s?: number;      // 15..600 (durata turno "continua tu", default 60)
};

type ClaimBody = {
  action: "claim";
  token?: string;
  room?: string;        // opzionale (check coerenza)
};

type Body = CreateBody | ClaimBody | { action?: string };

type ApiCreateOk = {
  ok: true;
  action: "create";
  room: string;
  ttl_h: number;
  expires_at: string;
  token: string;
  link: string;
  turn_s: number;
  room_name?: string;
};

type ApiClaimOk = {
  ok: true;
  action: "claim";
  session: {
    role: "NSU_SESSION";
    room: string;
    expires_at: string;
    turn_s: number;
    room_name?: string;
  };
};

type ApiOk = ApiCreateOk | ApiClaimOk;

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

// ---- base64url helpers ----
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

// ---- ADMIN Bearer JWT verify (HS256) ----
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

// ---- ROOM token (payload JSON + HMAC) ----
function signRoom(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function randomRoomCode() {
  // 6 caratteri leggibili
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 hex
  return raw.slice(0, 6); // es: "A1B2C3"
}

function parseJsonBody(req: NextApiRequest): Body {
  try {
    return (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    return {};
  }
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

  const body = parseJsonBody(req);
  const action = (body as any)?.action;

  const roomSecret = process.env.ROOM_SESSION_SECRET;
  if (!roomSecret) return res.status(500).json({ ok: false, error: "Missing ROOM_SESSION_SECRET" });

  // -----------------------
  // ACTION: CREATE (ADMIN)
  // -----------------------
  if (action === "create") {
    const admin = verifyAdminBearer(req);
    if (!admin.ok) return res.status(401).json({ ok: false, error: admin.error });

    const b = body as CreateBody;

    const ttlRaw = typeof b.ttl_h === "number" ? b.ttl_h : 4;
    const ttl_h = Math.max(1, Math.min(Math.floor(ttlRaw), 24));

    const turnRaw = typeof b.turn_s === "number" ? b.turn_s : 60;
    const turn_s = Math.max(15, Math.min(Math.floor(turnRaw), 600));

    const now = Date.now();
    const exp_ms = now + ttl_h * 60 * 60 * 1000;

    const room = randomRoomCode();
    const room_name = (b.room_name || "").trim() || undefined;

    const payload = {
      v: 1,
      type: "PUBLIC_ROOM",
      room,
      ttl_h,
      iat: now,     // ms epoch
      exp: exp_ms,  // ms epoch
      turn_s,
      room_name,
    };

    const payloadJson = JSON.stringify(payload);
    const sig = signRoom(payloadJson, roomSecret);
    const token = `${b64url(payloadJson)}.${sig}`;

    const baseUrl = (process.env.PUBLIC_BASE_URL || "https://fantasmia.it").replace(/\/$/, "");
    const link = `${baseUrl}/join/${encodeURIComponent(room)}?token=${encodeURIComponent(token)}`;

    return res.status(200).json({
      ok: true,
      action: "create",
      room,
      ttl_h,
      turn_s,
      room_name,
      expires_at: new Date(exp_ms).toISOString(),
      token,
      link,
    });
  }

  // -----------------------
  // ACTION: CLAIM (PUBLIC)
  // -----------------------
  if (action === "claim") {
    const b = body as ClaimBody;

    const token = (b.token || "").trim();
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

    const expectedSig = signRoom(payloadJson, roomSecret);
    if (!safeEqual(sig, expectedSig)) return res.status(401).json({ ok: false, error: "Invalid token signature" });

    if (payload?.type !== "PUBLIC_ROOM") return res.status(401).json({ ok: false, error: "Wrong token type" });

    const room = String(payload?.room || "").trim();
    if (!room) return res.status(400).json({ ok: false, error: "Missing room in token" });

    // opzionale: check coerenza room passata
    if (b.room && String(b.room).trim() !== room) {
      return res.status(401).json({ ok: false, error: "Room mismatch" });
    }

    const exp_ms = typeof payload?.exp === "number" ? payload.exp : 0;
    if (!exp_ms) return res.status(400).json({ ok: false, error: "Missing exp in token" });
    if (Date.now() >= exp_ms) return res.status(410).json({ ok: false, error: "Room expired" });

    const turn_s = Math.max(15, Math.min(Number(payload?.turn_s ?? 60), 600));
    const room_name = payload?.room_name ? String(payload.room_name) : undefined;

    return res.status(200).json({
      ok: true,
      action: "claim",
      session: {
        role: "NSU_SESSION",
        room,
        expires_at: new Date(exp_ms).toISOString(),
        turn_s,
        room_name,
      },
    });
  }

  // -----------------------
  // Unknown action
  // -----------------------
  return res.status(400).json({ ok: false, error: 'Missing/invalid action (use "create" or "claim")' });
}
