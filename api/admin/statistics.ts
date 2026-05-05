// api/admin/statistics.ts
/*
  ==================================================
  FantasMIA / Fantasmia - API STATISTICS
  ==================================================

  SCOPO DEL MODULO

  Questa API Next/Vercel registra e legge statistiche di utilizzo
  della webapp Fantasmia.

  Funzioni principali:

  1. registrare eventi applicativi:
     - story_create
     - story_open
     - ai_draw
     - ai_improve
     - ai_poetry
     - ai_video
     - ai_voice

  2. aggiornare statistiche aggregate:
     - per Superuser
     - per Admin globale
     - per NSU, se presente

  3. registrare utenti attivi giornalieri:
     - NSU attivi per SU
     - SU attivi lato Admin

  4. leggere statistiche:
     - get_su
     - get_admin

  NOTE REDIS / UPSTASH

  Questo file usa Redis tramite:

      Redis.fromEnv()

  quindi dipende dalle variabili Vercel:

      UPSTASH_REDIS_REST_URL
      UPSTASH_REDIS_REST_TOKEN

  Dopo cambio database Redis, non serve modificare il codice se le variabili
  Vercel sono state aggiornate correttamente e il progetto è stato redeployato.

  OTTIMIZZAZIONE CONSUMI REDIS

  L'azione "event" usa pipeline per ridurre il numero di round-trip verso Redis.
  I comandi Redis restano comunque conteggiati da Upstash: non chiamare questa API
  a ogni render React o in polling frequente.

  SICUREZZA

  - Tutte le azioni richiedono Bearer JWT valido.
  - ADMIN può leggere statistiche globali.
  - SUPERUSER può leggere/loggare statistiche del proprio su_name.
  - Nessun token o dato sensibile viene loggato.

  CORS

  Domini supportati:

  - https://fantasmia.it
  - https://www.fantasmia.it
  - https://fantas-ia.it
  - https://www.fantas-ia.it
  - domini preview Lovable
  - localhost di sviluppo
*/

export const config = { runtime: "nodejs" };

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

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
  /^https:\/\/.*\.lovable\.dev$/,
  "https://lovable.app",
  "https://www.lovable.app",
  "https://lovable.dev",

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
  REDIS
  ==================================================
*/

const redis = Redis.fromEnv();

/*
  ==================================================
  TYPES
  ==================================================
*/

type Role = "ADMIN" | "SUPERUSER";

type AuthResult =
  | { ok: true; role: Role; su_name?: string }
  | { ok: false };

type ApiErrorBody = {
  error: string;
  details?: string;
};

/*
  ==================================================
  AUTH
  ==================================================
*/

function verifyBearer(req: NextApiRequest): AuthResult {
  const auth = String(req.headers.authorization || "").trim();

  if (!auth.startsWith("Bearer ")) {
    return { ok: false };
  }

  const token = auth.slice(7);
  const [header, payloadEncoded, signature] = token.split(".");

  if (!header || !payloadEncoded || !signature) {
    return { ok: false };
  }

  const secret = process.env.ADMIN_JWT_SECRET;

  if (!secret) {
    return { ok: false };
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payloadEncoded}`)
    .digest("base64url");

  if (expectedSignature !== signature) {
    return { ok: false };
  }

  let payload: any;

  try {
    payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString());
  } catch {
    return { ok: false };
  }

  if (typeof payload?.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return { ok: false };
  }

  if (payload.role === "ADMIN") {
    return { ok: true, role: "ADMIN" };
  }

  if (payload.role === "SUPERUSER") {
    const suName = String(payload.su_name || "").trim();

    if (!suName) {
      return { ok: false };
    }

    return { ok: true, role: "SUPERUSER", su_name: suName };
  }

  return { ok: false };
}

/*
  ==================================================
  KEYS
  ==================================================
*/

const KEY_NSU = (su: string, nsu: string) => `stats:nsu:${su}:${nsu}`;
const KEY_SU = (su: string) => `stats:su:${su}`;
const KEY_ADMIN = "stats:admin";

const KEY_ACTIVE_SU_DAY = (su: string, day: string) => `stats:active:su:${su}:${day}`;
const KEY_ACTIVE_ADMIN_DAY = (day: string) => `stats:active:admin:${day}`;

/*
  ==================================================
  UTILS
  ==================================================
*/

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

function yyyymmdd(timestamp = Date.now()): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${y}${m}${day}`;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    msg.includes("quota") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("limit")
  );
}

function handleServerError(res: NextApiResponse, err: unknown) {
  if (isRedisLimitError(err)) {
    return res.status(429).json({
      error: "Redis usage limit reached",
      details:
        "Il database Redis/Upstash ha raggiunto il limite di utilizzo. Ridurre polling/eventi o usare un database/piano adeguato.",
    } satisfies ApiErrorBody);
  }

  return res.status(500).json({
    error: "server error",
    details: safeMessage(err),
  } satisfies ApiErrorBody);
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

  const auth = verifyBearer(req);

  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body: any = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "invalid json body" });
    }
  }

  const action = normalizeText(body?.action);

  if (!action) {
    return res.status(400).json({ error: "missing action" });
  }

  try {
    /*
      ==================================================
      ACTION: event
      ==================================================

      Registra un evento statistico.

      Nota consumi:
      ogni evento aggiorna più contatori Redis. Non chiamare questa action
      in polling o su ogni render React.
    */
    if (action === "event") {
      const suName =
        auth.role === "SUPERUSER"
          ? String(auth.su_name || "").trim()
          : normalizeText(body?.su_name);

      const nsuId = normalizeText(body?.nsu_id);
      const event = normalizeText(body?.event);
      const storyId = normalizeText(body?.story_id);
      const mode = normalizeText(body?.mode);
      const archive = normalizeText(body?.archive);

      if (!suName) {
        return res.status(400).json({ error: "missing su_name" });
      }

      if (!allowedEvents.has(event)) {
        return res.status(400).json({ error: "invalid event" });
      }

      const timestamp = Date.now();
      const day = yyyymmdd(timestamp);

      const pipeline = redis.pipeline();

      pipeline.hincrby(KEY_SU(suName), "events_total", 1);
      pipeline.hincrby(KEY_SU(suName), event, 1);
      pipeline.hset(KEY_SU(suName), { last_active: timestamp });

      pipeline.hincrby(KEY_ADMIN, "events_total", 1);
      pipeline.hincrby(KEY_ADMIN, event, 1);
      pipeline.hset(KEY_ADMIN, { last_active: timestamp });

      pipeline.sadd(KEY_ACTIVE_ADMIN_DAY(day), suName);
      pipeline.expire(KEY_ACTIVE_ADMIN_DAY(day), TTL_ACTIVE_DAYS_SECONDS);

      if (nsuId) {
        pipeline.hincrby(KEY_NSU(suName, nsuId), "events_total", 1);
        pipeline.hincrby(KEY_NSU(suName, nsuId), event, 1);
        pipeline.hset(KEY_NSU(suName, nsuId), { last_active: timestamp });

        pipeline.sadd(KEY_ACTIVE_SU_DAY(suName, day), nsuId);
        pipeline.expire(KEY_ACTIVE_SU_DAY(suName, day), TTL_ACTIVE_DAYS_SECONDS);
      }

      if (mode) {
        pipeline.hincrby(KEY_SU(suName), `mode:${mode}`, 1);
      }

      if (archive) {
        pipeline.hincrby(KEY_SU(suName), `archive:${archive}`, 1);
      }

      if (storyId) {
        pipeline.hincrby(KEY_SU(suName), `story:${storyId}:${event}`, 1);
      }

      await pipeline.exec();

      return res.status(200).json({ success: true });
    }

    /*
      ==================================================
      ACTION: get_su
      ==================================================
    */
    if (action === "get_su") {
      const suName =
        auth.role === "SUPERUSER"
          ? String(auth.su_name || "").trim()
          : normalizeText(body?.su_name);

      if (!suName) {
        return res.status(400).json({ error: "missing su_name" });
      }

      const suStats = (await redis.hgetall<Record<string, any>>(KEY_SU(suName))) || {};

      return res.status(200).json({
        success: true,
        su_name: suName,
        stats: suStats,
      });
    }

    /*
      ==================================================
      ACTION: get_admin
      ==================================================
    */
    if (action === "get_admin") {
      if (auth.role !== "ADMIN") {
        return res.status(403).json({ error: "admin only" });
      }

      const adminStats = (await redis.hgetall<Record<string, any>>(KEY_ADMIN)) || {};

      return res.status(200).json({
        success: true,
        stats: adminStats,
      });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return handleServerError(res, err);
  }
}
