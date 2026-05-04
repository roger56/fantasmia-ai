// API rooms.ts — versione con supporto Gruppi V2 (round-robin server-side)
// + PARALLELISMO  writers (N writers ↔ N stanze ad ogni turno, niente attese)
// + total_turns = X·N (X giri completi) e auto-end del gruppo
// + submitted_this_turn per evitare doppio submit nello stesso turno
// + status di gruppo ("waiting" | "active" | "paused" | "ended")
//
// Retrocompatibile: tutte le azioni "single room" e "group legacy" restano invariate.
//
// Modello round-robin (per writer w in 0..N-1, turno t in 1..total_turns):
//   room_index(w, t) = (w + t - 1) mod N
// Conseguenze:
//   - ad ogni turno tutti gli N writers sono attivi contemporaneamente
//   - ogni stanza ha esattamente un writer per turno
//   - dopo N turni il ciclo si chiude (giro completo); con total_turns = X·N
//     ogni writer scrive X volte in ogni stanza
//
// Azioni gruppo V2:
//   create_group, list_groups, group_state, join_group, get_my_assignment,
//   group_advance_turn (anche "force next turn"), group_pause, group_resume,
//   group_submit_text, delete_group

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

// ===== CORS =====
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
  // V2 (opzionale): se la stanza appartiene a un gruppo
  group_id?: string | null;
  room_index?: number | null; // 0..N-1 dentro il gruppo
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
  group_id?: string | null;
};

// V2: gruppo (con parallelismo)
type GroupStatus = "waiting" | "active" | "paused" | "ended";

type GroupState = {
  group_id: string;
  activity_title: string;
  room_mode: RoomMode;
  prompt_seed: string;
  expected_writers: number;        // N (cap rigido)
  rooms: string[];                 // N nomi stanze pre-create
  writers: string[];               // ordine di join, max N
  turn_number: number;             // 0 = nessun turno avviato; 1..total_turns
  total_turns: number;             // X·N (multiplo intero positivo di N), 0 = illimitato (legacy)
  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;
  submitted_this_turn: string[];   // writer_id che hanno già inviato nel turno corrente
  status: GroupStatus;
  version: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

// ===== UTILS =====
const redis = Redis.fromEnv();

const KEY_ROOM = (room: string) => `rooms:room:${room}`;
const KEY_ROOMS_SET = `rooms:all`;

const KEY_GROUP = (gid: string) => `groups:group:${gid}`;
const KEY_GROUPS_SET = `groups:all`;

const now = () => Date.now();
const normalizeKey = (x: any) => (x ? String(x).trim() : "");
const clampNumber = (x: any, fallback: number, min?: number, max?: number) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
};

function bump(st: RoomState | GroupState) {
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
  const check = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (check !== s) return false;
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  return payload.role === "ADMIN" && payload.exp * 1000 > now();
}

// ===== REDIS HELPERS — ROOMS =====
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
    group_id: st.group_id || null,
  };
}

// ===== REDIS HELPERS — GROUPS =====
async function getGroup(gid: string): Promise<GroupState | null> {
  const g = await redis.get<GroupState>(KEY_GROUP(gid));
  if (!g) return null;
  if (now() > g.expires_at) {
    await redis.del(KEY_GROUP(gid));
    await redis.srem(KEY_GROUPS_SET, gid);
    return null;
  }
  // Backfill campi nuovi su gruppi creati prima del deploy V2
  if (typeof (g as any).total_turns !== "number") (g as any).total_turns = 0;
  if (!Array.isArray((g as any).submitted_this_turn)) (g as any).submitted_this_turn = [];
  if (!(g as any).status) {
    (g as any).status = g.turn_number > 0
      ? (g.turn_paused ? "paused" : "active")
      : "waiting";
  }
  return g;
}

async function saveGroup(g: GroupState) {
  const ttlSeconds = Math.max(60, Math.ceil((g.expires_at - now()) / 1000));
  await redis.set(KEY_GROUP(g.group_id), g, { ex: ttlSeconds });
  await redis.sadd(KEY_GROUPS_SET, g.group_id);
}

// Calcola: per ogni writer i (0..N-1) e turno corrente, quale stanza ha assegnata.
// Round-robin: roomIndex = (i + (turn_number - 1)) mod N
// turn_number = 0 → nessun turno avviato → nessuna assegnazione
function computeAssignments(g: GroupState): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (g.turn_number <= 0) {
    for (const w of g.writers) out[w] = null;
    return out;
  }
  const N = g.rooms.length;
  g.writers.forEach((w, i) => {
    const roomIdx = (i + (g.turn_number - 1)) % N;
    out[w] = g.rooms[roomIdx];
  });
  return out;
}

type GroupResult = {
  room: string;
  ok: boolean;
  status?: number;
  error?: string;
  room_state?: RoomState;
};

function parseRoomsArray(x: any): string[] {
  if (Array.isArray(x)) return x.map((r) => normalizeKey(r)).filter(Boolean);
  return [];
}

// ===== HANDLER =====
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const isAdmin = verifyAdmin(req);

  let body: any = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "invalid json body" }); }
  }

  const { action } = body || {};
  if (!action) return res.status(400).json({ error: "missing action" });

  // ============================================================
  // ===== AZIONI ESISTENTI (INVARIATE) =========================
  // ============================================================

  if (action === "status") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    return res.json({ success: true, now: now() });
  }

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
      group_id: null,
      room_index: null,
    };
    await saveRoom(room, st);
    return res.json({ success: true, room });
  }

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

  if (action === "next_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });
    if (!st.writers || st.writers.length === 0) return res.status(409).json({ error: "no writers yet" });
    const turn_s = clampNumber(body.turn_s, 180, 15, 600);
    st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + turn_s * 1000;
    bump(st);
    await saveRoom(key, st);
    return res.json({ success: true, room_state: st });
  }

  if (action === "pause_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
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

  if (action === "resume_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const key = normalizeKey(body.room);
    if (!key) return res.status(400).json({ error: "missing room" });
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });
    if (!st.turn_paused || st.turn_remaining_ms == null) return res.status(409).json({ error: "not paused" });
    const remaining = Math.max(0, Number(st.turn_remaining_ms) || 0);
    if (remaining <= 0) {
      st.turn_paused = false;
      st.turn_remaining_ms = null;
      st.turn_ends_at = null;
      bump(st);
      await saveRoom(key, st);
      return res.status(409).json({ error: "no remaining time" });
    }
    st.turn_paused = false;
    st.turn_ends_at = now() + remaining;
    st.turn_remaining_ms = null;
    bump(st);
    await saveRoom(key, st);
    return res.json({ success: true, room_state: st });
  }

  if (action === "submit_text") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });
    if (now() > st.expires_at) return res.status(410).json({ error: "room expired" });
    const writer_id = normalizeKey(body.writer_id);
    if (!writer_id) return res.status(400).json({ error: "missing writer_id" });
    const writerIndex = st.writers.indexOf(writer_id);
    if (writerIndex < 0) return res.status(403).json({ error: "writer not in room" });
    const current = st.writers[st.current_writer_index];
    if (writer_id !== current) return res.status(403).json({ error: "not your turn" });
    if (st.turn_paused) return res.status(409).json({ error: "turn paused" });
    if (st.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
    if (st.turn_ends_at <= now()) return res.status(409).json({ error: "turn expired" });
    const txt = String(body.text || "").trim();
    if (!txt) return res.status(400).json({ error: "empty text" });
    st.story_so_far = (st.story_so_far ? st.story_so_far + "\n" : "") + txt;
    st.turn_ends_at = null;
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    bump(st);
    await saveRoom(key, st);
    return res.json({ success: true, room_state: st });
  }

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

  if (action === "get_state") {
    const key = normalizeKey(body.room);
    const st = await getRoom(key);
    if (!st) return res.status(404).json({ error: "room not found" });
    return res.json({ success: true, room_state: st });
  }

  // ===== GROUP LEGACY (batch su rooms[]) — invariate =====

  if (action === "group_next_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const rooms = parseRoomsArray(body.rooms);
    if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });
    const turn_s = clampNumber(body.turn_s, 180, 15, 600);
    const results: GroupResult[] = [];
    for (const room of rooms) {
      try {
        const st = await getRoom(room);
        if (!st) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
        if (!st.writers || st.writers.length === 0) {
          results.push({ room, ok: false, status: 409, error: "no writers yet" }); continue;
        }
        st.current_writer_index = (st.current_writer_index + 1) % st.writers.length;
        st.turn_paused = false;
        st.turn_remaining_ms = null;
        st.turn_ends_at = now() + turn_s * 1000;
        bump(st);
        await saveRoom(room, st);
        results.push({ room, ok: true, status: 200, room_state: st });
      } catch (e: any) {
        results.push({ room, ok: false, status: 500, error: e?.message || "error" });
      }
    }
    return res.json({ success: results.every((r) => r.ok), results, now: now() });
  }

  if (action === "group_pause_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const rooms = parseRoomsArray(body.rooms);
    if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });
    const results: GroupResult[] = [];
    for (const room of rooms) {
      try {
        const st = await getRoom(room);
        if (!st) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
        if (st.turn_paused) { results.push({ room, ok: false, status: 409, error: "already paused" }); continue; }
        if (st.turn_ends_at == null) { results.push({ room, ok: false, status: 409, error: "no active turn" }); continue; }
        const remaining = Math.max(0, st.turn_ends_at - now());
        st.turn_paused = true;
        st.turn_remaining_ms = remaining;
        st.turn_ends_at = null;
        bump(st);
        await saveRoom(room, st);
        results.push({ room, ok: true, status: 200, room_state: st });
      } catch (e: any) {
        results.push({ room, ok: false, status: 500, error: e?.message || "error" });
      }
    }
    return res.json({ success: results.every((r) => r.ok), results, now: now() });
  }

  if (action === "group_resume_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const rooms = parseRoomsArray(body.rooms);
    if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });
    const results: GroupResult[] = [];
    for (const room of rooms) {
      try {
        const st = await getRoom(room);
        if (!st) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
        if (!st.turn_paused || st.turn_remaining_ms == null) {
          results.push({ room, ok: false, status: 409, error: "not paused" }); continue;
        }
        const remaining = Math.max(0, Number(st.turn_remaining_ms) || 0);
        if (remaining <= 0) {
          results.push({ room, ok: false, status: 409, error: "no remaining time" }); continue;
        }
        st.turn_paused = false;
        st.turn_ends_at = now() + remaining;
        st.turn_remaining_ms = null;
        bump(st);
        await saveRoom(room, st);
        results.push({ room, ok: true, status: 200, room_state: st });
      } catch (e: any) {
        results.push({ room, ok: false, status: 500, error: e?.message || "error" });
      }
    }
    return res.json({ success: results.every((r) => r.ok), results, now: now() });
  }

  if (action === "group_delete_room") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const rooms = parseRoomsArray(body.rooms);
    if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });
    const results: GroupResult[] = [];
    for (const room of rooms) {
      try {
        const st = await getRoom(room);
        if (!st) { results.push({ room, ok: true, status: 200 }); continue; }
        st.expires_at = now() - 1;
        st.turn_paused = true;
        st.turn_ends_at = null;
        st.turn_remaining_ms = null;
        bump(st);
        await saveRoom(room, st);
        results.push({ room, ok: true, status: 200 });
      } catch (e: any) {
        results.push({ room, ok: false, status: 500, error: e?.message || "error" });
      }
    }
    return res.json({ success: results.every((r) => r.ok), results, now: now() });
  }

  // ============================================================
  // ===== AZIONI GROUP V2 (round-robin server-side, parallelo) =
  // ============================================================

  // create_group
  // body: { action, expected_writers, total_turns, activity_title,
  //         room_mode?, prompt_seed?, ttl_h? }
  // Vincolo: total_turns deve essere multiplo intero positivo di expected_writers.
  if (action === "create_group") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const N = clampNumber(body.expected_writers, 0, 2, 20);
    if (N < 2) return res.status(400).json({ error: "expected_writers must be 2..20" });
    const total_turns = clampNumber(body.total_turns, 0, 1, 200);
    if (total_turns < N || total_turns % N !== 0) {
      return res.status(400).json({
        error: `total_turns must be a positive multiple of expected_writers (got ${total_turns}, N=${N})`,
      });
    }
    const ttl_h = clampNumber(body.ttl_h, 12, 1, 24);
    const expires_at = now() + ttl_h * 3600 * 1000;
    const gid = `grp-${crypto.randomBytes(3).toString("hex")}`;
    const activity_title = String(body.activity_title || gid).trim();
    const room_mode: RoomMode = body.room_mode || "CONTINUA_TU";
    const prompt_seed = String(body.prompt_seed || "").trim();

    const roomNames: string[] = [];
    for (let i = 1; i <= N; i++) {
      const rname = `${gid}-${i}`;
      const rst: RoomState = {
        room_name: rname,
        activity_title: `${activity_title} #${i}`,
        room_mode,
        prompt_seed,
        story_so_far: "",
        writers: [],
        current_writer_index: 0,
        turn_ends_at: null,
        turn_paused: false,
        turn_remaining_ms: null,
        version: 1,
        updated_at: now(),
        expires_at,
        group_id: gid,
        room_index: i - 1,
      };
      await saveRoom(rname, rst);
      roomNames.push(rname);
    }

    const g: GroupState = {
      group_id: gid,
      activity_title,
      room_mode,
      prompt_seed,
      expected_writers: N,
      rooms: roomNames,
      writers: [],
      turn_number: 0,
      total_turns,
      turn_ends_at: null,
      turn_paused: false,
      turn_remaining_ms: null,
      submitted_this_turn: [],
      status: "waiting",
      version: 1,
      created_at: now(),
      updated_at: now(),
      expires_at,
    };
    await saveGroup(g);
    return res.json({ success: true, group_id: gid, group_state: g });
  }

  // list_groups
  if (action === "list_groups") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const ids = await redis.smembers<string[]>(KEY_GROUPS_SET);
    const groups: GroupState[] = [];
    for (const id of ids || []) {
      const g = await getGroup(id);
      if (g) groups.push(g);
    }
    return res.json({ success: true, groups, now: now() });
  }

  // group_state: stato + assegnazioni turno corrente
  // body: { action, group_id }
  if (action === "group_state") {
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    const assignments = computeAssignments(g);
    return res.json({ success: true, group_state: g, assignments, now: now() });
  }

  // join_group: writer entra. Rifiutato se gruppo pieno o concluso.
  // body: { action, group_id }
  if (action === "join_group") {
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    if (g.status === "ended") return res.status(409).json({ error: "group ended" });
    if (g.writers.length >= g.expected_writers) {
      return res.status(409).json({ error: "group full" });
    }
    const writer_id = `Writer ${g.writers.length + 1}`;
    g.writers.push(writer_id);
    bump(g);
    await saveGroup(g);
    // Aggiungi anche il writer dentro ogni stanza del gruppo (per legacy/visibilità)
    for (const rname of g.rooms) {
      const rst = await getRoom(rname);
      if (rst && !rst.writers.includes(writer_id)) {
        rst.writers.push(writer_id);
        bump(rst);
        await saveRoom(rname, rst);
      }
    }
    return res.json({ success: true, writer_id, group_state: g });
  }

  // get_my_assignment: writer chiede su quale stanza scrivere ora.
  // Ora ritorna anche is_my_turn (true per TUTTI i writer non-submittati durante un turno attivo).
  // body: { action, group_id, writer_id }
  if (action === "get_my_assignment") {
    const gid = normalizeKey(body.group_id);
    const writer_id = normalizeKey(body.writer_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    const idx = g.writers.indexOf(writer_id);
    if (idx < 0) return res.status(403).json({ error: "writer not in group" });
    const assignments = computeAssignments(g);
    const has_submitted = g.submitted_this_turn.includes(writer_id);
    // FIX bug "writer in attesa": NON gating on g.turn_ends_at > now().
    // Il timeout viene gestito dall'avanzamento turno (auto o forzato dal SU).
    // Finché lo status è "active" e il writer non ha submittato, può scrivere.
    const is_my_turn =
      g.status === "active" &&
      !g.turn_paused &&
      g.turn_number > 0 &&
      !has_submitted;
    return res.json({
      success: true,
      assigned_room: assignments[writer_id] || null,
      turn_number: g.turn_number,
      total_turns: g.total_turns,
      turn_ends_at: g.turn_ends_at,
      turn_paused: g.turn_paused,
      turn_remaining_ms: g.turn_remaining_ms,
      status: g.status,
      has_submitted,
      is_my_turn,
      writer_id,
      group_id: gid,
    });
  }

  // group_advance_turn: SU avanza il turno (incrementa turn_number, ricalcola assegnazioni).
  // Funziona come "force next turn" se chiamato prima del timeout.
  // Quando turn_number supera total_turns, marca status="ended".
  // body: { action, group_id, turn_s? }
  if (action === "group_advance_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    if (g.status === "ended") {
      return res.json({ success: true, group_state: g, ended: true });
    }
    if (g.writers.length < g.expected_writers) {
      return res.status(409).json({
        error: "waiting for writers",
        joined: g.writers.length,
        expected: g.expected_writers,
      });
    }
    const next = g.turn_number + 1;
    if (g.total_turns > 0 && next > g.total_turns) {
      // Auto-end
      g.status = "ended";
      g.turn_paused = false;
      g.turn_ends_at = null;
      g.turn_remaining_ms = null;
      g.submitted_this_turn = [];
      bump(g);
      await saveGroup(g);
      // Ferma anche i timer delle stanze
      for (const rname of g.rooms) {
        const rst = await getRoom(rname);
        if (!rst) continue;
        rst.turn_ends_at = null;
        rst.turn_paused = false;
        rst.turn_remaining_ms = null;
        bump(rst);
        await saveRoom(rname, rst);
      }
      return res.json({ success: true, group_state: g, ended: true });
    }
    const turn_s = clampNumber(body.turn_s, 180, 15, 600);
    g.turn_number = next;
    g.status = "active";
    g.turn_paused = false;
    g.turn_remaining_ms = null;
    g.turn_ends_at = now() + turn_s * 1000;
    g.submitted_this_turn = []; // reset submit per il nuovo turno
    bump(g);
    await saveGroup(g);

    // Allinea i timer di tutte le stanze del gruppo (per coerenza visiva)
    const assignments = computeAssignments(g);
    for (const rname of g.rooms) {
      const rst = await getRoom(rname);
      if (!rst) continue;
      // current_writer_index della stanza = writer assegnato a quella stanza
      const assignedWriter = Object.entries(assignments).find(([, r]) => r === rname)?.[0] || null;
      if (assignedWriter) {
        const wIdx = rst.writers.indexOf(assignedWriter);
        if (wIdx >= 0) rst.current_writer_index = wIdx;
      }
      rst.turn_paused = false;
      rst.turn_remaining_ms = null;
      rst.turn_ends_at = g.turn_ends_at;
      bump(rst);
      await saveRoom(rname, rst);
    }
    return res.json({ success: true, group_state: g, assignments, now: now() });
  }

  // group_force_next_turn: alias di group_advance_turn che riusa la durata corrente
  // del turno (default 180s). Usato dal pulsante "Forza prossimo turno" del SU.
  // body: { action, group_id }
  if (action === "group_force_next_turn") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    let turn_s = 180;
    if (g.turn_ends_at && !g.turn_paused) {
      const remaining = Math.max(0, g.turn_ends_at - now());
      if (remaining > 0) turn_s = Math.max(15, Math.round(remaining / 1000));
    }
    (body as any).action = "group_advance_turn";
    (body as any).turn_s = turn_s;
    return handler(req, res);
  }

  // group_pause: pausa di tutto il gruppo via group_id
  // body: { action, group_id }
  if (action === "group_pause") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    if (g.status === "ended") return res.status(409).json({ error: "group ended" });
    if (g.turn_paused) return res.status(409).json({ error: "already paused" });
    if (g.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
    const remaining = Math.max(0, g.turn_ends_at - now());
    g.turn_paused = true;
    g.turn_remaining_ms = remaining;
    g.turn_ends_at = null;
    g.status = "paused";
    bump(g);
    await saveGroup(g);
    for (const rname of g.rooms) {
      const rst = await getRoom(rname);
      if (!rst) continue;
      rst.turn_paused = true;
      rst.turn_remaining_ms = remaining;
      rst.turn_ends_at = null;
      bump(rst);
      await saveRoom(rname, rst);
    }
    return res.json({ success: true, group_state: g });
  }

  // group_resume: ripresa di tutto il gruppo
  // body: { action, group_id }
  if (action === "group_resume") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    if (g.status === "ended") return res.status(409).json({ error: "group ended" });
    if (!g.turn_paused || g.turn_remaining_ms == null) return res.status(409).json({ error: "not paused" });
    const remaining = Math.max(0, Number(g.turn_remaining_ms) || 0);
    if (remaining <= 0) return res.status(409).json({ error: "no remaining time" });
    g.turn_paused = false;
    g.turn_ends_at = now() + remaining;
    g.turn_remaining_ms = null;
    g.status = "active";
    bump(g);
    await saveGroup(g);
    for (const rname of g.rooms) {
      const rst = await getRoom(rname);
      if (!rst) continue;
      rst.turn_paused = false;
      rst.turn_ends_at = g.turn_ends_at;
      rst.turn_remaining_ms = null;
      bump(rst);
      await saveRoom(rname, rst);
    }
    return res.json({ success: true, group_state: g });
  }

  // group_submit_text: writer invia testo nella stanza assegnata.
  // - Valida assegnazione round-robin
  // - Blocca doppio submit nello stesso turno (submitted_this_turn)
  // - NON avanza il turno automaticamente: l'avanzamento avviene solo via
  //   group_advance_turn (al timeout o forzato dal SU)
  // body: { action, group_id, writer_id, text }
  if (action === "group_submit_text") {
    const gid = normalizeKey(body.group_id);
    const writer_id = normalizeKey(body.writer_id);
    const g = await getGroup(gid);
    if (!g) return res.status(404).json({ error: "group not found" });
    if (now() > g.expires_at) return res.status(410).json({ error: "group expired" });
    if (g.status === "ended") return res.status(409).json({ error: "group ended" });
    const idx = g.writers.indexOf(writer_id);
    if (idx < 0) return res.status(403).json({ error: "writer not in group" });
    if (g.turn_number <= 0) return res.status(409).json({ error: "no active turn" });
    if (g.turn_paused) return res.status(409).json({ error: "turn paused" });
    if (g.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
    if (g.turn_ends_at <= now()) return res.status(409).json({ error: "turn expired" });
    if (g.submitted_this_turn.includes(writer_id)) {
      return res.status(409).json({ error: "already submitted this turn" });
    }
    const txt = String(body.text || "").trim();
    if (!txt) return res.status(400).json({ error: "empty text" });
    const assignments = computeAssignments(g);
    const targetRoom = assignments[writer_id];
    if (!targetRoom) return res.status(409).json({ error: "no room assigned" });
    const rst = await getRoom(targetRoom);
    if (!rst) return res.status(404).json({ error: "assigned room not found" });
    rst.story_so_far = (rst.story_so_far ? rst.story_so_far + "\n" : "") + txt;
    bump(rst);
    await saveRoom(targetRoom, rst);
    g.submitted_this_turn.push(writer_id);
    bump(g);
    await saveGroup(g);
    return res.json({
      success: true,
      assigned_room: targetRoom,
      room_state: rst,
      group_state: g,
    });
  }

  // delete_group: elimina gruppo + tutte le sue stanze
  // body: { action, group_id }
  if (action === "delete_group") {
    if (!isAdmin) return res.status(401).json({ error: "admin only" });
    const gid = normalizeKey(body.group_id);
    const g = await getGroup(gid);
    if (!g) return res.json({ success: true });
    for (const rname of g.rooms) {
      const rst = await getRoom(rname);
      if (rst) {
        rst.expires_at = now() - 1;
        rst.turn_paused = true;
        rst.turn_ends_at = null;
        rst.turn_remaining_ms = null;
        bump(rst);
        await saveRoom(rname, rst);
      }
    }
    g.expires_at = now() - 1;
    g.turn_paused = true;
    g.turn_ends_at = null;
    g.turn_remaining_ms = null;
    g.status = "ended";
    bump(g);
    await saveGroup(g);
    return res.json({ success: true });
  }

  return res.status(400).json({ error: "unknown action" });
}
