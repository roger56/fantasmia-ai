import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
export const config = { runtime: "nodejs" };

/*
ROOMS V2 — Persistent (Upstash Redis)
- CORS prod + Lovable
- JWT admin (Bearer)
- Multi-room persistent in Redis
- Turni NEXT / PAUSE / RESUME / STOP
- Dashboard: LIST_ROOMS (summary)
- Versioning: version, updated_at
*/

type RoomMode = "CONTINUA_TU" | "CAMPBELL" | "PROPP";

type RoomState = {
  room_name: string;
  activity_title: string;
  room_mode: RoomMode;
  prompt_seed: string;
  story_so_far: string;

  writers: string[];
  current_writer_index: number;

  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;

  // Robustness
  version: number;       // incrementa a ogni modifica
  updated_at: number;    // now()

  // Safety TTL (paracadute)
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

function isAllowedOrigin(origin?: string) {
  if (!origin) return false;
  return allowedOrigins.some((o) =>
    typeof o === "string" ? o === origin : o.test(origin)
  );
}

function setCors(req: any, res: any) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function now() {
  return Date.now();
}

function randomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function clampNumber(x: any, fallback: number, min?: number, max?: number) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === "number" && n < min) return min;
  if (typeof max === "number" && n > max) return max;
  return n;
}

function normalizeKey(x: any) {
  return (x && String(x).trim()) || "";
}

// ---------- ADMIN JWT VERIFY ----------
function verifyAdmin(req: NextApiRequest) {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return false;

  const check = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");

  if (check !== s) return false;

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return false;
  }

  if (payload.role !== "ADMIN") return false;
  if (typeof payload.exp !== "number") return false;
  if (payload.exp * 1000 < now()) return false;

  return true;
}

// ---------- Redis ----------
const redis = Redis.fromEnv();

// Keying
const KEY_ROOM = (room: string) => `rooms:room:${room}`;
const KEY_ROOMS_SET = `rooms:all`; // set con nomi stanza

async function getRoom(room: string): Promise<RoomState | null> {
  const st = await redis.get<RoomState>(KEY_ROOM(room));
  if (!st) return null;
  if (now() > st.expires_at) {
    await redis.del(KEY_ROOM(room));
    await redis.srem(KEY_ROOMS_SET, room);
    return null;
  }
  return st;
}

async function saveRoom(room: string, st: RoomState) {
  // TTL paracadute: fino a expires_at
  const ttlSeconds = Math.max(60, Math.ceil((st.expires_at - now()) / 1000));
  await redis.set(KEY_ROOM(room), st, { ex: ttlSeconds });
  await redis.sadd(KEY_ROOMS_SET, room);
}

function toSummary(room: string, st: RoomState): RoomSummary {
  const current_writer =
    st.writers && st.writers.length > 0 ? st.writers[st.current_writer_index] : null;

  return {
    room,
    room_name: st.room_name,
    activity_title: st.activity_title,
    room_mode: st.room_mode,

    writers_count: st.writers?.length || 0,
    current_writer,

    turn_ends_at: st.turn_ends_at,
    turn_paused: st.turn_paused,
    turn_remaining_ms: st.turn_remaining_ms,

    version: st.version,
    updated_at: st.updated_at,
    expires_at: st.expires_at,
  };
}

function bump(st: RoomState) {
  st.version = (st.version || 0) + 1;
  st.updated_at = now();
}

// ---------- API ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  // Parse body safe
  let body: any = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid json body" });
    }
  }

  const { action } = body || {};
  if (!action) return res.status(400).json({ error: "missing action" });

  // STATUS
  if (action === "status") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });
    return res.json({ success: true, ok: true, now: now() });
  }

  // LIST ROOMS (summary)
  if (action === "list_rooms") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const t = now();
    const roomIds = (await redis.smembers<string[]>(KEY_ROOMS_SET)) || [];
    const summaries: RoomSummary[] = [];

    for (const room of roomIds) {
      const st = await getRoom(room);
      if (!st) continue;
      summaries.push(toSummary(room, st));
    }

    // ordina per scadenza
    summaries.sort((a, b) => (a.expires_at || 0) - (b.expires_at || 0));

    return res.json({ success: true, rooms: summaries, now: t });
  }

  // CREATE
  if (action === "create") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const room_name = normalizeKey(body.room_name) || randomId();
    const activity_title = normalizeKey(body.activity_title) || room_name;
    const room_mode: RoomMode = (body.room_mode as RoomMode) || "CONTINUA_TU";

    // Paracadute: in ore (tu poi lo alzerai a 12–24h quando passi a “sessione SU” completa)
    const ttl_h = clampNumber(body.ttl_h, 12, 1, 24);
    const expires_at = now() + ttl_h * 3600 * 1000;

    const st: RoomState = {
      room_name,
      activity_title,
      room_mode,
      prompt_seed: "",
      story_so_far: "",

      writers: [],
      current_writer_index: 0,

      turn_ends_at: null,
      turn_paused: false,
      turn_remaining_ms: null,

      version: 1,
      updated_at: now(),
      expires_at,
    };

    await saveRoom(room_name, st);

    return res.json({ success: true, room: room_name, expires_at });
  }

  // JOIN (NSU)
  if (action === "join") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    const writer_id = `Writer ${st.writers.length + 1}`;
    st.writers.push(writer_id);

    bump(st);
    await saveRoom(key, st);

    return res.json({
      success: true,
      writer_id,
      writer_index: st.writers.length - 1,
      room_state: st,
    });
  }

  // NEXT TURN (SU)
  if (action === "next_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (!st.writers || st.writers.length === 0) {
      return res.status(409).json({ error: "no writers yet" });
    }

    st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;

    st.turn_paused = false;
    st.turn_remaining_ms = null;

    const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
    st.turn_ends_at = now() + turnSeconds * 1000;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // PAUSE TURN (SU)
  if (action === "pause_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

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

  // RESUME TURN (SU)
  if (action === "resume_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

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

  // STOP TURN (SU)
  if (action === "stop_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    st.turn_ends_at = null;
    st.turn_paused = false;
    st.turn_remaining_ms = null;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // SUBMIT TEXT (NSU)
  if (action === "submit_text") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (st.turn_paused) return res.status(409).json({ error: "turn paused" });

    const writer_id = normalizeKey(body.writer_id);
    const current = st.writers[st.current_writer_index];
    if (writer_id !== current) {
      return res.status(403).json({ error: "not your turn" });
    }

    st.story_so_far += `\n${String(body.text || "")}`;
    st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;

    // auto-start next turn 180s
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + 180 * 1000;

    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, room_state: st });
  }

  // GET STATE
  if (action === "get_state") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    return res.json({ success: true, room_state: st });
  }

  return res.status(400).json({ error: "unknown action" });
}
