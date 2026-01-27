import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

// --------------------
// Types
// --------------------
type ApiErr = { ok: false; error: string };

type RoomState = {
  turnActive: boolean;
  turnEndsAt: number | null; // ms epoch
  promptSeed: string | null;
  updatedAt: number; // ms epoch
};

type ClaimSession = {
  role: "NSU_SESSION";
  room: string;
  expires_at: string;
  turn_s: number;
  room_name?: string;
};

type ApiClaimOk = {
  ok: true;
  action: "claim";
  session: ClaimSession;
  roomState: RoomState;
};

type ApiCreateOk = {
  ok: true;
  action: "create";
  room: string;
  ttl_h: number;
  turn_s: number;
  expires_at: string;
  token: string;
  link: string;
  room_name?: string;
};

type ApiTurnOk = {
  ok: true;
  action: "turn";
  roomState: RoomState;
};

type ApiPatchOk = {
  ok: true;
  action: "room_patch";
  roomState: RoomState;
};

type ApiOk = ApiClaimOk | ApiCreateOk | ApiTurnOk | ApiPatchOk;

// Bodies
type CreateBody = { action: "create"; ttl_h?: number; room_name?: string; turn_s?: number };
type ClaimBody = { action: "claim"; token?: string; room?: string };
type TurnBody = { action: "turn"; token?: string; room?: string; turnActive?: boolean; turnEndsAt?: number | null };
type PatchBody = { action: "room_patch"; token?: string; room?: string; promptSeed?: string };

type Body = CreateBody | ClaimBody | TurnBody | PatchBody | { action?: string };

// --------------------
// CORS allowlist
// --------------------
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

// --------------------
// base64url + crypto helpers
// --------------------
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

// --------------------
// ADMIN Bearer JWT verify (HS256)
// --------------------
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

// --------------------
// ROOM token (payload JSON + HMAC)
// --------------------
function signRoom(payloadJson: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest());
}

function randomRoomCode() {
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 hex
  return raw.slice(0, 6); // es: A843D9
}

function parseJsonBody(req: NextApiRequest): Body {
  try {
    return (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    return {};
  }
}

type RoomTokenPayload = {
  v: 1;
  type: "PUBLIC_ROOM";
  room: string;
  ttl_h: number;
  iat: number; // ms
  exp: number; // ms
  turn_s: number;
  room_name?: string;
};

function decodeAndVerifyRoomToken(token: string, secret: string): { ok: true; payload: RoomTokenPayload; payloadJson: string } | { ok: false; error: string } {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "Invalid token format" };

  const [payloadB64, sig] = parts;

  let payloadJson = "";
  let payload: any = null;
  try {
    payloadJson = b64urlToBuf(payloadB64).toString("utf8");
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: "Invalid token payload" };
  }

  const expectedSig = signRoom(payloadJson, secret);
  if (!safeEqual(sig, expectedSig)) return { ok: false, error: "Invalid token signature" };

  if (payload?.type !== "PUBLIC_ROOM") return { ok: false, error: "Wrong token type" };

  const room = String(payload?.room || "").trim();
  if (!room) return { ok: false, error: "Missing room in token" };

  const exp = typeof payload?.exp === "number" ? payload.exp : 0;
  if (!exp) return { ok: false, error: "Missing exp in token" };

  return { ok: true, payload: payload as RoomTokenPayload, payloadJson };
}

// --------------------
// In-memory room state (best-effort DEMO)
// --------------------
const globalAny = globalThis as any;
const ROOM_STATE: Map<string, RoomState> =
  globalAny.__FANTASMIA_ROOM_STATE__ || (globalAny.__FANTASMIA_ROOM_STATE__ = new Map<string, RoomState>());

function defaultRoomState(): RoomState {
  return { turnActive: false, turnEndsAt: null, promptSeed: null, updatedAt: Date.now() };
}

function getRoomState(room: string): RoomState {
  return ROOM_STATE.get(room) || defaultRoomState();
}

function setRoomState(room: string, patch: Partial<RoomState>) {
  const prev = getRoomState(room);
  const next: RoomState = {
    turnActive: typeof patch.turnActive === "boolean" ? patch.turnActive : prev.turnActive,
    turnEndsAt: patch.turnEndsAt === undefined ? prev.turnEndsAt : patch.turnEndsAt,
    promptSeed: patch.promptSeed === undefined ? prev.promptSeed : patch.promptSeed,
    updatedAt: Date.now(),
  };
  ROOM_STATE.set(room, next);
  return next;
}

function cleanupIfExpired(room: string, exp_ms: number) {
  if (Date.now() >= exp_ms) {
    ROOM_STATE.delete(room);
    return true;
  }
  return false;
}

// --------------------
// Handler
// --------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

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

  // --------------------
  // CREATE (ADMIN)
  // --------------------
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

    const payload: RoomTokenPayload = {
      v: 1,
      type: "PUBLIC_ROOM",
      room,
      ttl_h,
      iat: now,
      exp: exp_ms,
      turn_s,
      room_name,
    };

    const payloadJson = JSON.stringify(payload);
    const sig = signRoom(payloadJson, roomSecret);
    const token = `${b64url(payloadJson)}.${sig}`;

    // initialize server state (optional)
    setRoomState(room, { turnActive: false, turnEndsAt: null, promptSeed: null });

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

  // For claim/turn/room_patch: need token
  const token = String((body as any)?.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

  const decoded = decodeAndVerifyRoomToken(token, roomSecret);
  if (!decoded.ok) return res.status(401).json({ ok: false, error: decoded.error });

  const payload = decoded.payload;
  const room = payload.room;
  const exp_ms = payload.exp;

  // optional room mismatch check (if provided)
  const bodyRoom = String((body as any)?.room || "").trim();
  if (bodyRoom && bodyRoom !== room) return res.status(401).json({ ok: false, error: "Room mismatch" });

  // expire handling
  if (cleanupIfExpired(room, exp_ms)) {
    return res.status(410).json({ ok: false, error: "Room expired" });
  }

  // --------------------
  // CLAIM (PUBLIC)
  // --------------------
  if (action === "claim") {
    const turn_s = Math.max(15, Math.min(Number(payload.turn_s ?? 60), 600));

    const session: ClaimSession = {
      role: "NSU_SESSION",
      room,
      expires_at: new Date(exp_ms).toISOString(),
      turn_s,
      room_name: payload.room_name,
    };

    // if turn ended, auto reset turnActive
    const st0 = getRoomState(room);
    if (st0.turnActive && st0.turnEndsAt && Date.now() >= st0.turnEndsAt) {
      setRoomState(room, { turnActive: false, turnEndsAt: null });
    }
    const st = getRoomState(room);

    return res.status(200).json({
      ok: true,
      action: "claim",
      session,
      roomState: st,
    });
  }

  // --------------------
  // TURN (ADMIN)
  // --------------------
  if (action === "turn") {
    const admin = verifyAdminBearer(req);
    if (!admin.ok) return res.status(401).json({ ok: false, error: admin.error });

    const b = body as TurnBody;

    const turn_s = Math.max(15, Math.min(Number(payload.turn_s ?? 60), 600));
    const now = Date.now();

    const turnActive = !!b.turnActive;

    if (!turnActive) {
      const st = setRoomState(room, { turnActive: false, turnEndsAt: null });
      return res.status(200).json({ ok: true, action: "turn", roomState: st });
    }

    // active: compute endsAt
    let endsAt: number;
    if (typeof b.turnEndsAt === "number" && isFinite(b.turnEndsAt)) {
      endsAt = Math.floor(b.turnEndsAt);
    } else {
      endsAt = now + turn_s * 1000;
    }

    // clamp endsAt: >= now+5s and <= room exp
    const minEnd = now + 5_000;
    const maxEnd = exp_ms;
    endsAt = Math.max(minEnd, Math.min(endsAt, maxEnd));

    const st = setRoomState(room, { turnActive: true, turnEndsAt: endsAt });
    return res.status(200).json({ ok: true, action: "turn", roomState: st });
  }

  // --------------------
  // ROOM PATCH (ADMIN) — promptSeed
  // --------------------
  if (action === "room_patch") {
    const admin = verifyAdminBearer(req);
    if (!admin.ok) return res.status(401).json({ ok: false, error: admin.error });

    const b = body as PatchBody;
    let promptSeed = (b.promptSeed || "").trim();
    if (!promptSeed) promptSeed = "";

    // limit size for demo safety
    if (promptSeed.length > 600) promptSeed = promptSeed.slice(0, 600);

    const st = setRoomState(room, { promptSeed: promptSeed || null });
    return res.status(200).json({ ok: true, action: "room_patch", roomState: st });
  }

  return res.status(400).json({ ok: false, error: 'Missing/invalid action (use "create", "claim", "turn", "room_patch")' });
}
