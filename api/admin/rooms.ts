import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

/*
ROOMS V2 — Classroom reale con round-robin writers
- CORS per prod + preview Lovable
- JWT admin (Bearer)
- Multi-room in RAM (demo)
- Turni con NEXT / PAUSE / RESUME
- Dashboard support: LIST_ROOMS + STOP_TURN
*/

type RoomState = {
  room_name: string;
  activity_title: string;
  room_mode: "CONTINUA_TU" | "CAMPBELL" | "PROPP";
  prompt_seed: string;
  story_so_far: string;

  writers: string[];
  current_writer_index: number;

  // Turn management
  turn_ends_at: number | null; // timestamp ms quando finisce il turno (se attivo)
  turn_paused: boolean; // true se in pausa
  turn_remaining_ms: number | null; // ms residui salvati al momento della pausa

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

const rooms = new Map<string, RoomState>();

// ---------- Helpers ----------
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

// ---------- API ----------
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  // Parse body (safe)
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

  // -------- STATUS (ADMIN CHECK) --------
  if (action === "status") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });
    return res.json({ success: true, ok: true, now: now() });
  }

  // -------- LIST ROOMS (ADMIN) --------
  if (action === "list_rooms") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    // purge expired rooms
    const t = now();
    for (const [k, st] of rooms.entries()) {
      if (t > st.expires_at) rooms.delete(k);
    }

    const out = Array.from(rooms.entries()).map(([room, room_state]) => ({
      room,
      room_state,
    }));

    // (opzionale) ordinamento: scadenza crescente
    out.sort((a, b) => (a.room_state.expires_at || 0) - (b.room_state.expires_at || 0));

    return res.json({ success: true, rooms: out, now: t });
  }

  // -------- STOP TURN (ADMIN) --------
  if (action === "stop_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    st.turn_ends_at = null;
    st.turn_paused = false;
    st.turn_remaining_ms = null;

    return res.json({ success: true, room_state: st });
  }

  // -------- CREATE --------
  if (action === "create") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const {
      room_name,
      activity_title,
      room_mode = "CONTINUA_TU",
      ttl_h = 4,
    } = body;

    const room = normalizeKey(room_name) || randomId();
    const expires_at = now() + clampNumber(ttl_h, 4, 1, 24) * 3600 * 1000;

    const activity_title_safe = normalizeKey(activity_title) || room;

    rooms.set(room, {
      room_name: room,
      activity_title: activity_title_safe,
      room_mode,
      prompt_seed: "",
      story_so_far: "",
      writers: [],
      current_writer_index: 0,
      turn_ends_at: null,
      turn_paused: false,
      turn_remaining_ms: null,
      expires_at,
    });

    return res.json({
      success: true,
      room,
      expires_at,
    });
  }

  // -------- JOIN (writer enters) --------
  if (action === "join") {
    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (now() > st.expires_at) {
      rooms.delete(key);
      return res.status(410).json({ error: "room expired" });
    }

    const writer_id = `Writer ${st.writers.length + 1}`;
    st.writers.push(writer_id);

    return res.json({
      success: true,
      writer_id,
      writer_index: st.writers.length - 1,
      room_state: st,
    });
  }

  // -------- NEXT TURN (SU) --------
  if (action === "next_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (!st.writers || st.writers.length === 0) {
      return res.status(409).json({ error: "no writers yet" });
    }

    st.current_writer_index =
      (st.current_writer_index + 1) % st.writers.length;

    // reset pause flags and start a new turn
    st.turn_paused = false;
    st.turn_remaining_ms = null;

    const turnSeconds = clampNumber(body.turn_s, 180, 15, 600);
    st.turn_ends_at = now() + turnSeconds * 1000;

    return res.json({ success: true, room_state: st });
  }

  // -------- PAUSE TURN (SU) --------
  if (action === "pause_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (!st.writers || st.writers.length === 0) {
      return res.status(409).json({ error: "no writers yet" });
    }

    if (st.turn_paused) {
      return res.status(409).json({ error: "already paused" });
    }

    if (st.turn_ends_at == null) {
      return res.status(409).json({ error: "no active turn" });
    }

    const remaining = Math.max(0, st.turn_ends_at - now());
    st.turn_paused = true;
    st.turn_remaining_ms = remaining;
    st.turn_ends_at = null;

    return res.json({ success: true, room_state: st });
  }

  // -------- RESUME TURN (SU) --------
  if (action === "resume_turn") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (!st.turn_paused || st.turn_remaining_ms == null) {
      return res.status(409).json({ error: "not paused" });
    }

    const remaining = Math.max(0, st.turn_remaining_ms);
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + remaining;

    return res.json({ success: true, room_state: st });
  }

  // -------- SUBMIT TEXT (NSU) --------
  if (action === "submit_text") {
    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    if (st.turn_paused) {
      return res.status(409).json({ error: "turn paused" });
    }

    const writer_id = normalizeKey(body.writer_id);
    const current = st.writers[st.current_writer_index];
    if (writer_id !== current) {
      return res.status(403).json({ error: "not your turn" });
    }

    st.story_so_far += `\n${String(body.text || "")}`;
    st.current_writer_index =
      (st.current_writer_index + 1) % st.writers.length;

    // after submit, auto-start next writer turn (default 180s)
    st.turn_paused = false;
    st.turn_remaining_ms = null;
    st.turn_ends_at = now() + 180 * 1000;

    return res.json({ success: true, room_state: st });
  }

  // -------- GET STATE (polling) --------
  if (action === "get_state") {
    const key = normalizeKey(body.room);
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    return res.json({ success: true, room_state: st });
  }

  return res.status(400).json({ error: "unknown action" });
}
