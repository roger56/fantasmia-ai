// api/admin/rooms.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

// ===== CORS (UNA SOLA VOLTA, come login.ts) =====
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

  // server-to-server (no Origin) => ok
  if (!origin) {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
    return true;
  }

  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");
    return true;
  }

  return false;
}

// ===== TYPES =====
type RoomMode = "CONTINUA_TU" | "CAMPBELL" | "PROPP";

type RoomState = {
  room_name: string;
  activity_title: string;
  room_mode: RoomMode;
  prompt_seed: string;
  story_so_far: string;

  writers: string[];
  current_writer_index: number;

  // Turno
  turn_ends_at: number | null;        // epoch ms, null = nessun turno attivo
  turn_paused: boolean;               // true se congelato
  turn_remaining_ms: number | null;   // valido solo quando in pausa

  // Robustness
  version: number;
  updated_at: number;
  expires_at: number;
};

type RoomSummary = {
  room: string;
  room_name: string;
  activity_title: string;
  room_mode: RoomMode;

  writers_count: number;
  current_writer: string | null;

  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;

  version: number;
  updated_at: number;
  expires_at: number;
};

// ===== UTILS =====
const redis = Redis.fromEnv();

const KEY_ROOM = (room: string) => `rooms:room:${room}`;
const KEY_ROOMS_SET = `rooms:all`;

const now = () => Date.now();
const normalizeKey = (x: any) => (x ? String(x).trim() : "");
const clampNumber = (x: any, fallback: number, min?: number, max?: number) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
};

function bump(st: RoomState) {
  st.version = (st.version || 0) + 1;
  st.updated_at = now();
}

function toSummary(room: string, st: RoomState): RoomSummary {
  const current_writer =
    st.writers.length > 0 ? st.writers[st.current_writer_index] ?? null : null;

  return {
    room,
    room_name: st.room_name,
    activity_title: st.activity_title,
    room_mode: st.room_mode,

    writers_count: st.writers.length,
    current_writer,

    turn_ends_at: st.turn_ends_at,
    turn_paused: st.turn_paused,
    turn_remaining_ms: st.turn_remaining_ms,

    version: st.version,
    updated_at: st.updated_at,
    expires_at: st.expires_at,
  };
}

// ===== ADMIN VERIFY (JWT HS256 minimal) =====
function verifyAdmin(req: NextApiRequest) {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return false;

  const check = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (check !== s) return false;

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  if (payload.role !== "ADMIN") return false;
  if (typeof payload.exp !== "number") return false;
  if (payload.exp * 1000 <= now()) return false;

  return true;
}

// ===== REDIS HELPERS (distinguo scaduta vs non trovata) =====
async function getRoomWithExpiry(room: string): Promise<{ st: RoomState | null; expired: boolean }> {
  const st = await redis.get<RoomState>(KEY_ROOM(room));
  if (!st) return { st: null, expired: false };

  if (now() > st.expires_at) {
    // era presente ma scaduta => pulizia + segnala expired
    await redis.del(KEY_ROOM(room));
    await redis.srem(KEY_ROOMS_SET, room);
    return { st: null, expired: true };
  }

  return { st, expired: false };
}

async function saveRoom(room: string, st: RoomState) {
  const ttlSeconds = Math.max(60, Math.ceil((st.expires_at - now()) / 1000));
  await redis.set(KEY_ROOM(room), st, { ex: ttlSeconds });
  await redis.sadd(KEY_ROOMS_SET, room);
}

// ===== HANDLER =====
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const isAdmin = verifyAdmin(req);

  // Body parse robusto
  let body: any = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid json body" });
    }
  }

  const action = body?.action;
  if (!action) return res.status(400).json({ error: "missing action" });

  // ===== STATUS =====
  if (action === "status") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    return res.json({ success: true, ok: true, now: now() });
  }

  // ===== LIST ROOMS (SUMMARY) =====
  if (action === "list_rooms") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const ids = (await redis.smembers<string[]>(KEY_ROOMS_SET)) || [];
    const rooms: RoomSummary[] = [];

    for (const id of ids) {
      const { st } = await getRoomWithExpiry(id);
      if (st) rooms.push(toSummary(id, st));
    }

    rooms.sort((a, b) => (a.expires_at || 0) - (b.expires_at || 0));
    return res.json({ success: true, rooms, now: now() });
  }

  // ===== CREATE =====
  if (action === "create") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const room = normalizeKey(body.room_name) || crypto.randomBytes(3).toString("hex");
    const ttl_h = clampNumber(body.ttl_h, 12, 1, 48);

    const st: RoomState = {
      room_name: room,
      activity_title: normalizeKey(body.activity_title) || room,
      room_mode: (body.room_mode as RoomMode) || "CONTINUA_TU",
      prompt_seed: "",
      story_so_far: "",

      writers: [],
      current_writer_index: 0,

      turn_ends_at: null,
      turn_paused: false,
      turn_remaining_ms: null,

      version: 1,
      updated_at: now(),
      expires_at: now() + ttl_h * 3600 * 1000,
    };

    await saveRoom(room, st);
    return res.json({ success: true, room, expires_at: st.expires_at });
  }

  // ===== JOIN (NSU) =====
  if (action === "join") {
    const key = normalizeKey(body.room);
    if (!key) return res.status(400).json({ error: "missing room" });

    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    const writer = `Writer ${st.writers.length + 1}`;
    st.writers.push(writer);

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, writer_id: writer, writer_index: st.writers.length - 1, room_state: st });
  }

  // ===== NEXT TURN (SU) =====
  // Avanza il writer corrente e avvia un nuovo turno temporizzato
  if (action === "next_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    if (!key) return res.status(400).json({ error: "missing room" });

    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    if (!st.writers || st.writers.length === 0) {
      return res.status(409).json({ error: "no writers yet" });
    }

    const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);

    // passa al prossimo writer
    st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;

    // avvia turno
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + turnSeconds * 1000;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // ===== PAUSE TURN (SU) =====
  if (action === "pause_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    if (st.turn_paused) return res.status(409).json({ error: "already paused" });
    if (st.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });

    const remaining = Math.max(0, st.turn_ends_at - now());
    st.turn_paused = true;
    st.turn_remaining_ms = remaining;
    st.turn_ends_at = null;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // ===== RESUME TURN (SU) =====
  if (action === "resume_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    if (!st.turn_paused || st.turn_remaining_ms == null) {
      return res.status(409).json({ error: "not paused" });
    }

    const remaining = Math.max(0, st.turn_remaining_ms);
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + remaining;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // ===== STOP TURN (SU) =====
  // Ferma il turno (ma NON elimina la stanza)
  if (action === "stop_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    st.turn_ends_at = null;
    st.turn_paused = false;
    st.turn_remaining_ms = null;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // ===== SUBMIT TEXT (NSU) =====
  // REGOLA: l’invio chiude il turno, ma NON avvia automaticamente il successivo.
  if (action === "submit_text") {
    const key = normalizeKey(body.room);
    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });

    if (st.turn_paused) return res.status(409).json({ error: "turn paused" });
    if (st.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
    if (st.turn_ends_at <= now()) return res.status(409).json({ error: "turn expired" });

    const writer_id = normalizeKey(body.writer_id);
    const current = st.writers[st.current_writer_index];
    if (!writer_id || writer_id !== current) {
      return res.status(403).json({ error: "not your turn" });
    }

    const text = String(body.text || "");
    st.story_so_far += (st.story_so_far ? "\n" : "") + text;

    // chiude il turno (nessun auto-start)
    st.turn_ends_at = null;
    st.turn_paused = false;
    st.turn_remaining_ms = null;

    // prepara il prossimo writer (ma turno parte solo con SU next_turn)
    if (st.writers.length > 0) {
      st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;
    }

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // ===== DELETE ROOM (admin) =====
  if (action === "delete_room") {
    if (!isAdmin) return res.status(401).json({ error: "admin required" });

    const key = normalizeKey(body.room);
    if (!key) return res.status(400).json({ error: "missing room" });

    const { st } = await getRoomWithExpiry(key);
    if (!st) return res.json({ success: true }); // idempotente

    // marca scaduta e salva (così list_rooms la perderà subito, e join/get_state => 410)
    st.expires_at = now() - 1;
    st.turn_paused = true;
    st.turn_ends_at = null;
    st.turn_remaining_ms = null;
    bump(st);

    await saveRoom(key, st);
    return res.json({ success: true });
  }

  // ===== GET STATE =====
  if (action === "get_state") {
    const key = normalizeKey(body.room);
    const { st, expired } = await getRoomWithExpiry(key);
    if (!st) return res.status(expired ? 410 : 404).json({ error: expired ? "room expired" : "room not found" });
    return res.json({ success: true, room_state: st });
  }

  return res.status(400).json({ error: "unknown action" });
}
