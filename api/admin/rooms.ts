// api/admin/rooms.ts
/*
  ==================================================
  FantasMIA / Fantasmia - API ROOMS / GROUPS
  ==================================================

  SCOPO DEL MODULO

  Questa API Next/Vercel gestisce:

  1. stanze singole legacy
  2. gruppi legacy basati su batch di rooms[]
  3. gruppi V2 con parallelismo reale tra writers
  4. rotazione round-robin server-side tra writers e stanze
  5. submit controllato per evitare doppio invio nello stesso turno
  6. stato gruppo: waiting | active | paused | ended
  7. CORS per domini ufficiali, nuovo dominio fantas-ia.it, Lovable e localhost
  8. FUNZIONI ACCESSORIE COLLABORATIVE (extras):
       - Suggerimenti su richiesta del writer (1 per writer, casuali, non
         ripetibili nel gruppo).
       - Obblighi narrativi assegnati automaticamente dal sistema (max 1 per
         turno, salta il primo turno, max 1 per writer, non ripetibili).
       - Mini Q&A privata writer ↔ writer per i suggerimenti che richiedono
         una domanda al primo writer / al writer precedente.
       - Log persistente per la verifica manuale finale del SU.

  MODELLO GRUPPI V2

  Regola centrale:

    1 gruppo = N writers = N stanze = N link

  In ogni turno:

    - tutti i writers sono attivi contemporaneamente
    - ogni writer scrive su una stanza diversa
    - ogni stanza ha un solo writer assegnato
    - nessun writer deve restare in attesa se il turno è active

  Rotazione round-robin:

    room_index(writerIndex, turnNumber) =
      (writerIndex + turnNumber - 1) mod N

  EXTRAS (SUGGERIMENTI & OBBLIGHI)

  Lo stato extras è un campo opzionale del GroupState (`extras`) e contiene:
    - config: liste suggerimenti/obblighi attivi e secondi notifica
    - suggestions_pool: id ancora estraibili (server pop random)
    - obligations_pool: id ancora estraibili
    - used_suggestions_by_writer: writer -> {id, turn} (max 1 per writer)
    - obligations_log: lista entry {turn, writer_id, obligation_id, assigned_at}
    - qa_threads: messaggi 1-a-1 tra writer
    - suggestion_in_flight_until: timestamp per notifica passiva agli altri

  Regole obblighi:
    - Mai assegnati al turno 1.
    - Da turno 2 in poi: 1 writer per turno, scelto random tra chi non ha
      ancora ricevuto un obbligo nel gruppo.
    - Quantità totale (NO):
        NT > NW  ->  NO = NW
        NT = NW  ->  NO = NW - 1
      (almeno un turno resta libero)

  Regole suggerimenti:
    - Pool iniziale = NW elementi pescati dalla lista config.
    - Estrazione random a richiesta writer; rimosso dal pool.
    - 1 sola richiesta per writer per l'intera durata del gruppo.

  NOTE REDIS / UPSTASH

  - Redis viene letto tramite Redis.fromEnv().
  - Variabili Vercel richieste:
      UPSTASH_REDIS_REST_URL
      UPSTASH_REDIS_REST_TOKEN

  - Questo file evita polling lato server: risponde solo alle chiamate ricevute.
    La riduzione vera dei consumi Redis va completata anche lato client:
      - polling non sotto 5-10 secondi
      - stop polling quando tab non visibile
      - evitare chiamate a ogni render React

  - Alcune azioni come list_rooms/list_groups fanno più letture Redis.
    Usarle con moderazione lato UI.

  SICUREZZA

  - Le azioni amministrative richiedono Bearer token ADMIN.
  - Le action extras writer-side (group_request_suggestion, group_get_my_extras,
    group_send_qa) sono pubbliche ma vincolate al fatto che il writer_id sia
    presente nel gruppo. Nessun PII oltre il writer_id.
  - Nessun log di token o credenziali.
*/

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

/*
  ==================================================
  CORS
  ==================================================
*/

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

  if (!origin) {
    return { ok: true, origin: "" };
  }

  if (!isOriginAllowed(origin)) {
    return { ok: false, origin };
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");

  return { ok: true, origin };
}

/*
  ==================================================
  TYPES
  ==================================================
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

/*
  ----- EXTRAS TYPES -----
*/

type ExtrasConfig = {
  /** ids dei suggerimenti attivi per il gruppo (lista canonica vive lato client) */
  suggestions: string[];
  /** ids degli obblighi attivi per il gruppo */
  obligations: string[];
  /** secondi di notifica "Suggerimento richiesto" mostrata agli altri writer */
  notify_seconds: number;
};

type SuggestionUse = {
  suggestion_id: string;
  turn: number;
  used_at: number;
};

type ObligationLogEntry = {
  turn: number;
  writer_id: string;
  obligation_id: string;
  assigned_at: number;
};

type QaMessage = {
  id: string;
  from_writer: string;
  to_writer: string;
  body: string;
  /** id del messaggio cui si risponde, opzionale */
  reply_to?: string | null;
  /** suggerimento di origine (per tracciabilità), opzionale */
  origin_suggestion_id?: string | null;
  created_at: number;
};

type ExtrasState = {
  config: ExtrasConfig;
  suggestions_pool: string[];
  obligations_pool: string[];
  used_suggestions_by_writer: Record<string, SuggestionUse>;
  obligations_log: ObligationLogEntry[];
  qa_threads: QaMessage[];
  /** timestamp epoch ms fino al quale gli altri writer mostrano la notifica passiva */
  suggestion_in_flight_until: number | null;
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

  turn_ends_at: number | null;
  turn_paused: boolean;
  turn_remaining_ms: number | null;

  submitted_this_turn: string[];
  status: GroupStatus;

  /** opzionale: presente solo se il gruppo è stato creato con extras_config */
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

type ApiErrorBody = {
  error: string;
  details?: string;
};

/*
  ==================================================
  REDIS / KEYS
  ==================================================
*/

const redis = Redis.fromEnv();

const KEY_ROOM = (room: string) => `rooms:room:${room}`;
const KEY_ROOMS_SET = "rooms:all";

const KEY_GROUP = (groupId: string) => `groups:group:${groupId}`;
const KEY_GROUPS_SET = "groups:all";

/*
  ==================================================
  UTILS
  ==================================================
*/

const now = () => Date.now();

function normalizeKey(value: any): string {
  return value ? String(value).trim() : "";
}

function clampNumber(value: any, fallback: number, min?: number, max?: number): number {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  if (min !== undefined && n < min) {
    return min;
  }

  if (max !== undefined && n > max) {
    return max;
  }

  return n;
}

function normalizeRoomMode(value: any): RoomMode {
  if (value === "CAMPBELL" || value === "PROPP" || value === "CONTINUA_TU") {
    return value;
  }

  return "CONTINUA_TU";
}

function bump(state: RoomState | GroupState) {
  state.version = (state.version || 0) + 1;
  state.updated_at = now();
}

function parseRoomsArray(value: any): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((room) => normalizeKey(room)).filter(Boolean);
}

function safeMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }

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
        "Il database Redis/Upstash ha raggiunto il limite di utilizzo. Ridurre il polling o usare un database/piano adeguato.",
    } satisfies ApiErrorBody);
  }

  return res.status(500).json({
    error: "server error",
    details: safeMessage(err),
  } satisfies ApiErrorBody);
}

/** Fisher-Yates su una copia. */
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

/*
  ==================================================
  ADMIN VERIFY
  ==================================================
*/

function verifyAdmin(req: NextApiRequest): boolean {
  const auth = String(req.headers.authorization || "").trim();

  if (!auth.startsWith("Bearer ")) {
    return false;
  }

  const token = auth.slice(7);
  const [header, payloadEncoded, signature] = token.split(".");

  if (!header || !payloadEncoded || !signature) {
    return false;
  }

  const secret = process.env.ADMIN_JWT_SECRET;

  if (!secret) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payloadEncoded}`)
    .digest("base64url");

  if (expectedSignature !== signature) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString());

    return payload.role === "ADMIN" && typeof payload.exp === "number" && payload.exp * 1000 > now();
  } catch {
    return false;
  }
}

/*
  ==================================================
  REDIS HELPERS - ROOMS
  ==================================================
*/

function normalizeRoomState(room: string, state: RoomState): RoomState {
  return {
    room_name: state.room_name || room,
    activity_title: state.activity_title || state.room_name || room,
    room_mode: normalizeRoomMode(state.room_mode),
    prompt_seed: String(state.prompt_seed || ""),
    story_so_far: String(state.story_so_far || ""),
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

  if (!state) {
    return null;
  }

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

/*
  ==================================================
  REDIS HELPERS - GROUPS
  ==================================================
*/

function normalizeExtrasState(value: any): ExtrasState | null {
  if (!value || typeof value !== "object") return null;
  const cfg = value.config || {};
  return {
    config: {
      suggestions: Array.isArray(cfg.suggestions) ? cfg.suggestions.map(String) : [],
      obligations: Array.isArray(cfg.obligations) ? cfg.obligations.map(String) : [],
      notify_seconds: clampNumber(cfg.notify_seconds, 10, 3, 60),
    },
    suggestions_pool: Array.isArray(value.suggestions_pool) ? value.suggestions_pool.map(String) : [],
    obligations_pool: Array.isArray(value.obligations_pool) ? value.obligations_pool.map(String) : [],
    used_suggestions_by_writer: (value.used_suggestions_by_writer && typeof value.used_suggestions_by_writer === "object")
      ? value.used_suggestions_by_writer
      : {},
    obligations_log: Array.isArray(value.obligations_log) ? value.obligations_log : [],
    qa_threads: Array.isArray(value.qa_threads) ? value.qa_threads : [],
    suggestion_in_flight_until:
      typeof value.suggestion_in_flight_until === "number"
        ? value.suggestion_in_flight_until
        : null,
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
    turn_ends_at: state.turn_ends_at ?? null,
    turn_paused: turnPaused,
    turn_remaining_ms: state.turn_remaining_ms ?? null,
    submitted_this_turn: Array.isArray(state.submitted_this_turn)
      ? state.submitted_this_turn
      : [],
    status,
    extras: normalizeExtrasState((state as any).extras),
    version: Number(state.version || 1),
    created_at: Number(state.created_at || now()),
    updated_at: Number(state.updated_at || now()),
    expires_at: Number(state.expires_at || now() + 3600 * 1000),
  };
}

async function getGroup(groupId: string, cleanupExpired = false): Promise<GroupState | null> {
  if (!groupId) {
    return null;
  }

  const state = await redis.get<GroupState>(KEY_GROUP(groupId));

  if (!state) {
    return null;
  }

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

/*
  ==================================================
  GROUP ASSIGNMENTS
  ==================================================
*/

function computeAssignments(group: GroupState): Record<string, string | null> {
  const assignments: Record<string, string | null> = {};

  for (const writer of group.writers) {
    assignments[writer] = null;
  }

  if (group.turn_number <= 0 || group.rooms.length === 0) {
    return assignments;
  }

  const roomCount = group.rooms.length;

  group.writers.forEach((writer, writerIndex) => {
    const roomIndex = (writerIndex + (group.turn_number - 1)) % roomCount;
    assignments[writer] = group.rooms[roomIndex] || null;
  });

  return assignments;
}

function computeAssignmentDetails(group: GroupState): AssignmentDetail[] {
  const assignments = computeAssignments(group);

  return group.writers.map((writerId, writerIndex) => {
    const room = assignments[writerId] || null;
    const roomIndex = room ? group.rooms.indexOf(room) : -1;

    return {
      writer_id: writerId,
      writer_index: writerIndex,
      room,
      room_index: roomIndex >= 0 ? roomIndex : null,
    };
  });
}

function findAssignedWriterForRoom(group: GroupState, roomName: string): string | null {
  const assignments = computeAssignments(group);

  for (const [writerId, assignedRoom] of Object.entries(assignments)) {
    if (assignedRoom === roomName) {
      return writerId;
    }
  }

  return null;
}

/*
  ==================================================
  EXTRAS HELPERS
  ==================================================
*/

/**
 * Inizializza extras a partire da config + parametri del gruppo.
 *  - suggestions_pool: NW elementi pescati random dalla lista config (oppure tutta la lista se inferiore).
 *  - obligations_pool: NO elementi (NW oppure NW-1) pescati random.
 */
function buildInitialExtras(
  cfg: ExtrasConfig,
  expectedWriters: number,
  totalTurns: number
): ExtrasState {
  const NW = expectedWriters;
  const NS = NW;
  const NO = totalTurns > NW ? NW : Math.max(0, NW - 1);

  const suggestions_pool = shuffled(cfg.suggestions).slice(0, Math.min(NS, cfg.suggestions.length));
  const obligations_pool = shuffled(cfg.obligations).slice(0, Math.min(NO, cfg.obligations.length));

  return {
    config: cfg,
    suggestions_pool,
    obligations_pool,
    used_suggestions_by_writer: {},
    obligations_log: [],
    qa_threads: [],
    suggestion_in_flight_until: null,
  };
}

/**
 * Sceglie un obbligo per il turno corrente:
 *  - mai al turno 1
 *  - max 1 per turno
 *  - max 1 per writer (writer ineleggibili = quelli già in obligations_log)
 *  - estrae dal pool e lo rimuove
 * Mutates `extras`.
 */
function maybeAssignObligationForTurn(group: GroupState): ObligationLogEntry | null {
  const extras = group.extras;
  if (!extras) return null;
  if (group.turn_number <= 1) return null;
  if (!extras.obligations_pool.length) return null;

  const writersWithObligation = new Set(extras.obligations_log.map((e) => e.writer_id));
  const eligibleWriters = group.writers.filter((w) => !writersWithObligation.has(w));
  if (!eligibleWriters.length) return null;

  // Evita di duplicare per lo stesso turno (idempotenza)
  if (extras.obligations_log.some((e) => e.turn === group.turn_number)) return null;

  const writer = pickRandom(eligibleWriters)!;
  // pop random dal pool
  const idx = Math.floor(Math.random() * extras.obligations_pool.length);
  const [obligation_id] = extras.obligations_pool.splice(idx, 1);

  const entry: ObligationLogEntry = {
    turn: group.turn_number,
    writer_id: writer,
    obligation_id,
    assigned_at: now(),
  };
  extras.obligations_log.push(entry);
  return entry;
}

function findCurrentObligationFor(group: GroupState, writerId: string): ObligationLogEntry | null {
  const extras = group.extras;
  if (!extras) return null;
  return (
    extras.obligations_log.find(
      (e) => e.turn === group.turn_number && e.writer_id === writerId
    ) || null
  );
}

/*
  ==================================================
  HANDLER
  ==================================================
*/

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cors = applyCors(req, res);

  if (req.method === "OPTIONS") {
    if (!cors.ok) {
      return res.status(403).json({ error: "CORS origin not allowed" });
    }

    return res.status(204).end();
  }

  if (!cors.ok) {
    return res.status(403).json({ error: "CORS origin not allowed" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body: any = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid json body" });
    }
  }

  const action = body?.action;

  if (!action) {
    return res.status(400).json({ error: "missing action" });
  }

  try {
    const isAdmin = verifyAdmin(req);

    /*
      ==================================================
      SINGLE ROOM LEGACY
      ==================================================
    */

    if (action === "status") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      return res.json({ success: true, now: now() });
    }

    if (action === "list_rooms") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const ids = (await redis.smembers<string[]>(KEY_ROOMS_SET)) || [];
      const rooms: RoomSummary[] = [];

      for (const id of ids) {
        const state = await getRoom(id, true);

        if (state) {
          rooms.push(toSummary(id, state));
        }
      }

      rooms.sort((a, b) => b.updated_at - a.updated_at);

      return res.json({ success: true, rooms, now: now() });
    }

    if (action === "create") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const room = normalizeKey(body.room_name) || crypto.randomBytes(3).toString("hex");
      const ttlHours = clampNumber(body.ttl_h, 12, 1, 24);
      const currentTime = now();

      const state: RoomState = {
        room_name: room,
        activity_title: String(body.activity_title || room).trim(),
        room_mode: normalizeRoomMode(body.room_mode),
        prompt_seed: "",
        story_so_far: "",
        writers: [],
        current_writer_index: 0,
        turn_ends_at: null,
        turn_paused: false,
        turn_remaining_ms: null,
        version: 1,
        updated_at: currentTime,
        expires_at: currentTime + ttlHours * 3600 * 1000,
        group_id: null,
        room_index: null,
      };

      await saveRoom(room, state);

      return res.json({ success: true, room });
    }

    if (action === "join") {
      const room = normalizeKey(body.room);
      const state = await getRoom(room);

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

      const writer = `Writer ${state.writers.length + 1}`;

      state.writers.push(writer);
      bump(state);

      await saveRoom(room, state);

      return res.json({ success: true, writer_id: writer, room_state: state });
    }

    if (action === "next_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const room = normalizeKey(body.room);
      const state = await getRoom(room);

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

      if (!state.writers.length) {
        return res.status(409).json({ error: "no writers yet" });
      }

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
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const room = normalizeKey(body.room);
      const state = await getRoom(room);

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

      if (state.turn_paused) {
        return res.status(409).json({ error: "already paused" });
      }

      if (state.turn_ends_at == null) {
        return res.status(409).json({ error: "no active turn" });
      }

      const remaining = Math.max(0, state.turn_ends_at - now());

      state.turn_paused = true;
      state.turn_remaining_ms = remaining;
      state.turn_ends_at = null;

      bump(state);
      await saveRoom(room, state);

      return res.json({ success: true, room_state: state });
    }

    if (action === "resume_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const room = normalizeKey(body.room);

      if (!room) {
        return res.status(400).json({ error: "missing room" });
      }

      const state = await getRoom(room);

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

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

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

      if (now() > state.expires_at) {
        return res.status(410).json({ error: "room expired" });
      }

      const writerId = normalizeKey(body.writer_id);

      if (!writerId) {
        return res.status(400).json({ error: "missing writer_id" });
      }

      const writerIndex = state.writers.indexOf(writerId);

      if (writerIndex < 0) {
        return res.status(403).json({ error: "writer not in room" });
      }

      const currentWriter = state.writers[state.current_writer_index];

      if (writerId !== currentWriter) {
        return res.status(403).json({ error: "not your turn" });
      }

      if (state.turn_paused) {
        return res.status(409).json({ error: "turn paused" });
      }

      if (state.turn_ends_at == null) {
        return res.status(409).json({ error: "no active turn" });
      }

      if (state.turn_ends_at <= now()) {
        return res.status(409).json({ error: "turn expired" });
      }

      const text = String(body.text || "").trim();

      if (!text) {
        return res.status(400).json({ error: "empty text" });
      }

      state.story_so_far = (state.story_so_far ? `${state.story_so_far}\n` : "") + text;
      state.turn_ends_at = null;
      state.turn_paused = false;
      state.turn_remaining_ms = null;

      bump(state);
      await saveRoom(room, state);

      return res.json({ success: true, room_state: state });
    }

    if (action === "delete_room") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin required" });
      }

      const room = normalizeKey(body.room);
      const state = await getRoom(room);

      if (!state) {
        return res.json({ success: true });
      }

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

      if (!state) {
        return res.status(404).json({ error: "room not found" });
      }

      return res.json({ success: true, room_state: state });
    }

    /*
      ==================================================
      GROUP LEGACY
      Batch su rooms[].
      ==================================================
    */

    if (action === "group_next_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const rooms = parseRoomsArray(body.rooms);

      if (!rooms.length) {
        return res.status(400).json({ error: "missing rooms[]" });
      }

      const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
      const results: GroupResult[] = [];

      for (const room of rooms) {
        try {
          const state = await getRoom(room);

          if (!state) {
            results.push({ room, ok: false, status: 404, error: "room not found" });
            continue;
          }

          if (!state.writers.length) {
            results.push({ room, ok: false, status: 409, error: "no writers yet" });
            continue;
          }

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

      return res.json({ success: results.every((result) => result.ok), results, now: now() });
    }

    if (action === "group_pause_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const rooms = parseRoomsArray(body.rooms);

      if (!rooms.length) {
        return res.status(400).json({ error: "missing rooms[]" });
      }

      const results: GroupResult[] = [];

      for (const room of rooms) {
        try {
          const state = await getRoom(room);

          if (!state) {
            results.push({ room, ok: false, status: 404, error: "room not found" });
            continue;
          }

          if (state.turn_paused) {
            results.push({ room, ok: false, status: 409, error: "already paused" });
            continue;
          }

          if (state.turn_ends_at == null) {
            results.push({ room, ok: false, status: 409, error: "no active turn" });
            continue;
          }

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

      return res.json({ success: results.every((result) => result.ok), results, now: now() });
    }

    if (action === "group_resume_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const rooms = parseRoomsArray(body.rooms);

      if (!rooms.length) {
        return res.status(400).json({ error: "missing rooms[]" });
      }

      const results: GroupResult[] = [];

      for (const room of rooms) {
        try {
          const state = await getRoom(room);

          if (!state) {
            results.push({ room, ok: false, status: 404, error: "room not found" });
            continue;
          }

          if (!state.turn_paused || state.turn_remaining_ms == null) {
            results.push({ room, ok: false, status: 409, error: "not paused" });
            continue;
          }

          const remaining = Math.max(0, Number(state.turn_remaining_ms) || 0);

          if (remaining <= 0) {
            results.push({ room, ok: false, status: 409, error: "no remaining time" });
            continue;
          }

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

      return res.json({ success: results.every((result) => result.ok), results, now: now() });
    }

    if (action === "group_delete_room") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const rooms = parseRoomsArray(body.rooms);

      if (!rooms.length) {
        return res.status(400).json({ error: "missing rooms[]" });
      }

      const results: GroupResult[] = [];

      for (const room of rooms) {
        try {
          const state = await getRoom(room);

          if (!state) {
            results.push({ room, ok: true, status: 200 });
            continue;
          }

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

      return res.json({ success: results.every((result) => result.ok), results, now: now() });
    }

    /*
      ==================================================
      GROUP V2
      ==================================================
    */

    if (action === "create_group") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const expectedWriters = clampNumber(body.expected_writers, 0, 2, 20);

      if (expectedWriters < 2) {
        return res.status(400).json({ error: "expected_writers must be 2..20" });
      }

      const totalTurns = clampNumber(body.total_turns, 0, 1, 200);

      if (totalTurns < expectedWriters || totalTurns % expectedWriters !== 0) {
        return res.status(400).json({
          error: `total_turns must be a positive multiple of expected_writers (got ${totalTurns}, N=${expectedWriters})`,
        });
      }

      const ttlHours = clampNumber(body.ttl_h, 12, 1, 24);
      const expiresAt = now() + ttlHours * 3600 * 1000;
      const groupId = `grp-${crypto.randomBytes(3).toString("hex")}`;
      const activityTitle = String(body.activity_title || groupId).trim();
      const roomMode = normalizeRoomMode(body.room_mode);
      const promptSeed = String(body.prompt_seed || "").trim();

      /*
        Titoli stanze:
        - Se il client manda room_titles[], li usiamo.
        - Altrimenti manteniamo il comportamento precedente: activity_title #i.
      */
      const inputTitles = Array.isArray(body.room_titles) ? body.room_titles : [];
      const roomNames: string[] = [];

      for (let i = 1; i <= expectedWriters; i++) {
        const roomName = `${groupId}-${i}`;
        const roomTitle = String(inputTitles[i - 1] || `${activityTitle} #${i}`).trim();

        const roomState: RoomState = {
          room_name: roomName,
          activity_title: roomTitle,
          room_mode: roomMode,
          prompt_seed: promptSeed,
          story_so_far: "",
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

      /*
        EXTRAS opzionali. Il client passa:
          extras_config: {
            suggestions: string[],   // ids attivi
            obligations: string[],   // ids attivi
            notify_seconds: number   // 3..60, default 10
          }
        Se assente o liste vuote, gli extras restano `null` (feature spenta).
      */
      let extras: ExtrasState | null = null;
      const ec = body.extras_config;
      if (ec && typeof ec === "object") {
        const cfg: ExtrasConfig = {
          suggestions: Array.isArray(ec.suggestions) ? ec.suggestions.map(String).filter(Boolean) : [],
          obligations: Array.isArray(ec.obligations) ? ec.obligations.map(String).filter(Boolean) : [],
          notify_seconds: clampNumber(ec.notify_seconds, 10, 3, 60),
        };
        if (cfg.suggestions.length || cfg.obligations.length) {
          extras = buildInitialExtras(cfg, expectedWriters, totalTurns);
        }
      }

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

      return res.json({
        success: true,
        group_id: groupId,
        group_state: groupState,
      });
    }

    if (action === "list_groups") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const ids = (await redis.smembers<string[]>(KEY_GROUPS_SET)) || [];
      const groups: GroupState[] = [];

      for (const id of ids) {
        const group = await getGroup(id, true);

        if (group) {
          groups.push(group);
        }
      }

      groups.sort((a, b) => b.updated_at - a.updated_at);

      return res.json({ success: true, groups, now: now() });
    }

    if (action === "group_state") {
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      const assignments = computeAssignments(group);
      const assignment_details = computeAssignmentDetails(group);

      /*
        Per non leakare dati sensibili sugli extras a writer non admin,
        esponiamo qui solo informazioni neutre (flag notifica + counters).
        Il dettaglio per-writer va via `group_get_my_extras`.
        Il dettaglio completo va via `group_su_extras_view` (admin).
      */
      const extras_public = group.extras
        ? {
            notify_seconds: group.extras.config.notify_seconds,
            suggestion_in_flight_until: group.extras.suggestion_in_flight_until,
            suggestions_remaining: group.extras.suggestions_pool.length,
            obligations_remaining: group.extras.obligations_pool.length,
          }
        : null;

      return res.json({
        success: true,
        group_state: group,
        assignments,
        assignment_details,
        extras_public,
        now: now(),
      });
    }

    if (action === "join_group") {
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      if (group.status === "ended") {
        return res.status(409).json({ error: "group ended" });
      }

      if (group.writers.length >= group.expected_writers) {
        return res.status(409).json({ error: "group full" });
      }

      const writerId = normalizeKey(body.writer_id) || `Writer ${group.writers.length + 1}`;

      if (group.writers.includes(writerId)) {
        return res.json({ success: true, writer_id: writerId, group_state: group });
      }

      group.writers.push(writerId);
      bump(group);

      await saveGroup(group);

      /*
        Per compatibilità con UI legacy, ogni stanza contiene l'elenco completo
        dei writers del gruppo. L'assegnazione attiva NON è decisa qui, ma
        da computeAssignments().
      */
      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);

        if (!roomState) {
          continue;
        }

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

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      const writerIndex = group.writers.indexOf(writerId);

      if (writerIndex < 0) {
        return res.status(403).json({ error: "writer not in group" });
      }

      const assignments = computeAssignments(group);
      const assignedRoom = assignments[writerId] || null;
      const assignedRoomState = assignedRoom ? await getRoom(assignedRoom) : null;
      const hasSubmitted = group.submitted_this_turn.includes(writerId);

      /*
        Correzione importante:
        Il writer può scrivere se:
        - gruppo active
        - turno avviato
        - gruppo non in pausa
        - writer non ha già inviato nel turno

        Non blocchiamo qui sul tempo scaduto per evitare il bug "writer in attesa"
        causato da disallineamenti UI/timer. La scadenza reale viene comunque
        verificata in group_submit_text.
      */
      const isMyTurn =
        group.status === "active" &&
        !group.turn_paused &&
        group.turn_number > 0 &&
        !hasSubmitted;

      return res.json({
        success: true,
        assigned_room: assignedRoom,
        assigned_room_title: assignedRoomState?.activity_title || assignedRoom,
        room_state: assignedRoomState || null,
        turn_number: group.turn_number,
        total_turns: group.total_turns,
        turn_ends_at: group.turn_ends_at,
        turn_paused: group.turn_paused,
        turn_remaining_ms: group.turn_remaining_ms,
        status: group.status,
        has_submitted: hasSubmitted,
        is_my_turn: isMyTurn,
        writer_id: writerId,
        group_id: groupId,
      });
    }

    if (action === "group_advance_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

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

          if (!roomState) {
            continue;
          }

          roomState.turn_ends_at = null;
          roomState.turn_paused = false;
          roomState.turn_remaining_ms = null;

          bump(roomState);
          await saveRoom(roomName, roomState);
        }

        return res.json({ success: true, group_state: group, ended: true });
      }

      const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);

      group.turn_number = nextTurn;
      group.status = "active";
      group.turn_paused = false;
      group.turn_remaining_ms = null;
      group.turn_ends_at = now() + turnSeconds * 1000;
      group.submitted_this_turn = [];

      // EXTRAS: assegnazione automatica obbligo per il turno (skip turno 1).
      const obligationAssigned = maybeAssignObligationForTurn(group);

      bump(group);
      await saveGroup(group);

      const assignments = computeAssignments(group);

      /*
        Allineamento stanze:
        - ogni stanza riceve lo stesso timer del gruppo
        - current_writer_index viene impostato sul writer assegnato a quella stanza
      */
      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);

        if (!roomState) {
          continue;
        }

        const assignedWriter = findAssignedWriterForRoom(group, roomName);

        if (assignedWriter) {
          const writerIndex = roomState.writers.indexOf(assignedWriter);

          if (writerIndex >= 0) {
            roomState.current_writer_index = writerIndex;
          }
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
        assignments,
        assignment_details: computeAssignmentDetails(group),
        obligation_assigned: obligationAssigned,
        now: now(),
      });
    }

    if (action === "group_force_next_turn") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      let turnSeconds = 180;

      if (group.turn_ends_at && !group.turn_paused) {
        const remaining = Math.max(0, group.turn_ends_at - now());

        if (remaining > 0) {
          turnSeconds = Math.max(15, Math.round(remaining / 1000));
        }
      }

      body.action = "group_advance_turn";
      body.turn_s = turnSeconds;

      /*
        Manteniamo compatibilità con il comportamento esistente:
        questa funzione richiama lo stesso handler con action modificata.
      */
      return handler(req, res);
    }

    if (action === "group_pause") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      if (group.status === "ended") {
        return res.status(409).json({ error: "group ended" });
      }

      if (group.turn_paused) {
        return res.status(409).json({ error: "already paused" });
      }

      if (group.turn_ends_at == null) {
        return res.status(409).json({ error: "no active turn" });
      }

      const remaining = Math.max(0, group.turn_ends_at - now());

      group.turn_paused = true;
      group.turn_remaining_ms = remaining;
      group.turn_ends_at = null;
      group.status = "paused";

      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);

        if (!roomState) {
          continue;
        }

        roomState.turn_paused = true;
        roomState.turn_remaining_ms = remaining;
        roomState.turn_ends_at = null;

        bump(roomState);
        await saveRoom(roomName, roomState);
      }

      return res.json({ success: true, group_state: group });
    }

    if (action === "group_resume") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      if (group.status === "ended") {
        return res.status(409).json({ error: "group ended" });
      }

      if (!group.turn_paused || group.turn_remaining_ms == null) {
        return res.status(409).json({ error: "not paused" });
      }

      const remaining = Math.max(0, Number(group.turn_remaining_ms) || 0);

      if (remaining <= 0) {
        return res.status(409).json({ error: "no remaining time" });
      }

      group.turn_paused = false;
      group.turn_ends_at = now() + remaining;
      group.turn_remaining_ms = null;
      group.status = "active";

      bump(group);
      await saveGroup(group);

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);

        if (!roomState) {
          continue;
        }

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

      if (!group) {
        return res.status(404).json({ error: "group not found" });
      }

      if (now() > group.expires_at) {
        return res.status(410).json({ error: "group expired" });
      }

      if (group.status === "ended") {
        return res.status(409).json({ error: "group ended" });
      }

      const writerIndex = group.writers.indexOf(writerId);

      if (writerIndex < 0) {
        return res.status(403).json({ error: "writer not in group" });
      }

      if (group.turn_number <= 0) {
        return res.status(409).json({ error: "no active turn" });
      }

      if (group.turn_paused) {
        return res.status(409).json({ error: "turn paused" });
      }

      if (group.status !== "active") {
        return res.status(409).json({ error: "group not active" });
      }

      if (group.turn_ends_at == null) {
        return res.status(409).json({ error: "no active turn" });
      }

      if (group.turn_ends_at <= now()) {
        return res.status(409).json({ error: "turn expired" });
      }

      if (group.submitted_this_turn.includes(writerId)) {
        return res.status(409).json({ error: "already submitted this turn" });
      }

      const text = String(body.text || "").trim();

      if (!text) {
        return res.status(400).json({ error: "empty text" });
      }

      const assignments = computeAssignments(group);
      const targetRoom = assignments[writerId];

      if (!targetRoom) {
        return res.status(409).json({ error: "no room assigned" });
      }

      const roomState = await getRoom(targetRoom);

      if (!roomState) {
        return res.status(404).json({ error: "assigned room not found" });
      }

      /*
        EXTRAS: se questo writer aveva un obbligo nel turno corrente, appendiamo
        un marker invisibile (HTML comment) al testo della storia. Verrà filtrato
        dal client al display ma conservato per la verifica del SU.
      */
      let textToAppend = text;
      const obligationEntry = findCurrentObligationFor(group, writerId);
      if (obligationEntry) {
        const marker = `<!--OBL:id=${obligationEntry.obligation_id};writer=${writerId};turn=${obligationEntry.turn}-->`;
        textToAppend = `${text}\n${marker}`;
      }

      roomState.story_so_far = (roomState.story_so_far ? `${roomState.story_so_far}\n` : "") + textToAppend;

      bump(roomState);
      await saveRoom(targetRoom, roomState);

      group.submitted_this_turn.push(writerId);

      bump(group);
      await saveGroup(group);

      return res.json({
        success: true,
        assigned_room: targetRoom,
        assigned_room_title: roomState.activity_title,
        room_state: roomState,
        group_state: group,
      });
    }

    if (action === "delete_group") {
      if (!isAdmin) {
        return res.status(401).json({ error: "admin only" });
      }

      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);

      if (!group) {
        return res.json({ success: true });
      }

      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);

        if (!roomState) {
          continue;
        }

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

    /*
      ==================================================
      EXTRAS - SUGGERIMENTI / OBBLIGHI / Q&A
      ==================================================
    */

    /**
     * group_request_suggestion
     *  body: { group_id, writer_id }
     *  - 1 sola richiesta per writer per l'intera durata del gruppo.
     *  - Estrae random dal pool e lo rimuove.
     *  - Marca `suggestion_in_flight_until = now + notify_seconds*1000`
     *    per la notifica passiva agli altri writer (visibile via group_state).
     *  - Restituisce SOLO al richiedente l'id estratto.
     */
    if (action === "group_request_suggestion") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);

      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras) return res.status(409).json({ error: "extras disabled for this group" });
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });
      if (!group.writers.includes(writerId)) return res.status(403).json({ error: "writer not in group" });

      if (group.extras.used_suggestions_by_writer[writerId]) {
        return res.status(409).json({ error: "suggestion already used by this writer" });
      }

      if (!group.extras.suggestions_pool.length) {
        return res.status(409).json({ error: "no suggestions left" });
      }

      const idx = Math.floor(Math.random() * group.extras.suggestions_pool.length);
      const [suggestion_id] = group.extras.suggestions_pool.splice(idx, 1);

      group.extras.used_suggestions_by_writer[writerId] = {
        suggestion_id,
        turn: group.turn_number,
        used_at: now(),
      };
      group.extras.suggestion_in_flight_until = now() + group.extras.config.notify_seconds * 1000;

      bump(group);
      await saveGroup(group);

      return res.json({
        success: true,
        suggestion_id,
        turn: group.turn_number,
        notify_seconds: group.extras.config.notify_seconds,
      });
    }

    /**
     * group_get_my_extras
     *  body: { group_id, writer_id }
     *  Restituisce lo stato extras visibile a quel writer:
     *   - suggerimento già usato (id e turno) o null
     *   - obbligo corrente (entry del log per il turno attuale) o null
     *   - inbox/outbox Q&A che lo coinvolgono
     *   - flag notifica passiva
     */
    if (action === "group_get_my_extras") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);

      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.writers.includes(writerId)) return res.status(403).json({ error: "writer not in group" });

      if (!group.extras) {
        return res.json({
          success: true,
          enabled: false,
          suggestion_used: null,
          current_obligation: null,
          qa_inbox: [],
          qa_outbox: [],
          suggestion_in_flight_until: null,
          notify_seconds: 0,
        });
      }

      const suggestion_used = group.extras.used_suggestions_by_writer[writerId] || null;
      const current_obligation = findCurrentObligationFor(group, writerId);
      const qa_inbox = group.extras.qa_threads.filter((m) => m.to_writer === writerId);
      const qa_outbox = group.extras.qa_threads.filter((m) => m.from_writer === writerId);

      return res.json({
        success: true,
        enabled: true,
        suggestion_used,
        current_obligation,
        qa_inbox,
        qa_outbox,
        suggestion_in_flight_until: group.extras.suggestion_in_flight_until,
        notify_seconds: group.extras.config.notify_seconds,
      });
    }

    /**
     * group_send_qa
     *  body: { group_id, from_writer, to_writer, body, reply_to?, origin_suggestion_id? }
     *  Mini Q&A privata 1-a-1 fra writer (suggerimenti A3.6/A3.7).
     *  Vincoli:
     *   - from_writer e to_writer entrambi nel gruppo
     *   - from_writer != to_writer
     *   - body non vuoto (max 500 char)
     */
    if (action === "group_send_qa") {
      const groupId = normalizeKey(body.group_id);
      const fromWriter = normalizeKey(body.from_writer);
      const toWriter = normalizeKey(body.to_writer);
      const text = String(body.body || "").trim().slice(0, 500);

      if (!text) return res.status(400).json({ error: "empty body" });
      if (fromWriter === toWriter) return res.status(400).json({ error: "cannot send to yourself" });

      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras) return res.status(409).json({ error: "extras disabled for this group" });
      if (!group.writers.includes(fromWriter)) return res.status(403).json({ error: "from_writer not in group" });
      if (!group.writers.includes(toWriter)) return res.status(403).json({ error: "to_writer not in group" });

      const msg: QaMessage = {
        id: shortId("qa"),
        from_writer: fromWriter,
        to_writer: toWriter,
        body: text,
        reply_to: body.reply_to ? String(body.reply_to) : null,
        origin_suggestion_id: body.origin_suggestion_id ? String(body.origin_suggestion_id) : null,
        created_at: now(),
      };
      group.extras.qa_threads.push(msg);

      bump(group);
      await saveGroup(group);

      return res.json({ success: true, message: msg });
    }

    /**
     * group_su_extras_view
     *  body: { group_id }   (admin)
     *  Restituisce l'intero blocco extras + lookup obblighi per turno/writer.
     *  Pensato per la verifica manuale finale del SU.
     */
    if (action === "group_su_extras_view") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      return res.json({
        success: true,
        group_id: groupId,
        writers: group.writers,
        turn_number: group.turn_number,
        total_turns: group.total_turns,
        extras: group.extras || null,
      });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return handleServerError(res, err);
  }
}
