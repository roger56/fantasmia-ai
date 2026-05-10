// api/admin/rooms.ts
/*
==================================================
FantasMIA / Fantasmia - API ROOMS / GROUPS
==================================================


  SCOPO DEL MODULO

  Questa API Next/Vercel gestisce:

  1. Stanze singole legacy
  2. Gruppi legacy basati su batch di rooms[]
  3. Gruppi V2 con parallelismo reale tra writers
  4. Rotazione round-robin server-side tra writers e stanze
  5. Submit controllato per evitare doppio invio nello stesso turno
  6. Stato gruppo: waiting | active | paused | ended
  7. CORS per domini ufficiali, fantas-ia.it, Lovable e localhost
  8. FUNZIONI ACCESSORIE COLLABORATIVE (extras):
     - Suggerimenti su richiesta del writer (1 per writer, casuali, non
       ripetibili nel gruppo).
     - Obblighi narrativi assegnati automaticamente dal sistema (max 1 per
       turno, salta il primo turno, max 1 per writer, non ripetibili).
     - Mini Q&A privata writer ↔ writer.
     - Log persistente per la verifica manuale finale del SU.

  --------------------------------------------------
  CHANGELOG (rispetto alla versione precedente)
  --------------------------------------------------

  - FIX `extras disabled for this group`: `create_group` ora accetta sia il
    formato CLIENT corrente (`{enabled, suggestions_enabled, suggestions_pool,
    obligations_enabled, obligations_pool, qa_enabled, notify_seconds?}`) sia
    il formato legacy (`{suggestions, obligations, notify_seconds}`).
    Gli extras vengono materializzati in `group.extras` se almeno una delle
    feature è attiva. Il vecchio bug per cui il client inviava i pool ma
    `group.extras` restava `null` è risolto.

  - FIX titolo gruppo "grp-xxx": `create_group` ora accetta sia
    `activity_title` (vecchio) sia `title` (nuovo client).

  - FIX titoli stanze + incipit persi: `create_group` ora accetta
    `rooms_meta: [{title, incipit}]` oltre a `room_titles: string[]`.
    L'incipit viene salvato sul `RoomState.incipit` (nuovo campo opzionale)
    e ritornato dal server.

  - `get_my_assignment` ora ritorna anche `assigned_room_incipit` per
    permettere al client di mostrare l'incipit nel box "storia in corso".

  - `group_state` espone `extras_public.enabled` per il client.

  - `group_get_my_extras` espone `obligations_remaining` e
    `suggestions_remaining`.

  - Q&A: filtro `qa_enabled` rispettato lato server (se disabilitato:
    409 "qa disabled").

  --------------------------------------------------
  MODELLO GRUPPI V2
  --------------------------------------------------

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

  --------------------------------------------------
  EXTRAS (SUGGERIMENTI & OBBLIGHI)
  --------------------------------------------------

  Stato `extras` (campo opzionale del GroupState):
    - config: { enabled, suggestions_enabled, obligations_enabled,
                qa_enabled, notify_seconds }
    - suggestions_pool: testi (string) ancora estraibili (server pop random)
    - obligations_pool: testi (string) ancora estraibili
    - used_suggestions_by_writer: writer -> {id, text, turn, used_at}
    - obligations_log: lista {turn, writer_id, obligation_id, text,
                              assigned_at}
    - qa_threads: messaggi 1-a-1 tra writer
    - suggestion_in_flight_until: timestamp per notifica passiva agli altri

  Gli ID di suggerimenti e obblighi sono autogenerati lato server (s1, s2,
  ..., o1, o2, ...) per disaccoppiarli dai testi forniti dal SU.

  Regole obblighi:
    - Mai assegnati al turno 1.
    - Da turno 2: 1 writer per turno, scelto random tra chi non ha ancora
      ricevuto un obbligo.
    - Quantità totale (NO):
        NT > NW    -> NO = NW
        NT = NW    -> NO = NW - 1
      (almeno un turno resta libero)

  Regole suggerimenti:
    - Pool iniziale = NW elementi pescati random dalla lista config
      (oppure tutta la lista se inferiore).
    - Estrazione random a richiesta writer; rimosso dal pool.
    - 1 sola richiesta per writer per l'intera durata del gruppo.

  --------------------------------------------------
  REDIS / UPSTASH
  --------------------------------------------------

  - Redis viene letto tramite Redis.fromEnv().
  - Variabili Vercel richieste:
      UPSTASH_REDIS_REST_URL
      UPSTASH_REDIS_REST_TOKEN
  - Questo file evita polling lato server: risponde solo alle chiamate
    ricevute. La riduzione vera dei consumi Redis va completata anche lato
    client (polling >= 5-10s, stop quando tab nascosta, no chiamate per
    render React).
  - Alcune azioni come list_rooms/list_groups fanno più letture Redis;
    usarle con moderazione lato UI.

  --------------------------------------------------
  SICUREZZA
  --------------------------------------------------

  - Le azioni amministrative richiedono Bearer token ADMIN.
  - Le action extras writer-side (group_request_suggestion,
    group_get_my_extras, group_send_qa) sono pubbliche ma vincolate al
    fatto che il writer_id sia presente nel gruppo. Nessun PII oltre il
    writer_id.
  - Nessun log di token o credenziali.

CHANGELOG (questa versione)
- A1: Suggerimento mostrato al writer corretto.
      * Nuovo campo per-writer `suggestion_in_flight_by_writer` in extras.
      * `group_request_suggestion` lo valorizza solo per il writer richiedente
        e include `requested_by` nella risposta.
      * `group_get_my_extras` ritorna `suggestion_in_flight_until` SOLO se
        riferito al writer chiamante (turno corrente). Aggiunge
        `notify_others_until` (max scadenza degli altri writer) per la
        notifica passiva.
      * `extras_public` in `group_state` non espone più il flight cross-writer.
      * `suggestion_used` viene marcato `is_current_turn`.
- A2: `group_send_qa` accetta `text` | `message` | `body` (alias) e ritorna
      400 con error `"qa text empty"` se vuoto. Validazione su
      from_writer/to_writer non vuoti.
- A3: log diagnostici minimali (no PII, no token):
      [extras] suggestion writer=… turn=… id=…
      [extras] obligation turn=… writer=… id=…
      [qa] from=… to=… len=… group=…
      [group] advance_turn group=… turn=… → next=…
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
  if (!origin) return { ok: true, origin: "" };
  if (!isOriginAllowed(origin)) return { ok: false, origin };
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
  incipit?: string;
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

/* ---- EXTRAS TYPES ---- */
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
  qa_threads: QaMessage[];
  /** @deprecated mantenuto per retrocompat. Usare suggestion_in_flight_by_writer. */
  suggestion_in_flight_until: number | null;
  /** A1: per-writer flight notice. */
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

/*
==================================================
ADMIN VERIFY
==================================================
*/
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
    incipit: typeof state.incipit === "string" ? state.incipit : "",
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

/*
==================================================
REDIS HELPERS - GROUPS
==================================================
*/
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
      out[k] = {
        until: Number(v.until),
        turn: Number(v.turn || 0),
      };
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

/*
==================================================
GROUP ASSIGNMENTS (round-robin)
==================================================
*/
function computeAssignments(group: GroupState): Record<string, string | null> {
  const assignments: Record<string, string | null> = {};
  for (const writer of group.writers) assignments[writer] = null;

  if (group.turn_number <= 0 || group.rooms.length === 0) return assignments;

  const N = group.rooms.length;
  for (let wi = 0; wi < group.writers.length; wi++) {
    const writer = group.writers[wi];
    const roomIndex = (wi + group.turn_number - 1) % N;
    assignments[writer] = group.rooms[roomIndex] || null;
  }
  return assignments;
}

function computeAssignmentDetails(group: GroupState): AssignmentDetail[] {
  const details: AssignmentDetail[] = [];
  const N = group.rooms.length;
  for (let wi = 0; wi < group.writers.length; wi++) {
    const writer = group.writers[wi];
    if (group.turn_number <= 0 || N === 0) {
      details.push({ writer_id: writer, writer_index: wi, room: null, room_index: null });
      continue;
    }
    const roomIndex = (wi + group.turn_number - 1) % N;
    details.push({
      writer_id: writer,
      writer_index: wi,
      room: group.rooms[roomIndex] || null,
      room_index: roomIndex,
    });
  }
  return details;
}

function findAssignedWriterForRoom(group: GroupState, roomName: string): string | null {
  const N = group.rooms.length;
  if (group.turn_number <= 0 || N === 0) return null;
  const roomIndex = group.rooms.indexOf(roomName);
  if (roomIndex < 0) return null;
  for (let wi = 0; wi < group.writers.length; wi++) {
    if ((wi + group.turn_number - 1) % N === roomIndex) {
      return group.writers[wi];
    }
  }
  return null;
}

/*
==================================================
EXTRAS HELPERS
==================================================
*/
function parseExtrasConfigFromBody(
  ec: any,
  expectedWriters: number,
  totalTurns: number
): ExtrasState | null {
  if (!ec || typeof ec !== "object") return null;

  // Formato CLIENT corrente:
  // { enabled, suggestions_enabled, suggestions_pool, obligations_enabled,
  //   obligations_pool, qa_enabled, notify_seconds? }
  // Formato LEGACY:
  // { suggestions: string[], obligations: string[], notify_seconds? }
  const masterEnabled = ec.enabled !== false;

  const suggestionsRaw = Array.isArray(ec.suggestions_pool)
    ? ec.suggestions_pool
    : Array.isArray(ec.suggestions)
    ? ec.suggestions
    : [];
  const obligationsRaw = Array.isArray(ec.obligations_pool)
    ? ec.obligations_pool
    : Array.isArray(ec.obligations)
    ? ec.obligations
    : [];

  const suggestionsEnabledRequested =
    ec.suggestions_enabled !== undefined ? !!ec.suggestions_enabled : suggestionsRaw.length > 0;
  const obligationsEnabledRequested =
    ec.obligations_enabled !== undefined ? !!ec.obligations_enabled : obligationsRaw.length > 0;
  const qaEnabledRequested = !!ec.qa_enabled;

  const suggestionsEnabled = suggestionsEnabledRequested && suggestionsRaw.length > 0;
  const obligationsEnabled = obligationsEnabledRequested && obligationsRaw.length > 0;

  if (!masterEnabled) return null;
  if (!suggestionsEnabled && !obligationsEnabled && !qaEnabledRequested) return null;

  // Suggerimenti: pool iniziale = NW pescati random (o tutta la lista se < NW)
  const fullSuggestions = normalizePoolArray(suggestionsRaw, "s");
  const suggestionsPool = suggestionsEnabled
    ? shuffled(fullSuggestions).slice(0, Math.min(expectedWriters, fullSuggestions.length))
    : [];

  // Obblighi: NO = NW se NT > NW, altrimenti NW - 1
  const fullObligations = normalizePoolArray(obligationsRaw, "o");
  let NO = 0;
  if (obligationsEnabled) {
    NO = totalTurns > expectedWriters ? expectedWriters : Math.max(0, expectedWriters - 1);
    NO = Math.min(NO, fullObligations.length);
  }
  const obligationsPool = obligationsEnabled ? shuffled(fullObligations).slice(0, NO) : [];

  const config: ExtrasConfig = {
    enabled: true,
    suggestions_enabled: suggestionsEnabled,
    obligations_enabled: obligationsEnabled,
    qa_enabled: qaEnabledRequested,
    notify_seconds: clampNumber(ec.notify_seconds, 10, 3, 60),
  };

  return {
    config,
    suggestions_pool: suggestionsPool,
    obligations_pool: obligationsPool,
    used_suggestions_by_writer: {},
    obligations_log: [],
    qa_threads: [],
    suggestion_in_flight_until: null,
    suggestion_in_flight_by_writer: {},
  };
}

/**
 * Assegna un obbligo per il turno corrente:
 *  - mai al turno 1
 *  - max 1 per turno
 *  - max 1 per writer
 *  - estrae dal pool e lo rimuove
 * Mutates `group.extras`.
 */
function maybeAssignObligationForTurn(group: GroupState): ObligationLogEntry | null {
  if (!group.extras) return null;
  if (!group.extras.config.enabled || !group.extras.config.obligations_enabled) return null;
  if (group.turn_number <= 1) return null;
  if (!group.extras.obligations_pool.length) return null;

  // 1 per turno
  if (group.extras.obligations_log.some((e) => e.turn === group.turn_number)) return null;

  const alreadyAssigned = new Set(group.extras.obligations_log.map((e) => e.writer_id));
  const eligible = group.writers.filter((w) => !alreadyAssigned.has(w));
  if (!eligible.length) return null;

  const writer = pickRandom(eligible);
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

  console.log(
    "[extras] obligation turn=%d writer=%s id=%s",
    entry.turn,
    entry.writer_id,
    entry.obligation_id
  );

  return entry;
}

function findCurrentObligationFor(group: GroupState, writerId: string): ObligationLogEntry | null {
  if (!group.extras) return null;
  return (
    group.extras.obligations_log.find(
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
    return res.status(cors.ok ? 204 : 403).end();
  }
  if (!cors.ok) {
    return res.status(403).json({ error: "origin not allowed" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body: any = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  const action = String(body.action || "").trim();
  const isAdmin = verifyAdmin(req);

  try {
    /*
    ==================================================
    ROOM LEGACY
    ==================================================
    */
    if (action === "create_room") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const room = normalizeKey(body.room);
      if (!room) return res.status(400).json({ error: "missing room" });

      const existing = await getRoom(room);
      if (existing) return res.status(409).json({ error: "room already exists" });

      const ttlHours = clampNumber(body.ttl_h, 12, 1, 24);
      const state: RoomState = {
        room_name: room,
        activity_title: String(body.activity_title || room).trim() || room,
        room_mode: normalizeRoomMode(body.room_mode),
        prompt_seed: String(body.prompt_seed || "").trim(),
        incipit: String(body.incipit || "").trim(),
        story_so_far: "",
        writers: [],
        current_writer_index: 0,
        turn_ends_at: null,
        turn_paused: false,
        turn_remaining_ms: null,
        version: 1,
        updated_at: now(),
        expires_at: now() + ttlHours * 3600 * 1000,
        group_id: null,
        room_index: null,
      };

      await saveRoom(room, state);
      return res.json({ success: true, room });
    }

    if (action === "join") {
      const room = normalizeKey(body.room);
      const state = await getRoom(room);
      if (!state) return res.status(404).json({ error: "room not found" });

      const writerId = normalizeKey(body.writer_id) || `Writer ${state.writers.length + 1}`;
      if (!state.writers.includes(writerId)) {
        state.writers.push(writerId);
        bump(state);
        await saveRoom(room, state);
      }
      return res.json({ success: true, writer_id: writerId, room_state: state });
    }

    if (action === "list_rooms") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const ids = (await redis.smembers<string[]>(KEY_ROOMS_SET)) || [];
      const rooms: RoomSummary[] = [];
      for (const id of ids) {
        const r = await getRoom(id, true);
        if (r) rooms.push(toSummary(id, r));
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
      state.current_writer_index =
        (state.current_writer_index + 1) % state.writers.length;
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

    /*
    ==================================================
    GROUP LEGACY (batch su rooms[])
    ==================================================
    */
    if (action === "group_next_turn") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const rooms = parseRoomsArray(body.rooms);
      if (!rooms.length) return res.status(400).json({ error: "missing rooms[]" });

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
          state.current_writer_index =
            (state.current_writer_index + 1) % state.writers.length;
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
      return res.json({ success: results.every((r) => r.ok), results, now: now() });
    }

    /*
    ==================================================
    GROUP V2
    ==================================================
    */
    if (action === "create_group") {
      if (!isAdmin) return res.status(401).json({ error: "admin only" });

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

      const activityTitle =
        String(body.title || body.activity_title || groupId).trim() || groupId;

      const roomMode = normalizeRoomMode(body.room_mode);
      const promptSeed = String(body.prompt_seed || "").trim();

      const roomsMeta: Array<{ title?: string; incipit?: string }> = Array.isArray(
        body.rooms_meta
      )
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

        const roomState: RoomState = {
          room_name: roomName,
          activity_title: roomTitle,
          room_mode: roomMode,
          prompt_seed: promptSeed,
          incipit: roomIncipit,
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
      return res.json({ success: true, group_id: groupId, group_state: groupState });
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

      // A1: extras_public NON espone più suggestion_in_flight_until (era leak cross-writer).
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
        now: now(),
      });
    }

    if (action === "join_group") {
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });
      if (group.writers.length >= group.expected_writers) {
        return res.status(409).json({ error: "group full" });
      }

      const writerId =
        normalizeKey(body.writer_id) || `Writer ${group.writers.length + 1}`;

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
      console.log(
        "[group] advance_turn group=%s turn=%d → next=%d",
        groupId,
        group.turn_number,
        nextTurn
      );

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

      const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
      group.turn_number = nextTurn;
      group.status = "active";
      group.turn_paused = false;
      group.turn_remaining_ms = null;
      group.turn_ends_at = now() + turnSeconds * 1000;
      group.submitted_this_turn = [];

      const obligationAssigned = maybeAssignObligationForTurn(group);

      bump(group);
      await saveGroup(group);

      const assignments = computeAssignments(group);
      for (const roomName of group.rooms) {
        const roomState = await getRoom(roomName);
        if (!roomState) continue;
        const assignedWriter = findAssignedWriterForRoom(group, roomName);
        if (assignedWriter) {
          const writerIndex = roomState.writers.indexOf(assignedWriter);
          if (writerIndex >= 0) roomState.current_writer_index = writerIndex;
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
      if (!isAdmin) return res.status(401).json({ error: "admin only" });
      const groupId = normalizeKey(body.group_id);
      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });

      let turnSeconds = 180;
      if (group.turn_ends_at && !group.turn_paused) {
        const remaining = Math.max(0, group.turn_ends_at - now());
        if (remaining > 0) turnSeconds = Math.max(15, Math.round(remaining / 1000));
      }
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

      // EXTRAS: marker invisibile per tracciare l'obbligo (filtrato dal client).
      let textToAppend = text;
      const obligationEntry = findCurrentObligationFor(group, writerId);
      if (obligationEntry) {
        const marker = `<!--OBLIGATION:${obligationEntry.obligation_id}-->`;
        textToAppend = `${text}\n${marker}`;
      }

      roomState.story_so_far =
        (roomState.story_so_far ? `${roomState.story_so_far}\n` : "") + textToAppend;
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

    /*
    ==================================================
    EXTRAS - SUGGERIMENTI / OBBLIGHI / Q&A
    ==================================================
    */

    /**
     * group_request_suggestion
     * body: { group_id, writer_id }
     * A1: scrive flight per-writer; ritorna `requested_by`.
     */
    if (action === "group_request_suggestion") {
      const groupId = normalizeKey(body.group_id);
      const writerId = normalizeKey(body.writer_id);
      const group = await getGroup(groupId);

      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras || !group.extras.config.enabled) {
        return res.status(409).json({ error: "extras disabled for this group" });
      }
      if (!group.extras.config.suggestions_enabled) {
        return res.status(409).json({ error: "suggestions disabled for this group" });
      }
      if (group.status === "ended") return res.status(409).json({ error: "group ended" });
      if (group.status !== "active" || group.turn_number <= 0) {
        return res.status(409).json({ error: "no active turn" });
      }
      if (!group.writers.includes(writerId)) {
        return res.status(403).json({ error: "writer not in group" });
      }
      if (group.extras.used_suggestions_by_writer[writerId]) {
        return res.status(409).json({ error: "suggestion already used by this writer" });
      }
      if (!group.extras.suggestions_pool.length) {
        return res.status(409).json({ error: "no suggestions left" });
      }

      const idx = Math.floor(Math.random() * group.extras.suggestions_pool.length);
      const [picked] = group.extras.suggestions_pool.splice(idx, 1);

      group.extras.used_suggestions_by_writer[writerId] = {
        suggestion_id: picked.id,
        text: picked.text,
        turn: group.turn_number,
        used_at: now(),
      };

      const flightUntil = now() + group.extras.config.notify_seconds * 1000;
      group.extras.suggestion_in_flight_by_writer[writerId] = {
        until: flightUntil,
        turn: group.turn_number,
      };
      // legacy: NON usare più lato client per decidere chi vede cosa.
      group.extras.suggestion_in_flight_until = flightUntil;

      bump(group);
      await saveGroup(group);

      console.log(
        "[extras] suggestion writer=%s turn=%d id=%s",
        writerId,
        group.turn_number,
        picked.id
      );

      return res.json({
        success: true,
        requested_by: writerId,
        suggestion_id: picked.id,
        suggestion_text: picked.text,
        turn: group.turn_number,
        notify_seconds: group.extras.config.notify_seconds,
        suggestion_in_flight_until: flightUntil,
      });
    }

    /**
     * group_get_my_extras
     * body: { group_id, writer_id }
     * A1: suggestion_in_flight_until = solo per il writer chiamante.
     *     notify_others_until = max scadenza degli altri writer (per banner passivo).
     *     suggestion_used.is_current_turn = true se appartiene al turno corrente.
     */
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
          success: true,
          enabled: false,
          suggestions_enabled: false,
          obligations_enabled: false,
          qa_enabled: false,
          suggestion_used: null,
          current_obligation: null,
          qa_inbox: [],
          qa_outbox: [],
          suggestion_in_flight_until: null,
          notify_others_until: null,
          notify_seconds: 0,
          suggestions_remaining: 0,
          obligations_remaining: 0,
        });
      }

      const usedRaw = group.extras.used_suggestions_by_writer[writerId] || null;
      const suggestion_used = usedRaw
        ? { ...usedRaw, is_current_turn: usedRaw.turn === group.turn_number }
        : null;

      const current_obligation = findCurrentObligationFor(group, writerId);
      const qa_inbox = group.extras.qa_threads.filter((m) => m.to_writer === writerId);
      const qa_outbox = group.extras.qa_threads.filter((m) => m.from_writer === writerId);

      // A1: my flight only (filtrato per turno corrente).
      const myFlight = group.extras.suggestion_in_flight_by_writer[writerId] || null;
      const my_in_flight_until =
        myFlight && myFlight.turn === group.turn_number && myFlight.until > now()
          ? myFlight.until
          : null;

      // notify_others = max scadenza degli ALTRI writer per il turno corrente
      let notify_others_until: number | null = null;
      for (const w of Object.keys(group.extras.suggestion_in_flight_by_writer)) {
        if (w === writerId) continue;
        const f = group.extras.suggestion_in_flight_by_writer[w];
        if (!f || f.turn !== group.turn_number) continue;
        if (f.until <= now()) continue;
        if (notify_others_until == null || f.until > notify_others_until) {
          notify_others_until = f.until;
        }
      }

      return res.json({
        success: true,
        enabled: true,
        suggestions_enabled: group.extras.config.suggestions_enabled,
        obligations_enabled: group.extras.config.obligations_enabled,
        qa_enabled: group.extras.config.qa_enabled,
        suggestion_used,
        current_obligation,
        qa_inbox,
        qa_outbox,
        suggestion_in_flight_until: my_in_flight_until,
        notify_others_until,
        notify_seconds: group.extras.config.notify_seconds,
        suggestions_remaining: group.extras.suggestions_pool.length,
        obligations_remaining: group.extras.obligations_pool.length,
      });
    }

    /**
     * group_send_qa
     * body: { group_id, from_writer, to_writer, text|message|body, reply_to?, origin_suggestion_id? }
     * A2: alias text/message/body, validazione chiara, errore "qa text empty".
     */
    if (action === "group_send_qa") {
      const groupId = normalizeKey(body.group_id);
      const fromWriter = normalizeKey(body.from_writer);
      const toWriter = normalizeKey(body.to_writer);

      const text = String(body.text ?? body.message ?? body.body ?? "")
        .trim()
        .slice(0, 500);

      if (!fromWriter) {
        return res.status(400).json({ error: "missing from_writer" });
      }
      if (!toWriter) {
        return res.status(400).json({ error: "missing to_writer" });
      }
      if (!text) {
        return res.status(400).json({
          error: "qa text empty",
          details: "Il messaggio Q&A non può essere vuoto.",
        } satisfies ApiErrorBody);
      }
      if (fromWriter === toWriter) {
        return res.status(400).json({ error: "cannot send to yourself" });
      }

      const group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: "group not found" });
      if (!group.extras || !group.extras.config.enabled) {
        return res.status(409).json({ error: "extras disabled for this group" });
      }
      if (!group.extras.config.qa_enabled) {
        return res.status(409).json({ error: "qa disabled for this group" });
      }
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
        reply_to: body.reply_to ? String(body.reply_to) : null,
        origin_suggestion_id: body.origin_suggestion_id
          ? String(body.origin_suggestion_id)
          : null,
        created_at: now(),
      };
      group.extras.qa_threads.push(msg);

      bump(group);
      await saveGroup(group);

      console.log(
        "[qa] from=%s to=%s len=%d group=%s",
        fromWriter,
        toWriter,
        text.length,
        groupId
      );

      return res.json({ success: true, message: msg });
    }

    /**
     * group_su_extras_view (admin)
     * body: { group_id }
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
