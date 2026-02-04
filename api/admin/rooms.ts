import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

// ===== CORS (UNA SOLA VOLTA, IDENTICO A login.ts) =====
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
  return allowedOrigins.some((o) =>
    typeof o === "string" ? o === origin : o.test(origin)
  );
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
  }
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

  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;

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

// ===== ADMIN VERIFY =====
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

  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  return payload.role === "ADMIN" && payload.exp * 1000 > now();
}

// ===== REDIS HELPERS =====
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
  const ttlSeconds = Math.max(60, Math.ceil((st.expires_at - now()) / 1000));
  await redis.set(KEY_ROOM(room), st, { ex: ttlSeconds });
  await redis.sadd(KEY_ROOMS_SET, room);
}

function toSummary(room: string, st: RoomState): RoomSummary {
  return {
    room,
    room_name: st.room_name,
    activity_title: st.activity_title,
    room_mode: st.room_mode,
    writers_count: st.writers.length,
    current_writer: st.writers[st.current_writer_index] || null,
    turn_ends_at: st.turn_ends_at,
    turn_paused: st.turn_paused,
    turn_remaining_ms: st.turn_remaining_ms,
    version: st.version,
    updated_at: st.updated_at,
    expires_at: st.expires_at,
  };
}

// ===== HANDLER =====
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const isAdmin = verifyAdmin(req);

  let body: any = req.body;
  if (typeof body === "string") body = JSON.parse(body);
  const { action } = body || {};
  if (!action) return res.status(400).json({ error: "missing action" });

  // ===== STATUS =====
  if (action === "status") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    return res.json({ success: true, now: now() });
  }

  // ===== LIST ROOMS =====
  if (action === "list_rooms") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const ids = await redis.smembers<string[]>(KEY_ROOMS_SET);
    const rooms: RoomSummary[] = [];

    for (const id of ids || []) {
      const st = await getRoom(id);
      if (st) rooms.push(toSummary(id, st));
    }

    return res.json({ success: true, rooms, now: now() });
  }

  // ===== CREATE =====
  if (action === "create") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });

    const room = normalizeKey(body.room_name) || crypto.randomBytes(3).toString("hex");
    const ttl_h = clampNumber(body.ttl_h, 12, 1, 24);

    const st: RoomState = {
      room_name: room,
      activity_title: body.activity_title || room,
      room_mode: body.room_mode || "CONTINUA_TU",
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
    return res.json({ success: true, room });
  }

  // ===== JOIN =====
  if (action === "join") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    const writer = `Writer ${st.writers.length + 1}`;
    st.writers.push(writer);
    bump(st);
    await saveRoom(key, st);

    return res.json({ success: true, writer_id: writer, room_state: st });
  }

  // ===== DELETE ROOM =====
  if (action === "delete_room") {
    if (!isAdmin) return res.status(401).json({ error: "admin required" });

    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.json({ success: true });

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
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });
    return res.json({ success: true, room_state: st });
  }

  return res.status(400).json({ error: "unknown action" });
}
