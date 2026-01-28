import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";

/*
ROOMS V2 — Classroom reale con round-robin writers
*/

type RoomState = {
  room_name: string;
  activity_title: string;
  room_mode: "CONTINUA_TU" | "CAMPBELL" | "PROPP";
  prompt_seed: string;
  story_so_far: string;

  writers: string[];
  current_writer_index: number;
  turn_ends_at: number | null;

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

  // -------- CREATE --------
  if (action === "create") {
    if (!verifyAdmin(req)) return res.status(401).json({ error: "admin only" });

    const {
      room_name,
      activity_title,
      room_mode = "CONTINUA_TU",
      turn_s = 180,
      ttl_h = 4,
    } = body;

    const room = (room_name && String(room_name).trim()) || randomId();
    const expires_at = now() + Number(ttl_h) * 3600 * 1000;

    // PATCH 1: activity_title never undefined
    const activity_title_safe =
      (activity_title && String(activity_title).trim()) || room;

    rooms.set(room, {
      room_name: room,
      activity_title: activity_title_safe,
      room_mode,
      prompt_seed: "",
      story_so_far: "",
      writers: [],
      current_writer_index: 0,
      turn_ends_at: null,
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
    const { room } = body;
    const key = (room && String(room).trim()) || "";
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

    const { room, turn_s = 180 } = body;
    const key = (room && String(room).trim()) || "";
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    // PATCH 2: handle 0 writers to avoid modulo by 0
    if (!st.writers || st.writers.length === 0) {
      return res.status(409).json({ error: "no writers yet" });
    }

    st.current_writer_index =
      (st.current_writer_index + 1) % st.writers.length;

    st.turn_ends_at = now() + Number(turn_s) * 1000;

    return res.json({ success: true, room_state: st });
  }

  // -------- SUBMIT TEXT (NSU) --------
  if (action === "submit_text") {
    const { room, writer_id, text } = body;
    const key = (room && String(room).trim()) || "";
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    const current = st.writers[st.current_writer_index];
    if (writer_id !== current) {
      return res.status(403).json({ error: "not your turn" });
    }

    st.story_so_far += `\n${String(text || "")}`;
    st.current_writer_index =
      (st.current_writer_index + 1) % st.writers.length;
    st.turn_ends_at = now() + 180 * 1000;

    return res.json({ success: true, room_state: st });
  }

  // -------- GET STATE (polling) --------
  if (action === "get_state") {
    const { room } = body;
    const key = (room && String(room).trim()) || "";
    const st = rooms.get(key);
    if (!st) return res.status(404).json({ error: "room not found" });

    return res.json({ success: true, room_state: st });
  }

  return res.status(400).json({ error: "unknown action" });
}
