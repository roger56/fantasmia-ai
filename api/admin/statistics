import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

// (CORS: se vuoi puoi copiare applyCors robusto da login.ts.
// Qui metto CORS semplice “riflette origin” uguale alle tue altre admin API.)
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  /^https:\/\/.*\.lovableproject\.com$/,
  /^https:\/\/.*\.lovable\.app$/,
  /^https:\/\/.*\.lovable\.dev$/,
  "https://lovable.app",
  "https://www.lovable.app",
  "https://lovable.dev",
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
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Requested-With, Authorization"
  );
}

const redis = Redis.fromEnv();

type Role = "ADMIN" | "SUPERUSER";

function verifyBearer(req: NextApiRequest): { ok: boolean; role?: Role; su_name?: string } {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return { ok: false };

  const token = auth.slice(7);
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return { ok: false };

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return { ok: false };

  const check = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (check !== s) return { ok: false };

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return { ok: false };
  }

  if (!payload?.role) return { ok: false };
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return { ok: false };

  if (payload.role === "ADMIN") return { ok: true, role: "ADMIN" };
  if (payload.role === "SUPERUSER") return { ok: true, role: "SUPERUSER", su_name: payload.su_name };
  return { ok: false };
}

// Keys
const KEY_NSU = (su: string, nsu: string) => `stats:nsu:${su}:${nsu}`;
const KEY_SU = (su: string) => `stats:su:${su}`;
const KEY_ADMIN = `stats:admin`;

function yyyymmdd(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
const KEY_ACTIVE_SU_DAY = (su: string, day: string) => `stats:active:su:${su}:${day}`;
const KEY_ACTIVE_ADMIN_DAY = (day: string) => `stats:active:admin:${day}`;

const TTL_ACTIVE_DAYS_SECONDS = 40 * 24 * 3600;

const allowedEvents = new Set([
  "story_create",
  "story_open",
  "ai_draw",
  "ai_improve",
  "ai_poetry",
  "ai_video",
  "ai_voice",
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = verifyBearer(req);
  if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

  let body: any = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid json body" });
    }
  }

  const action = String(body?.action || "").trim();
  if (!action) return res.status(400).json({ error: "missing action" });

  // ===========================
  // ACTION: event (log stats)
  // ===========================
  if (action === "event") {
    // SU o ADMIN possono loggare; se SUPERUSER, su_name viene dal token
    const suName = auth.role === "SUPERUSER" ? String(auth.su_name || "") : String(body?.su_name || "");
    const nsuId = String(body?.nsu_id || "").trim();
    const event = String(body?.event || "").trim();
    const storyId = String(body?.story_id || "").trim();
    const mode = String(body?.mode || "").trim();
    const archive = String(body?.archive || "").trim();

    if (!suName) return res.status(400).json({ error: "missing su_name" });
    if (!allowedEvents.has(event)) return res.status(400).json({ error: "invalid event" });

    const t = Date.now();
    const day = yyyymmdd(t);

    // SU aggregate
    await redis.hincrby(KEY_SU(suName), "events_total", 1);
    await redis.hincrby(KEY_SU(suName), event, 1);
    await redis.hset(KEY_SU(suName), { last_active: t });

    // ADMIN aggregate
    await redis.hincrby(KEY_ADMIN, "events_total", 1);
    await redis.hincrby(KEY_ADMIN, event, 1);
    await redis.hset(KEY_ADMIN, { last_active: t });

    // daily active
    await redis.sadd(KEY_ACTIVE_ADMIN_DAY(day), suName);
    await redis.expire(KEY_ACTIVE_ADMIN_DAY(day), TTL_ACTIVE_DAYS_SECONDS);

    // NSU (se presente)
    if (nsuId) {
      await redis.hincrby(KEY_NSU(suName, nsuId), "events_total", 1);
      await redis.hincrby(KEY_NSU(suName, nsuId), event, 1);
      await redis.hset(KEY_NSU(suName, nsuId), { last_active: t });

      await redis.sadd(KEY_ACTIVE_SU_DAY(suName, day), nsuId);
      await redis.expire(KEY_ACTIVE_SU_DAY(suName, day), TTL_ACTIVE_DAYS_SECONDS);
    }

    // opzionali: mode/archive/story_id (solo se vuoi contatori dedicati)
    if (mode) await redis.hincrby(KEY_SU(suName), `mode:${mode}`, 1);
    if (archive) await redis.hincrby(KEY_SU(suName), `archive:${archive}`, 1);
    if (storyId) await redis.hincrby(KEY_SU(suName), `story:${storyId}:${event}`, 1);

    return res.status(200).json({ success: true });
  }

  // ===========================
  // ACTION: get_su (read SU)
  // ===========================
  if (action === "get_su") {
    const suName = auth.role === "SUPERUSER" ? String(auth.su_name || "") : String(body?.su_name || "");
    if (!suName) return res.status(400).json({ error: "missing su_name" });

    const suStats = (await redis.hgetall<Record<string, any>>(KEY_SU(suName))) || {};
    return res.status(200).json({ success: true, su_name: suName, stats: suStats });
  }

  // ===========================
  // ACTION: get_admin (read ADMIN)
  // ===========================
  if (action === "get_admin") {
    if (auth.role !== "ADMIN") return res.status(403).json({ error: "admin only" });
    const adminStats = (await redis.hgetall<Record<string, any>>(KEY_ADMIN)) || {};
    return res.status(200).json({ success: true, stats: adminStats });
  }

  return res.status(400).json({ error: "unknown action" });
}
