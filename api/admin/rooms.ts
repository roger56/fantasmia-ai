// api/admin/rooms.ts
/*
==================================================
FantasMIA / Fantasmia - API ROOMS / GROUPS  (v6)
==================================================

CHANGELOG v6 (rispetto a v5)
- NEW action `group_end`: soft-end del gruppo per il comando SU
  "Termina gruppo". Setta status="ended", congela timer, estende
  expires_at di 24h. I writer continuano a leggere group_state e
  vedono ended → EndedScreen (niente piu' 404 → 0/0).
- FIX `group_su_extras_view`: usava variabile `group_id` inesistente
  e leggeva da chiave Redis mai scritta. Ora legge da group.extras
  correttamente e include suggestions_log.
- FIX `group_request_suggestion`: usava `groups[group_id]` in-memory
  (non persistente). Ora usa getGroup/saveGroup, gestisce
  group.rooms come string[], e fa push in extras.suggestions_log.
- NEW type SuggestionLogEntry + ExtrasState.suggestions_log[].
- FIX `join_group` su gruppo ended: se il writer e' gia' joined,
  restituisce group_state (writer va su EndedScreen). I nuovi
  writer restano rifiutati con 409.

CHANGELOG v5 (rispetto a v4)
- Rotazione BACKWARD: roomIndex = ((wi - (turn - 1)) mod N + N) mod N.
- RoomState.story_so_far_at_turn_start: snapshot CONGELATO della storia
  all'inizio di ogni turno. Aggiornato SOLO da group_advance_turn.
- GroupState.default_turn_s: durata turno scelta dal SU alla creazione,
  fonte di verità per group_advance_turn / group_force_next_turn.
- group_force_next_turn: NON usa più il residuo del turno; riusa SEMPRE
  default_turn_s (o body.turn_s se passato esplicitamente).
- get_my_assignment: aggiunge `story_so_far_frozen` (per box "storia fino
  ad ora") e `story_so_far_live` (debug).
- group_state: espone default_turn_s.
- Pulizia bug minori (`instanceof Error & Error`, `&_paused`, `& 0`,
  `&_writer`, `myFlight & myFlight`).

ATTENZIONE: gruppi/stanze creati con versioni precedenti restano
compatibili in lettura (default_turn_s -> 180, snapshot -> ""), ma per
avere il comportamento corretto è raccomandato cancellare i gruppi
esistenti e ricrearli.
*/

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

/* ================================================== CORS ================================================== */
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  "https://fantas-ia.it",
  "https://www.fantas-ia.it",
  /^https:\/\/.*\.lovableproject\.com$/,
  /^https:\/\/.*\.lovable\.app$/,
  "https://lovable.app",
  "https://www.lovable.app",
  "https://lovable.dev",
  /^https:\/\/.*\.lovable\.dev$/,
  "http://localhost:5173",
  "http://localhost:3000",
];

function isOriginAllowed(origin: string): boolean {
  return allowedOrigins.some((item) =>
    typeof item === "string" ? item === origin : item.test(origin)
  );
}

function applyCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = String(req.headers.origin || "").trim();
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Requested-With, Authorization"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  if (!origin) return { ok: true, origin: "" };
  if (!isOriginAllowed(origin)) return { ok: false, origin };
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  return { ok: true, origin };
}

/* ================================================== TYPES ================================================== */
type RoomMode = "CONTINUA_TU" | "CAMPBELL" | "PROPP";

type RoomState = {
  room_name: string;
  activity_title: string;
  room_mode: RoomMode;
  prompt_seed: string;
  incipit?: string;
  story_so_far: string;
  /** Snapshot CONGELATO all'inizio del turno corrente. Aggiornato solo da group_advance_turn. */
  story_so_far_at_turn_start?: string;
  writers: string[];
  current_writer_index: number;
  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;
  version: number;
  updated_at: number;
  expires_at: number;
  group_id?: string | null;
  room_index?: number | null;
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
  room_index?: number | null;
};

type GroupStatus = "waiting" | "active" | "paused" | "ended";

type ExtrasConfig = {
  enabled: boolean;
  suggestions_enabled: boolean;
  obligations_enabled: boolean;
  qa_enabled: boolean;
  notify_seconds: number;
};

type PoolItem = { id: string; text: string };

type SuggestionUse = {
  suggestion_id: string;
  text: string;
  turn: number;
  used_at: number;
};

type ObligationLogEntry = {
  turn: number;
  writer_id: string;
  obligation_id: string;
  text: string;
  assigned_at: number;
};

type SuggestionLogEntry = {
  turn: number;
  writer_id: string;
  suggestion_id: string;
  text: string;
  room: string | null;
  ts: number;
};

type QaMessage = {
  id: string;
  from_writer: string;
  to_writer: string;
  body: string;
  reply_to?: string | null;
  origin_suggestion_id?: string | null;
  created_at: number;
};

type SuggestionFlight = { until: number; turn: number };

type ExtrasState = {
  config: ExtrasConfig;
  suggestions_pool: PoolItem[];
  obligations_pool: PoolItem[];
  used_suggestions_by_writer: Record<string, SuggestionUse>;
  obligations_log: ObligationLogEntry[];
  suggestions_log: SuggestionLogEntry[];
  qa_threads: QaMessage[];
  /** @deprecated retrocompat */
  suggestion_in_flight_until: number | null;
  suggestion_in_flight_by_writer: Record<string, SuggestionFlight>;
};

type GroupState = {
  group_id: string;
  activity_title: string;
  room_mode: RoomMode;
  prompt_seed: string;
  expected_writers: number;
  rooms: string[];
  writers: string[];
  turn_number: number;
  total_turns: number;
  /** Durata turno scelta dal SU alla creazione (secondi). Fonte di verità per advance/force. */
  default_turn_s: number;
  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;
  submitted_this_turn: string[];
  status: GroupStatus;
  extras?: ExtrasState | null;
  version: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type GroupResult = {
  room: string;
  ok: boolean;
  status?: number;
  error?: string;
  room_state?: RoomState;
};

type AssignmentDetail = {
  writer_id: string;
  writer_index: number;
  room: string | null;
  room_index: number | null;
};

type ApiErrorBody = { error: string; details?: string };

/* ================================================== REDIS / KEYS ================================================== */
const redis = Redis.fromEnv();
const KEY_ROOM = (room: string) => `rooms:room:${room}`;
const KEY_ROOMS_SET = "rooms:all";
const KEY_GROUP = (groupId: string) => `groups:group:${groupId}`;
const KEY_GROUPS_SET = "groups:all";

/* ================================================== UTILS ================================================== */
const now = () => Date.now();

function normalizeKey(value: any): string {
  return value ? String(value).trim() : "";
}

function clampNumber(value: any, fallback: number, min?: number, max?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function normalizeRoomMode(value: any): RoomMode {
  if (value === "CAMPBELL" || value === "PROPP" || value === "CONTINUA_TU") return value;
  return "CONTINUA_TU";
}

function bump(state: RoomState | GroupState) {
  state.version = (state.version || 0) + 1;
  state.updated_at = now();
}

function parseRoomsArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((room) => normalizeKey(room)).filter(Boolean);
}

function safeMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "unexpected error";
}

function isRedisLimitError(err: unknown): boolean {
  const msg = safeMessage(err).toLowerCase();
  return (
    msg.includes("free tier limit") ||
    msg.includes("limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  );
}

function handleServerError(res: NextApiResponse, err: unknown) {
  if (isRedisLimitError(err)) {
    return res.status(429).json({
      error: "Redis usage limit reached",
      details:
        "Il database Redis/Upstash ha raggiunto il limite di utilizzo. Ridurre il polling o usare un piano adeguato.",
    } satisfies ApiErrorBody);
  }
  return res.status(500).json({
    error: "server error",
    details: safeMessage(err),
  } satisfies ApiErrorBody);
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function shortId(prefix = "x"): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

/* ================================================== ADMIN VERIFY ================================================== */
function verifyAdmin(req: NextApiRequest): boolean {
  const auth = String(req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const [header, payloadEncoded, signature] = token.split(".");
  if (!header || !payloadEncoded || !signature) return false;

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return false;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payloadEncoded}`)
    .digest("base64url");
  if (expectedSignature !== signature) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString());
    return (
      payload.role === "ADMIN" &&
      typeof payload.exp === "number" &&
      payload.exp * 1000 > now()
    );
  } catch {
    return false;
  }
}

/* ================================================== REDIS HELPERS - ROOMS ================================================== */
function normalizeRoomState(room: string, state: RoomState): RoomState {
  return {
    room_name: state.room_name || room,
    activity_title: state.activity_title || state.room_name || room,
    room_mode: normalizeRoomMode(state.room_mode),
    prompt_seed: String(state.prompt_seed || ""),
    incipit: typeof state.incipit === "string" ? state.incipit : "",
    story_so_far: String(state.story_so_far || ""),
    story_so_far_at_turn_start:
      typeof state.story_so_far_at_turn_start === "string"
        ? state.story_so_far_at_turn_start
        : "",
    writers: Array.isArray(state.writers) ? state.writers : [],
    current_writer_index: Number.isFinite(Number(state.current_writer_index))
      ? Number(state.current_writer_index)
      : 0,
    turn_ends_at: state.turn_ends_at ?? null,
    turn_paused: Boolean(state.turn_paused),
    turn_remaining_ms: state.turn_remaining_ms ?? null,
    version: Number(state.version || 1),
    updated_at: Number(state.updated_at || now()),
    expires_at: Number(state.expires_at || now() + 3600 * 1000),
    group_id: state.group_id || null,
    room_index:
      typeof state.room_index === "number" && Number.isFinite(state.room_index)
        ? state.room_index
        : null,
  };
}

async function getRoom(room: string, cleanupExpired = false): Promise<RoomState | null> {
  const state = await redis.get<RoomState>(KEY_ROOM(room));
  if (!state) return null;
  const normalized = normalizeRoomState(room, state);
  if (now() > normalized.expires_at) {
    if (cleanupExpired) {
      await redis.del(KEY_ROOM(room));
      await redis.srem(KEY_ROOMS_SET, room);
    }
    return null;
  }
  return normalized;
}

async function saveRoom(room: string, state: RoomState) {
  const ttlSeconds = Math.max(60, Math.ceil((state.expires_at - now()) / 1000));
  await redis.set(KEY_ROOM(room), state, { ex: ttlSeconds });
  await redis.sadd(KEY_ROOMS_SET, room);
}

function toSummary(room: string, state: RoomState): RoomSummary {
  return {
    room,
    room_name: state.room_name,
    activity_title: state.activity_title,
    room_mode: state.room_mode,
    writers_count: state.writers.length,
    current_writer: state.writers[state.current_writer_index] || null,
    turn_ends_at: state.turn_ends_at,
    turn_paused: state.turn_paused,
    turn_remaining_ms: state.turn_remaining_ms,
    version: state.version,
    updated_at: state.updated_at,
    expires_at: state.expires_at,
    group_id: state.group_id || null,
    room_index: state.room_index ?? null,
  };
}

/* ================================================== REDIS HELPERS - GROUPS ================================================== */
function normalizePoolItem(value: any, fallbackPrefix: string, idx: number): PoolItem | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    return { id: `${fallbackPrefix}${idx + 1}`, text };
  }
  if (value && typeof value === "object") {
    const text = String(value.text || "").trim();
    if (!text) return null;
    const id = String(value.id || `${fallbackPrefix}${idx + 1}`);
    return { id, text };
  }
  return null;
}

function normalizePoolArray(value: any, prefix: string): PoolItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v, i) => normalizePoolItem(v, prefix, i))
    .filter((x): x is PoolItem => !!x);
}

function normalizeFlightMap(value: any): Record<string, SuggestionFlight> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, SuggestionFlight> = {};
  for (const k of Object.keys(value)) {
    const v = (value as any)[k];
    if (v && typeof v === "object" && Number.isFinite(Number(v.until))) {
      out[k] = { until: Number(v.until), turn: Number(v.turn || 0) };
    }
  }
  return out;
}

function normalizeExtrasState(value: any): ExtrasState | null {
  if (!value || typeof value !== "object") return null;
  const cfg = value.config || {};
  const config: ExtrasConfig = {
    enabled: cfg.enabled !== false,
    suggestions_enabled: !!cfg.suggestions_enabled,
    obligations_enabled: !!cfg.obligations_enabled,
    qa_enabled: !!cfg.qa_enabled,
    notify_seconds: clampNumber(cfg.notify_seconds, 10, 3, 60),
  };
  return {
    config,
    suggestions_pool: normalizePoolArray(value.suggestions_pool, "s"),
    obligations_pool: normalizePoolArray(value.obligations_pool, "o"),
    used_suggestions_by_writer:
      value.used_suggestions_by_writer && typeof value.used_suggestions_by_writer === "object"
        ? value.used_suggestions_by_writer
        : {},
    obligations_log: Array.isArray(value.obligations_log) ? value.obligations_log : [],
    suggestions_log: Array.isArray(value.suggestions_log) ? value.suggestions_log : [],
    qa_threads: Array.isArray(value.qa_threads) ? value.qa_threads : [],
    suggestion_in_flight_until:
      typeof value.suggestion_in_flight_until === "number"
        ? value.suggestion_in_flight_until
        : null,
    suggestion_in_flight_by_writer: normalizeFlightMap(value.suggestion_in_flight_by_writer),
  };
}

function normalizeGroupState(groupId: string, state: GroupState): GroupState {
  const turnNumber = Number(state.turn_number || 0);
  const turnPaused = Boolean(state.turn_paused);
  let status: GroupStatus = state.status || "waiting";
  if (!state.status) {
    status = turnNumber > 0 ? (turnPaused ? "paused" : "active") : "waiting";
  }
  return {
    group_id: state.group_id || groupId,
    activity_title: state.activity_title || state.group_id || groupId,
    room_mode: normalizeRoomMode(state.room_mode),
    prompt_seed: String(state.prompt_seed || ""),
    expected_writers: Number(state.expected_writers || 0),
    rooms: Array.isArray(state.rooms) ? state.rooms : [],
    writers: Array.isArray(state.writers) ? state.writers : [],
    turn_number: turnNumber,
    total_turns: typeof state.total_turns === "number" ? state.total_turns : 0,
    default_turn_s: clampNumber((state as any).default_turn_s, 180, 15, 600),
    turn_ends_at: state.turn_ends_at ?? null,
    turn_paused: turnPaused,
    turn_remaining_ms: state.turn_remaining_ms ?? null,
    submitted_this_turn: Array.isArray(state.submitted_this_turn) ? state.submitted_this_turn : [],
    status,
    extras: normalizeExtrasState((state as any).extras),
    version: Number(state.version || 1),
    created_at: Number(state.created_at || now()),
    updated_at: Number(state.updated_at || now()),
    expires_at: Number(state.expires_at || now() + 3600 * 1000),
  };
}

async function getGroup(groupId: string, cleanupExpired = false): Promise<GroupState | null> {
  if (!groupId) return null;
  const state = await redis.get<GroupState>(KEY_GROUP(groupId));
  if (!state) return null;
  const normalized = normalizeGroupState(groupId, state);
  if (now() > normalized.expires_at) {
    if (cleanupExpired) {
      await redis.del(KEY_GROUP(groupId));
      await redis.srem(KEY_GROUPS_SET, groupId);
    }
    return null;
  }
  return normalized;
}

async function saveGroup(group: GroupState) {
  const ttlSeconds = Math.max(60, Math.ceil((group.expires_at - now()) / 1000));
  await redis.set(KEY_GROUP(group.group_id), group, { ex: ttlSeconds });
  await redis.sadd(KEY_GROUPS_SET, group.group_id);
}

/* ================================================== ROTATION (BACKWARD) ================================================== */
/**
 * Rotazione BACKWARD writer→stanza.
 *   roomIndex = ((writerIndex - (turnNumber - 1)) mod N + N) mod N
 * Al turno 1 ogni writer parte dalla stanza con il proprio indice.
 */
function getAssignedRoomIndex(writerIndex: number, turnNumber: number, N: number): number {
  if (N <= 0) return 0;
  const tn = Math.max(1, turnNumber || 1);
  return ((writerIndex - (tn - 1)) % N + N) % N;
}

function computeAssignments(group: GroupState): Record<string, string> {
  const out: Record<string, string> = {};
  const N = group.rooms.length;
  if (N === 0) return out;
  for (let wi = 0; wi < group.writers.length; wi++) {
    const writer = group.writers[wi];
    const idx = getAssignedRoomIndex(wi, group.turn_number, N);
    out[writer] = group.rooms[idx];
  }
  return out;
}

function computeAssignmentDetails(group: GroupState): AssignmentDetail[] {
  const N = group.rooms.length;
  const details: AssignmentDetail[] = [];
  for (let wi = 0; wi < group.writers.length; wi++) {
    const writer = group.writers[wi];
    if (N === 0) {
      details.push({ writer_id: writer, writer_index: wi, room: null, room_index: null });
      continue;
    }
    const idx = getAssignedRoomIndex(wi, group.turn_number, N);
    details.push({
      writer_id: writer,
      writer_index: wi,
      room: group.rooms[idx] || null,
      room_index: idx,
    });
  }
  return details;
}

function findAssignedWriterForRoom(group: GroupState, roomName: string): string | null {
  const N = group.rooms.length;
  if (N === 0) return null;
  const roomIdx = group.rooms.indexOf(roomName);
  if (roomIdx < 0) return null;
  // Inversa della formula backward: wi = (roomIdx + (tn - 1)) mod N
  const tn = Math.max(1, group.turn_number || 1);
  const wi = (roomIdx + (tn - 1)) % N;
  return group.writers[wi] || null;
}

/* ================================================== EXTRAS HELPERS ================================================== */
function parseExtrasConfigFromBody(
  ec: any,
  expectedWriters: number,
  totalTurns: number
): ExtrasState | null {
  if (!ec || typeof ec !== "object") return null;

  // Formato CLIENT corrente
  const enabled =
    !!ec.enabled ||
    !!ec.suggestions_enabled ||
    !!ec.obligations_enabled ||
    !!ec.qa_enabled;
  if (!enabled) return null;

  const config: ExtrasConfig = {
    enabled: true,
    suggestions_enabled: !!ec.suggestions_enabled,
    obligations_enabled: !!ec.obligations_enabled,
    qa_enabled: !!ec.qa_enabled,
    notify_seconds: clampNumber(ec.notify_seconds, 10, 3, 60),
  };

  // Suggestions pool: NW pescati random
  let suggestionsPool: PoolItem[] = [];
  if (config.suggestions_enabled && Array.isArray(ec.suggestions_pool)) {
    const all = (ec.suggestions_pool as any[])
      .map((t, i) => normalizePoolItem(t, "s", i))
      .filter((x): x is PoolItem => !!x);
    suggestionsPool = shuffled(all).slice(0, expectedWriters);
  }

  // Obligations pool: NO = NW se NT > NW, altrimenti NW - 1
  let obligationsPool: PoolItem[] = [];
  if (config.obligations_enabled && Array.isArray(ec.obligations_pool)) {
    const all = (ec.obligations_pool as any[])
      .map((t, i) => normalizePoolItem(t, "o", i))
      .filter((x): x is PoolItem => !!x);
    const target = totalTurns > expectedWriters ? expectedWriters : Math.max(0, expectedWriters - 1);
    obligationsPool = shuffled(all).slice(0, target);
  }

  return {
    config,
    suggestions_pool: suggestionsPool,
    obligations_pool: obligationsPool,
    used_suggestions_by_writer: {},
    obligations_log: [],
    suggestions_log: [],
    qa_threads: [],
    suggestion_in_flight_until: null,
    suggestion_in_flight_by_writer: {},
  };
}

function findCurrentObligationFor(
  group: GroupState,
  writerId: string
): { id: string; text: string; turn: number } | null {
  if (!group.extras) return null;
  const entry = group.extras.obligations_log.find(
    (e) => e.writer_id === writerId && e.turn === group.turn_number
  );
  if (!entry) return null;
  return { id: entry.obligation_id, text: entry.text, turn: entry.turn };
}

function maybeAssignObligationForTurn(group: GroupState): ObligationLogEntry | null {
  if (!group.extras || !group.extras.config.enabled || !group.extras.config.obligations_enabled) {
    return null;
  }
  if (group.turn_number <= 1) return null;
  if (!group.extras.obligations_pool.length) return null;

  const alreadyAssigned = new Set(group.extras.obligations_log.map((e) => e.writer_id));
  const candidates = group.writers.filter((w) => !alreadyAssigned.has(w));
  if (!candidates.length) return null;

  const writer = pickRandom(candidates);
  if (!writer) return null;

  const idx = Math.floor(Math.random() * group.extras.obligations_pool.length);
  const [picked] = group.extras.obligations_pool.splice(idx, 1);

  const entry: ObligationLogEntry = {
    turn: group.turn_number,
    writer_id: writer,
    obligation_id: picked.id,
    text: picked.text,
    assigned_at: now(),
  };
  group.extras.obligations_log.push(entry);
  console.log("[extras] obligation turn=%d writer=%s id=%s", entry.turn, writer, picked.id);
  return entry;
}

/* ================================================== HANDLER ================================================== */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cors = applyCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(cors.ok ? 204 : 403).end();
  }
  if (!cors.ok) return res.status(403).json({ error: "origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body: any = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const action = String(body.action || "").trim();
  const isAdmin = verifyAdmin(req);

  try {
    /* -------------------- LEGACY SINGLE ROOM -------------------- */
    if (action === "list_rooms") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const ids = (await redis.smembers<string[]>(KEY_ROOMS_SET)) || [];
      const rooms: RoomSummary[] = [];
      for (const id of ids) {
        const s = await getRoom(id, true);
        if (s) rooms.push(toSummary(id, s));
      }
      rooms.sort((a, b) => b.updated_at - a.updated_at);
      return res.json({ success: true, rooms, now: now() });
    }

    if (action === "next_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });
      if (!state.writers.length) return res.status(409).json({ error: "no writers yet" });

      const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
      state.current_writer_index = (state.current_writer_index + 1) % state.writers.length;
      state.turn_paused = false;
      state.turn_remaining_ms = null;
      state.turn_ends_at = now() + turnSeconds * 1000;
      bump(state);
      await saveRoom(room, state);
      return res.json({ success: true, room_state: state });
    }

    if (action === "pause_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });
      if (state.turn_paused) return res.status(409).json({ error: "already paused" });
      if (state.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });

      const remaining = Math.max(0, state.turn_ends_at - now());
      state.turn_paused = true;
      state.turn_remaining_ms = remaining;
      state.turn_ends_at = null;
      bump(state);
      await saveRoom(room, state);
      return res.json({ success: true, room_state: state });
    }

    if (action === "resume_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const room = normalizeKey(body.room);
      if (!room) return res.status(400).json({ error: "missing room" });
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });
      if (!state.turn_paused || state.turn_remaining_ms == null) {
        return res.status(409).json({ error: "not paused" });
      }
      const remaining = Math.max(0, Number(state.turn_remaining_ms) || 0);
      if (remaining <= 0) {
        state.turn_paused = false;
        state.turn_remaining_ms = null;
        state.turn_ends_at = null;
        bump(state);
        await saveRoom(room, state);
        return res.status(409).json({ error: "no remaining time" });
      }
      state.turn_paused = false;
      state.turn_ends_at = now() + remaining;
      state.turn_remaining_ms = null;
      bump(state);
      await saveRoom(room, state);
      return res.json({ success: true, room_state: state });
    }

    if (action === "submit_text") {
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });
      if (now() > state.expires_at) return res.status(410).json({ error: "room expired" });

      const writerId = normalizeKey(body.writer_id);
      if (!writerId) return res.status(400).json({ error: "missing writer_id" });

      const writerIndex = state.writers.indexOf(writerId);
      if (writerIndex < 0) return res.status(403).json({ error: "writer not in room" });

      const currentWriter = state.writers[state.current_writer_index];
      if (writerId !== currentWriter) return res.status(403).json({ error: "not your turn" });
      if (state.turn_paused) return res.status(409).json({ error: "turn paused" });
      if (state.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
      if (state.turn_ends_at <= now()) return res.status(409).json({ error: "turn expired" });

      const text = String(body.text || "").trim();
      if (!text) return res.status(400).json({ error: "empty text" });

      state.story_so_far = (state.story_so_far ? `${state.story_so_far}\n` : "") + text;
      state.turn_ends_at = null;
      state.turn_paused = false;
      state.turn_remaining_ms = null;
      bump(state);
      await saveRoom(room, state);
      return res.json({ success: true, room_state: state });
    }

    if (action === "delete_room") {
      if (!isAdmin) return res.status(401).json({ error: "admin required" });
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.json({ success: true });
      state.expires_at = now() - 1;
      state.turn_paused = true;
      state.turn_ends_at = null;
      state.turn_remaining_ms = null;
      bump(state);
      await saveRoom(room, state);
      return res.json({ success: true });
    }

    if (action === "get_state") {
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });
      return res.json({ success: true, room_state: state });
    }

    /* -------------------- LEGACY GROUP (batch) -------------------- */
    if (action === "group_next_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const rooms = parseRoomsArray(body.rooms);
      if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });
      const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
      const results: GroupResult[] = [];
      for (const room of rooms) {
        try {
          const state = await getRoom(room);
          if (!state) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
          if (!state.writers.length) { results.push({ room, ok: false, status: 409, error: "no writers yet" }); continue; }
          state.current_writer_index = (state.current_writer_index + 1) % state.writers.length;
          state.turn_paused = false;
          state.turn_remaining_ms = null;
          state.turn_ends_at = now() + turnSeconds * 1000;
          bump(state);
          await saveRoom(room, state);
          results.push({ room, ok: true, status: 200, room_state: state });
        } catch (err) {
          results.push({ room, ok: false, status: 500, error: safeMessage(err) });
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
          const state = await getRoom(room);
          if (!state) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
          if (state.turn_paused) { results.push({ room, ok: false, status: 409, error: "already paused" }); continue; }
          if (state.turn_ends_at == null) { results.push({ room, ok: false, status: 409, error: "no active turn" }); continue; }
          const remaining = Math.max(0, state.turn_ends_at - now());
          state.turn_paused = true;
          state.turn_remaining_ms = remaining;
          state.turn_ends_at = null;
          bump(state);
          await saveRoom(room, state);
          results.push({ room, ok: true, status: 200, room_state: state });
        } catch (err) {
          results.push({ room, ok: false, status: 500, error: safeMessage(err) });
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
          const state = await getRoom(room);
          if (!state) { results.push({ room, ok: false, status: 404, error: "room not found" }); continue; }
          if (!state.turn_paused || state.turn_remaining_ms == null) {
            results.push({ room, ok: false, status: 409, error: "not paused" }); continue;
          }
          const remaining = Math.max(0, Number(state.turn_remaining_ms) || 0);
          if (remaining <= 0) { results.push({ room, ok: false, status: 409, error: "no remaining time" }); continue; }
          state.turn_paused = false;
          state.turn_ends_at = now() + remaining;
          state.turn_remaining_ms = null;
          bump(state);
          await saveRoom(room, state);
          results.push({ room, ok: true, status: 200, room_state: state });
        } catch (err) {
          results.push({ room, ok: false, status: 500, error: safeMessage(err) });
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
          const state = await getRoom(room);
          if (!state) { results.push({ room, ok: true, status: 200 }); continue; }
          state.expires_at = now() - 1;
          state.turn_paused = true;
          state.turn_ends_at = null;
          state.turn_remaining_ms = null;
          bump(state);
          await saveRoom(room, state);
          results.push({ room, ok: true, status: 200 });
        } catch (err) {
          results.push({ room, ok: false, status: 500, error: safeMessage(err) });
        }
      }
      return res.json({ success: results.every((r) => r.ok), results, now: now() });
    }

    /* -------------------- GROUP V2 -------------------- */
    if (action === "create_group") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const expectedWriters = clampNumber(body.expected_writers, 0, 2, 20);
      if (expectedWriters < 2) return res.status(400).json({ error: "expected_writers must be 2..20" });
      const totalTurns = clampNumber(body.total_turns, 0, 1, 200);
      if (totalTurns < expectedWriters || totalTurns % expectedWriters !== 0) {
        return res.status(400).json({
          error: `total_turns must be a positive multiple of expected_writers (got ${totalTurns}, N=${expectedWriters})`,
        });
      }
      const ttlHours = clampNumber(body.ttl_h, 12, 1, 24);
      const expiresAt = now() + ttlHours * 3600 * 1000;
      const groupId = `grp-${crypto.randomBytes(3).toString("hex")}`;
      const activityTitle =
        String(body.title || body.activity_title || groupId).trim() || groupId;
      const roomMode = normalizeRoomMode(body.room_mode);
      const promptSeed = String(body.prompt_seed || "").trim();
      const defaultTurnS = clampNumber(body.turn_s, 180, 15, 600);
      const roomsMeta: Array<{ title?: string; incipit?: string }> = Array.isArray(body.rooms_meta)
        ? body.rooms_meta
        : [];
      const inputTitles: string[] = Array.isArray(body.room_titles) ? body.room_titles : [];
      const roomNames: string[] = [];
      for (let i = 1; i <= expectedWriters; i++) {
        const roomName = `${groupId}-${i}`;
        const meta = roomsMeta[i - 1] || {};
        const roomTitle =
          String(meta.title || inputTitles[i - 1] || `${activityTitle} #${i}`).trim() ||
          `Stanza ${i}`;
        const roomIncipit = String(meta.incipit || "").trim();
        // SEED: l'incipit diventa la prima riga narrativa reale della storia.
        // Viene scritto sia in story_so_far (live) sia nello snapshot congelato
        // così è subito visibile al SU e ai writer dal turno 1.
        const seededStory = roomIncipit;
        const roomState: RoomState = {
          room_name: roomName,
          activity_title: roomTitle,
          room_mode: roomMode,
          prompt_seed: promptSeed,
          incipit: roomIncipit,
          story_so_far: seededStory,
          story_so_far_at_turn_start: seededStory,
          writers: [],
          current_writer_index: 0,
          turn_ends_at: null,
          turn_paused: false,
          turn_remaining_ms: null,
          version: 1,
          updated_at: now(),
          expires_at: expiresAt,
          group_id: groupId,
          room_index: i - 1,
        };
        await saveRoom(roomName, roomState);
        roomNames.push(roomName);
      }
      const extras = parseExtrasConfigFromBody(body.extras_config, expectedWriters, totalTurns);
      const groupState: GroupState = {
        group_id: groupId,
        activity_title: activityTitle,
        room_mode: roomMode,
        prompt_seed: promptSeed,
        expected_writers: expectedWriters,
        rooms: roomNames,
        writers: [],
        turn_number: 0,
        total_turns: totalTurns,
        default_turn_s: defaultTurnS,
        turn_ends_at: null,
        turn_paused: false,
        turn_remaining_ms: null,
        submitted_this_turn: [],
        status: "waiting",
        extras,
        version: 1,
        created_at: now(),
        updated_at: now(),
        expires_at: expiresAt,
      };
      await saveGroup(groupState);
      return res.json({ success: true, group_id: groupId, group_state: groupState,suggestion_in_flight_until: group.extras?.suggestion_in_flight_until ?? null,
 });

    }

    if (action === "list_groups") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const ids = (await redis.smembers<string[]>(KEY_GROUPS_SET)) || [];
      const groups: GroupState[] = [];
      for (const id of ids) {
        const group = await getGroup(id, true);
        if (group) groups.push(group);
      }
      groups.sort((a, b) => b.updated_at - a.updated_at);
      return res.json({ success: true, groups, now: now() });
    }

    if (action === "group_state") {
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      const assignments = computeAssignments(group);
      const assignment_details = computeAssignmentDetails(group);

      const extras_public = group.extras
        ? {
            enabled: group.extras.config.enabled,
            suggestions_enabled: group.extras.config.suggestions_enabled,
            obligations_enabled: group.extras.config.obligations_enabled,
            qa_enabled: group.extras.config.qa_enabled,
            notify_seconds: group.extras.config.notify_seconds,
            suggestions_remaining: group.extras.suggestions_pool.length,
            obligations_remaining: group.extras.obligations_pool.length,
          }
        : { enabled: false };

      return res.json({
        success: true,
        group_state: group,
        assignments,
        assignment_details,
        extras_public,
        default_turn_s: group.default_turn_s,
        now: now(),
      });
    }

    if (action === "join_group") {
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      const writerId = normalizeKey(body.writer_id) || `Writer ${group.writers.length + 1}`;

      // Gruppo ended: se writer gia' joined, restituisci lo stato (client mostra EndedScreen).
      // Solo i writer nuovi restano rifiutati.
      if (group.status === "ended") {
        if (group.writers.includes(writerId)) {
          return res.json({ success: true, writer_id: writerId, group_state: group, ended: true });
        }
        return res.status(409).json({ error: "group ended" });
      }
      if (group.writers.length >= group.expected_writers && !group.writers.includes(writerId)) {
        return res.status(409).json({ error: "group full" });
      }

      if (group.writers.includes(writerId)) {
        return res.json({ success: true, writer_id: writerId, group_state: group });
      }

      group.writers.push(writerId);
      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;
        if (!roomState.writers.includes(writerId)) {
          roomState.writers.push(writerId);
          bump(roomState);
          await saveRoom(roomName, roomState);
        }
      }
      return res.json({ success: true, writer_id: writerId, group_state: group });
    }

    if (action === "get_my_assignment") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      const writerIndex = group.writers.indexOf(writerId);
      if (writerIndex < 0) return res.status(403).json({ error: "writer not in group" });

      const assignments = computeAssignments(group);
      const assignedRoom = assignments[writerId] || null;
      const assignedRoomState = assignedRoom ? await getRoom(assignedRoom) : null;
      const hasSubmitted = group.submitted_this_turn.includes(writerId);
      const isMyTurn =
        group.status === "active" &&
        !group.turn_paused &&
        group.turn_number > 0 &&
        !hasSubmitted;

      return res.json({
        success: true,
        assigned_room: assignedRoom,
        assigned_room_title: assignedRoomState?.activity_title || assignedRoom,
        assigned_room_incipit: assignedRoomState?.incipit || "",
        story_so_far_frozen: assignedRoomState?.story_so_far_at_turn_start ?? "",
        story_so_far_live: assignedRoomState?.story_so_far ?? "",
        room_state: assignedRoomState || null,
        turn_number: group.turn_number,
        total_turns: group.total_turns,
        default_turn_s: group.default_turn_s,
        turn_ends_at: group.turn_ends_at,
        turn_paused: group.turn_paused,
        turn_remaining_ms: group.turn_remaining_ms,
        status: group.status,
        has_submitted: hasSubmitted,
        is_my_turn: isMyTurn,
        writer_id: writerId,
        writer_index: writerIndex,
        group_id: groupId,
      });
    }

    if (action === "group_advance_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (group.status === "ended") {
        return res.json({ success: true, group_state: group, ended: true });
      }
      if (group.writers.length < group.expected_writers) {
        return res.status(409).json({
          error: "waiting for writers",
          joined: group.writers.length,
          expected: group.expected_writers,
        });
      }

      const nextTurn = group.turn_number + 1;
      console.log("[group] advance_turn group=%s turn=%d → next=%d", groupId, group.turn_number, nextTurn);

      if (group.total_turns > 0 && nextTurn > group.total_turns) {
        group.status = "ended";
        group.turn_paused = false;
        group.turn_ends_at = null;
        group.turn_remaining_ms = null;
        group.submitted_this_turn = [];
        bump(group);
        await saveGroup(group);

        for (const roomName of group.rooms) {
          const roomState = await getRoom(roomName);
          if (!roomState) continue;
          roomState.turn_ends_at = null;
          roomState.turn_paused = false;
          roomState.turn_remaining_ms = null;
          bump(roomState);
          await saveRoom(roomName, roomState);
        }
        return res.json({ success: true, group_state: group, ended: true });
      }

      // turn_s: priorità body, poi default_turn_s del gruppo
      const turnSeconds = clampNumber(body.turn_s, group.default_turn_s || 180, 15, 600);
      group.turn_number = nextTurn;
      group.status = "active";
      group.turn_paused = false;
      group.turn_remaining_ms = null;
      group.turn_ends_at = now() + turnSeconds * 1000;
      group.submitted_this_turn = [];

      const obligationAssigned = maybeAssignObligationForTurn(group);

      bump(group);
      await saveGroup(group);

      // Per OGNI stanza: aggiorna writer corrente E congela snapshot storia.
      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;

        // SNAPSHOT CONGELATO: la storia accumulata fino ad ora diventa il
        // contenuto IMMUTABILE che i writer vedranno per tutto questo turno.
        roomState.story_so_far_at_turn_start = roomState.story_so_far || "";

        const assignedWriter = findAssignedWriterForRoom(group, roomName);
        if (assignedWriter) {
          const wIdx = roomState.writers.indexOf(assignedWriter);
          if (wIdx >= 0) roomState.current_writer_index = wIdx;
        }
        roomState.turn_paused = false;
        roomState.turn_remaining_ms = null;
        roomState.turn_ends_at = group.turn_ends_at;
        bump(roomState);
        await saveRoom(roomName, roomState);
      }

      return res.json({
        success: true,
        group_state: group,
        assignments: computeAssignments(group),
        assignment_details: computeAssignmentDetails(group),
        obligation_assigned: obligationAssigned,
        now: now(),
      });
    }

    if (action === "group_force_next_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      // SEMPRE default_turn_s (o body.turn_s esplicito), MAI il residuo.
      const turnSeconds = clampNumber(body.turn_s, group.default_turn_s || 180, 15, 600);
      body.action = "group_advance_turn";
      body.turn_s = turnSeconds;
      return handler(req, res);
    }

    if (action === "group_pause") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });
      if (group.turn_paused) return res.status(409).json({ error: "already paused" });
      if (group.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });

      const remaining = Math.max(0, group.turn_ends_at - now());
      group.turn_paused = true;
      group.turn_remaining_ms = remaining;
      group.turn_ends_at = null;
      group.status = "paused";
      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;
        roomState.turn_paused = true;
        roomState.turn_remaining_ms = remaining;
        roomState.turn_ends_at = null;
        bump(roomState);
        await saveRoom(roomName, roomState);
      }
      return res.json({ success: true, group_state: group });
    }

    if (action === "group_resume") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });
      if (!group.turn_paused || group.turn_remaining_ms == null) {
        return res.status(409).json({ error: "not paused" });
      }
      const remaining = Math.max(0, Number(group.turn_remaining_ms) || 0);
      if (remaining <= 0) return res.status(409).json({ error: "no remaining time" });

      group.turn_paused = false;
      group.turn_ends_at = now() + remaining;
      group.turn_remaining_ms = null;
      group.status = "active";
      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;
        roomState.turn_paused = false;
        roomState.turn_ends_at = group.turn_ends_at;
        roomState.turn_remaining_ms = null;
        bump(roomState);
        await saveRoom(roomName, roomState);
      }
      return res.json({ success: true, group_state: group });
    }

    if (action === "group_submit_text") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (now() > group.expires_at) return res.status(410).json({ error: "group expired" });
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });

      const writerIndex = group.writers.indexOf(writerId);
      if (writerIndex < 0) return res.status(403).json({ error: "writer not in group" });
      if (group.turn_number <= 0) return res.status(409).json({ error: "no active turn" });
      if (group.turn_paused) return res.status(409).json({ error: "turn paused" });
      if (group.status !== "active") return res.status(409).json({ error: "group not active" });
      if (group.turn_ends_at == null) return res.status(409).json({ error: "no active turn" });
      if (group.turn_ends_at <= now()) return res.status(409).json({ error: "turn expired" });
      if (group.submitted_this_turn.includes(writerId)) {
        return res.status(409).json({ error: "already submitted this turn" });
      }

      const text = String(body.text || "").trim();
      if (!text) return res.status(400).json({ error: "empty text" });

      const assignments = computeAssignments(group);
      const targetRoom = assignments[writerId];
      if (!targetRoom) return res.status(409).json({ error: "no room assigned" });

      const roomState = await getRoom(targetRoom);
      if (!roomState) return res.status(404).json({ error: "assigned room not found" });

      // EXTRAS marker
      let textToAppend = text;
      const obligationEntry = findCurrentObligationFor(group, writerId);
      if (obligationEntry) {
        const marker = `<!-- obligation:${obligationEntry.id} -->`;
        textToAppend = `${text}\n${marker}`;
      }

      // Solo story_so_far (live) viene aggiornato. story_so_far_at_turn_start
      // resta CONGELATO fino al prossimo group_advance_turn.
      // MOD v5.1: separatore "\n\n" tra contributi di writer diversi
      // per consentire al client di isolare l'ultimo contributo.
      const _prevSSF = (roomState.story_so_far || "").trim();
      const _nextSSF = textToAppend.trim();
      roomState.story_so_far = _prevSSF ? `${_prevSSF}\n\n${_nextSSF}` : _nextSSF;
      bump(roomState);
      await saveRoom(targetRoom, roomState);

      group.submitted_this_turn.push(writerId);
      bump(group);
      await saveGroup(group);

      return res.json({
        success: true,
        assigned_room: targetRoom,
        assigned_room_title: roomState.activity_title,
        assigned_room_incipit: roomState.incipit || "",
        room_state: roomState,
        group_state: group,
      });
    }

    if (action === "group_end") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (group.status === "ended") {
        return res.json({ success: true, group_state: group, already_ended: true });
      }
      // Soft-end: setta ended, congela timer, MA estende expires_at di 24h.
      // I writer continuano a leggere group_state per almeno 24h.
      group.status = "ended";
      group.turn_paused = false;
      group.turn_ends_at = null;
      group.turn_remaining_ms = null;
      group.submitted_this_turn = [];
      group.expires_at = now() + 24 * 60 * 60 * 1000;
      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const rs = await getRoom(roomName);
        if (!rs) continue;
        rs.turn_ends_at = null;
        rs.turn_paused = false;
        rs.turn_remaining_ms = null;
        rs.expires_at = group.expires_at;
        bump(rs);
        await saveRoom(roomName, rs);
      }
      console.log("[group] end group=%s", groupId);
      return res.json({ success: true, group_state: group });
    }

    if (action === "delete_group") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.json({ success: true });

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;
        roomState.expires_at = now() - 1;
        roomState.turn_paused = true;
        roomState.turn_ends_at = null;
        roomState.turn_remaining_ms = null;
        bump(roomState);
        await saveRoom(roomName, roomState);
      }

      group.expires_at = now() - 1;
      group.turn_paused = true;
      group.turn_ends_at = null;
      group.turn_remaining_ms = null;
      group.status = "ended";
      bump(group);
      await saveGroup(group);
      return res.json({ success: true });
    }

    /* -------------------- EXTRAS -------------------- */
    if (action === "group_request_suggestion") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras || !group.extras.config.enabled || !group.extras.config.suggestions_enabled) {
        return res.status(400).json({ error: "suggestions not enabled" });
      }
      if (!group.writers.includes(writerId)) {
        return res.status(403).json({ error: "writer not in group" });
      }

      const used = group.extras.used_suggestions_by_writer || {};
      if (used[writerId]) {
        return res.status(400).json({
          error: "already used",
          suggestion: used[writerId].text,
          text: used[writerId].text,
        });
      }

      // Filtra il pool escludendo suggerimenti gia' assegnati ad ALTRI writer.
      const assignedTexts = new Set(Object.values(used).map((u) => u.text));
      const available = (group.extras.suggestions_pool || []).filter(
        (p) => !assignedTexts.has(p.text)
      );
      if (available.length === 0) {
        return res.status(400).json({ error: "no suggestions available" });
      }

      const pickedIdx = Math.floor(Math.random() * available.length);
      const picked = available[pickedIdx];

      const entry: SuggestionUse = {
        suggestion_id: picked.id,
        text: picked.text,
        turn: group.turn_number,
        used_at: now(),
      };
      used[writerId] = entry;
      group.extras.used_suggestions_by_writer = used;

      // Traccia nel log per SU
      const roomForWriter = computeAssignments(group)[writerId] || null;
      group.extras.suggestions_log = [
        ...(group.extras.suggestions_log || []),
        {
          turn: group.turn_number,
          writer_id: writerId,
          suggestion_id: picked.id,
          text: picked.text,
          room: roomForWriter,
          ts: now(),
        },
      ];

      // Pausa globale: sposta in avanti la deadline del turno per gruppo + stanze.
      const notifySec = Number(group.extras.config.notify_seconds ?? 10);
      const pauseMs = Math.max(0, notifySec) * 1000;
      const flightUntil = now() + pauseMs;
      group.extras.suggestion_in_flight_until = flightUntil;
      (group.extras.suggestion_in_flight_by_writer as any) = group.extras.suggestion_in_flight_by_writer || {};
      group.extras.suggestion_in_flight_by_writer[writerId] = {
        until: flightUntil,
        turn: group.turn_number,
      };

      if (pauseMs > 0 && typeof group.turn_ends_at === "number") {
        group.turn_ends_at = group.turn_ends_at + pauseMs;
      }

      bump(group);
      await saveGroup(group);

      if (pauseMs > 0) {
        for (const roomName of group.rooms) {
          const rs = await getRoom(roomName);
          if (!rs || typeof rs.turn_ends_at !== "number") continue;
          rs.turn_ends_at = rs.turn_ends_at + pauseMs;
          bump(rs);
          await saveRoom(roomName, rs);
        }
      }

      console.log("[extras] suggestion turn=%d writer=%s id=%s", group.turn_number, writerId, picked.id);
      return res.status(200).json({
        success: true,
        suggestion: picked.text,
        text: picked.text,
        suggestion_id: picked.id,
        suggestion_in_flight_until: flightUntil,
      });
    }

    if (action === "group_get_my_extras") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.writers.includes(writerId)) {
        return res.status(403).json({ error: "writer not in group" });
      }

      if (!group.extras || !group.extras.config.enabled) {
        return res.json({
          success: true, enabled: false,
          suggestions_enabled: false, obligations_enabled: false, qa_enabled: false,
          suggestion_used: null, current_obligation: null,
          qa_inbox: [], qa_outbox: [],
          suggestion_in_flight_until: null, notify_others_until: null, notify_seconds: 0,
          suggestions_remaining: 0, obligations_remaining: 0,
        });
      }

      const usedRaw = group.extras.used_suggestions_by_writer[writerId] || null;
      const suggestion_used = usedRaw
        ? { ...usedRaw, is_current_turn: usedRaw.turn === group.turn_number }
        : null;

      const current_obligation = findCurrentObligationFor(group, writerId);
      const qa_inbox = group.extras.qa_threads.filter((m) => m.to_writer === writerId);
      const qa_outbox = group.extras.qa_threads.filter((m) => m.from_writer === writerId);

      const myFlight = group.extras.suggestion_in_flight_by_writer[writerId] || null;
      const my_in_flight_until =
        myFlight && myFlight.turn === group.turn_number && myFlight.until > now()
          ? myFlight.until
          : null;

      let notify_others_until: number | null = null;
      for (const w of Object.keys(group.extras.suggestion_in_flight_by_writer)) {
        if (w === writerId) continue;
        const f = group.extras.suggestion_in_flight_by_writer[w];
        if (f && f.turn === group.turn_number && f.until > now()) {
          if (notify_others_until == null || f.until > notify_others_until) {
            notify_others_until = f.until;
          }
        }
      }

      return res.json({
        success: true,
        enabled: true,
        suggestions_enabled: group.extras.config.suggestions_enabled,
        obligations_enabled: group.extras.config.obligations_enabled,
        qa_enabled: group.extras.config.qa_enabled,
        notify_seconds: group.extras.config.notify_seconds,
        suggestions_remaining: group.extras.suggestions_pool.length,
        obligations_remaining: group.extras.obligations_pool.length,
        suggestion_used,
        current_obligation,
        qa_inbox,
        qa_outbox,
        suggestion_in_flight_until: my_in_flight_until,
        notify_others_until,
      });
    }

    if (action === "group_send_qa") {
      const groupId = normalizeKey(body.group_id);
      const fromWriter = normalizeKey(body.from_writer);
      const toWriter = normalizeKey(body.to_writer);
      const text = String(body.text || body.message || body.body || "").trim();

      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras || !group.extras.config.enabled || !group.extras.config.qa_enabled) {
        return res.status(409).json({ error: "qa disabled" });
      }
      if (!fromWriter || !toWriter) return res.status(400).json({ error: "missing writer" });
      if (!text) return res.status(400).json({ error: "qa text empty" });
      if (!group.writers.includes(fromWriter)) {
        return res.status(403).json({ error: "from_writer not in group" });
      }
      if (!group.writers.includes(toWriter)) {
        return res.status(403).json({ error: "to_writer not in group" });
      }

      const msg: QaMessage = {
        id: shortId("qa"),
        from_writer: fromWriter,
        to_writer: toWriter,
        body: text,
        reply_to: body.reply_to || null,
        origin_suggestion_id: body.origin_suggestion_id || null,
        created_at: now(),
      };
      group.extras.qa_threads.push(msg);
      bump(group);
      await saveGroup(group);

      console.log("[qa] from=%s to=%s len=%d group=%s", fromWriter, toWriter, text.length, groupId);
      return res.json({ success: true, message: msg });
    }

    if (action === "group_su_extras_view") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      const extras = group.extras;
      if (!extras) {
        return res.json({
          ok: true,
          extras: {
            config: { enabled: false, suggestions_enabled: false, obligations_enabled: false, qa_enabled: false, notify_seconds: 0 },
            obligations_log: [],
            suggestions_log: [],
            used_suggestions_by_writer: {},
            qa_threads: [],
          },
        });
      }

      const payload = {
        config: extras.config,
        obligations_log: extras.obligations_log || [],
        suggestions_log: extras.suggestions_log || [],
        used_suggestions_by_writer: extras.used_suggestions_by_writer || {},
        qa_threads: (extras.qa_threads || []).map((m: any) => ({
          id: m.id,
          from_writer: m.from_writer,
          to_writer: m.to_writer,
          text: m.body ?? m.text ?? "",
          ts: m.created_at ?? m.ts ?? 0,
          turn_number: m.turn_number ?? null,
          room: m.room ?? null,
        })),
      };
      return res.json({ ok: true, extras: payload, success: true });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    return handleServerError(res, err);
  }
}
