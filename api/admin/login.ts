// api/admin/login.ts
/*
  ==================================================
  FantasMIA / Fantasmia - API ADMIN LOGIN
  ==================================================

  SCOPO DEL MODULO

  Questa API Next/Vercel gestisce:

  1. login ADMIN legacy
  2. creazione e login SUPERUSER
  3. creazione, lista, disabilitazione, reset PIN e login NSU
  4. generazione JWT per ADMIN / SUPERUSER / NSU
  5. salvataggio credenziali e profili su Upstash Redis
  6. gestione CORS per domini ufficiali, Lovable preview e localhost

  NOTE IMPORTANTI

  - Le credenziali non devono essere scritte nel codice.
  - Redis viene letto tramite Redis.fromEnv(), quindi usa:
      UPSTASH_REDIS_REST_URL
      UPSTASH_REDIS_REST_TOKEN

  - La firma JWT usa:
      ADMIN_JWT_SECRET

  - Il dominio ufficiale storico resta:
      fantasmia.it
      www.fantasmia.it

  - Nuovi domini aggiunti:
      fantas-ia.it
      www.fantas-ia.it

  - DEFAULT_HUB_URL è opzionale.
    Se contiene un IP locale tipo 192.168.x.x, ha senso per il client locale,
    ma non è raggiungibile direttamente da Vercel.

  SICUREZZA

  - Password SU/NSU salvate con PBKDF2 SHA-256.
  - Verifica hash con timingSafeEqual.
  - Cookie httpOnly.
  - Nessun log di password, token o chiavi private.
*/

import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

type Role = "ADMIN" | "SUPERUSER" | "NSU";

type ApiOk =
  | {
      success: true;
      token: string;
      role?: Role;
      hub_url?: string;
      su_name?: string;
    }
  | {
      success: true;
      items: any[];
    }
  | {
      success: true;
      su_name: string;
      nsu_id: string;
      display_name?: string;
      token: string;
      role: "NSU";
      hub_url?: string;
    };

type ApiErr = { error: string };

type Body =
  | { password?: string; action?: undefined }
  | { action: "su_create"; su_name?: string; su_password?: string; hub_url?: string }
  | { action: "su_login"; su_name?: string; su_password?: string }
  | { action: "nsu_create"; nsu_id?: string; nsu_pin?: string; display_name?: string; hub_url?: string }
  | { action: "nsu_list" }
  | { action: "nsu_disable"; nsu_id?: string; enabled?: boolean }
  | { action: "nsu_reset_pin"; nsu_id?: string; nsu_pin?: string }
  | { action: "nsu_login"; su_name?: string; nsu_id?: string; nsu_pin?: string };

/*
  ==================================================
  CORS
  ==================================================

  Con credenziali/cookie non si può usare "*".
  Occorre riflettere solo gli origin autorizzati.

  Nuovi domini aggiunti:
  - https://fantas-ia.it
  - https://www.fantas-ia.it
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
  JWT
  ==================================================
*/

const b64url = (obj: any): string =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

function signJwt(payload: any, jwtSecret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const toSign = `${b64url(header)}.${b64url(payload)}`;

  const signature = crypto
    .createHmac("sha256", jwtSecret)
    .update(toSign)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${toSign}.${signature}`;
}

/*
  ==================================================
  REDIS / UPSTASH
  ==================================================
*/

const redis = Redis.fromEnv();

/*
  ==================================================
  REDIS KEYS
  ==================================================
*/

const KEY_SU = (suName: string) => `auth:su:${suName}`;
const KEY_NSU = (suName: string, nsuId: string) => `auth:nsu:${suName}:${nsuId}`;
const KEY_NSU_LIST = (suName: string) => `auth:nsu_list:${suName}`;

/*
  ==================================================
  NORMALIZZAZIONI INPUT
  ==================================================
*/

function normalizeSuName(value: any): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeNsuId(value: any): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 40);
}

function normalizePin4(value: any): string {
  const pin = String(value || "").trim();
  return /^\d{4}$/.test(pin) ? pin : "";
}

/*
  ==================================================
  PASSWORD HASHING
  ==================================================
*/

function hashPasswordPBKDF2(plain: string, saltHex?: string) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const iterations = 120_000;
  const keylen = 32;
  const digest = "sha256";

  const hash = crypto.pbkdf2Sync(plain, salt, iterations, keylen, digest);

  return {
    scheme: "pbkdf2_sha256",
    iterations,
    salt_hex: salt.toString("hex"),
    hash_hex: hash.toString("hex"),
    keylen,
    digest,
  };
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/*
  ==================================================
  VERIFICA TOKEN ADMIN / SUPERUSER
  ==================================================
*/

function verifyAdminBearer(req: NextApiRequest): boolean {
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

  let payload: any;

  try {
    payload = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString());
  } catch {
    return false;
  }

  if (payload.role !== "ADMIN") {
    return false;
  }

  if (typeof payload.exp !== "number") {
    return false;
  }

  if (payload.exp * 1000 < Date.now()) {
    return false;
  }

  return true;
}

function verifySuBearer(req: NextApiRequest): { ok: boolean; su_name?: string } {
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

  if (payload.role !== "SUPERUSER") {
    return { ok: false };
  }

  if (typeof payload.exp !== "number") {
    return { ok: false };
  }

  if (payload.exp * 1000 < Date.now()) {
    return { ok: false };
  }

  const suName = normalizeSuName(payload.su_name);

  if (!suName) {
    return { ok: false };
  }

  return { ok: true, su_name: suName };
}

/*
  ==================================================
  HUB URL
  ==================================================

  Priorità:
  1. hub_url salvato nel record SU/NSU
  2. DEFAULT_HUB_URL da Vercel env
*/
function resolveHubUrl(record: any): string | undefined {
  return record?.hub_url || process.env.DEFAULT_HUB_URL || undefined;
}

/*
  ==================================================
  HANDLER PRINCIPALE
  ==================================================
*/

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>
) {
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

  let body: Body | any = {};

  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  } catch {
    body = {};
  }

  const isProd = process.env.NODE_ENV === "production";

  /*
    ==================================================
    ACTION: su_create
    Solo ADMIN.
    Crea o aggiorna un Superuser.
    ==================================================
  */
  if (body?.action === "su_create") {
    if (!verifyAdminBearer(req)) {
      return res.status(401).json({ error: "admin only" });
    }

    const suName = normalizeSuName(body.su_name);
    const suPass = String(body.su_password || "").trim();
    const hubUrlInput = String(body.hub_url || "").trim();

    if (!suName) {
      return res.status(400).json({ error: "missing su_name" });
    }

    if (!suPass) {
      return res.status(400).json({ error: "missing su_password" });
    }

    const previous = await redis.get<any>(KEY_SU(suName));
    const passwordRecord = hashPasswordPBKDF2(suPass);
    const hubUrl = hubUrlInput || previous?.hub_url || undefined;

    await redis.set(KEY_SU(suName), {
      su_name: suName,
      ...passwordRecord,
      updated_at: Date.now(),
      ...(hubUrl ? { hub_url: hubUrl } : {}),
    });

    return res.status(200).json({ success: true, token: "", role: "ADMIN" });
  }

  /*
    ==================================================
    ACTION: su_login
    Login Superuser.
    ==================================================
  */
  if (body?.action === "su_login") {
    const suName = normalizeSuName(body.su_name);
    const suPass = String(body.su_password || "").trim();

    if (!suName) {
      return res.status(400).json({ error: "missing su_name" });
    }

    if (!suPass) {
      return res.status(400).json({ error: "missing su_password" });
    }

    const stored = await redis.get<any>(KEY_SU(suName));

    if (!stored?.hash_hex || !stored?.salt_hex) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const check = hashPasswordPBKDF2(suPass, stored.salt_hex);
    const isValid = timingSafeEqualHex(check.hash_hex, stored.hash_hex);

    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const jwtSecret = process.env.ADMIN_JWT_SECRET;

    if (!jwtSecret) {
      return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 60 * 60;

    const token = signJwt(
      {
        role: "SUPERUSER",
        su_name: suName,
        iat: nowSec,
        exp,
      },
      jwtSecret
    );

    res.setHeader(
      "Set-Cookie",
      cookie.serialize("su_jwt", token, {
        httpOnly: true,
        secure: isProd,
        sameSite: "none",
        path: "/",
        maxAge: 60 * 60,
      })
    );

    const hubUrl = resolveHubUrl(stored);

    return res.status(200).json({
      success: true,
      token,
      role: "SUPERUSER",
      su_name: suName,
      ...(hubUrl ? { hub_url: hubUrl } : {}),
    });
  }

  /*
    ==================================================
    ACTION: nsu_create
    Solo SUPERUSER.
    Crea o aggiorna un NSU associato al SU autenticato.
    ==================================================
  */
  if (body?.action === "nsu_create") {
    const suAuth = verifySuBearer(req);

    if (!suAuth.ok || !suAuth.su_name) {
      return res.status(401).json({ error: "superuser only" });
    }

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);
    const displayName = String(body.display_name || "").trim().slice(0, 60);

    if (!nsuId) {
      return res.status(400).json({ error: "missing/invalid nsu_id" });
    }

    if (!pin) {
      return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });
    }

    const suStored = await redis.get<any>(KEY_SU(suName));
    const hubUrlInput = String(body.hub_url || "").trim();
    const hubUrl = hubUrlInput || resolveHubUrl(suStored);

    const passwordRecord = hashPasswordPBKDF2(pin);
    const now = Date.now();

    await redis.set(KEY_NSU(suName, nsuId), {
      su_name: suName,
      nsu_id: nsuId,
      display_name: displayName || nsuId,
      enabled: 1,
      ...passwordRecord,
      created_at: now,
      updated_at: now,
      ...(hubUrl ? { hub_url: hubUrl } : {}),
    });

    await redis.sadd(KEY_NSU_LIST(suName), nsuId);

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  /*
    ==================================================
    ACTION: nsu_list
    Solo SUPERUSER.

    Nota consumi Redis:
    - questa azione legge la lista NSU e poi un record per ogni NSU.
    - Se l'elenco cresce molto, può consumare molte READ.
    - Per ora manteniamo compatibilità con la struttura dati esistente.
    ==================================================
  */
  if (body?.action === "nsu_list") {
    const suAuth = verifySuBearer(req);

    if (!suAuth.ok || !suAuth.su_name) {
      return res.status(401).json({ error: "superuser only" });
    }

    const suName = suAuth.su_name;
    const ids = (await redis.smembers<string[]>(KEY_NSU_LIST(suName))) || [];

    const items: any[] = [];

    for (const id of ids) {
      const rec = await redis.get<any>(KEY_NSU(suName, id));

      if (!rec) {
        continue;
      }

      items.push({
        nsu_id: rec.nsu_id || id,
        display_name: rec.display_name || id,
        enabled: rec.enabled === 1 || rec.enabled === "1" || rec.enabled === true,
        updated_at: rec.updated_at || null,
        created_at: rec.created_at || null,
      });
    }

    items.sort((a, b) => {
      const enabledA = a.enabled ? 1 : 0;
      const enabledB = b.enabled ? 1 : 0;

      if (enabledA !== enabledB) {
        return enabledB - enabledA;
      }

      return String(a.nsu_id).localeCompare(String(b.nsu_id));
    });

    return res.status(200).json({ success: true, items });
  }

  /*
    ==================================================
    ACTION: nsu_disable
    Solo SUPERUSER.
    ==================================================
  */
  if (body?.action === "nsu_disable") {
    const suAuth = verifySuBearer(req);

    if (!suAuth.ok || !suAuth.su_name) {
      return res.status(401).json({ error: "superuser only" });
    }

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);

    if (!nsuId) {
      return res.status(400).json({ error: "missing/invalid nsu_id" });
    }

    const key = KEY_NSU(suName, nsuId);
    const stored = await redis.get<any>(key);

    if (!stored) {
      return res.status(404).json({ error: "nsu not found" });
    }

    await redis.set(key, {
      ...stored,
      enabled: body.enabled === true ? 1 : 0,
      updated_at: Date.now(),
    });

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  /*
    ==================================================
    ACTION: nsu_reset_pin
    Solo SUPERUSER.
    ==================================================
  */
  if (body?.action === "nsu_reset_pin") {
    const suAuth = verifySuBearer(req);

    if (!suAuth.ok || !suAuth.su_name) {
      return res.status(401).json({ error: "superuser only" });
    }

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);

    if (!nsuId) {
      return res.status(400).json({ error: "missing/invalid nsu_id" });
    }

    if (!pin) {
      return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });
    }

    const key = KEY_NSU(suName, nsuId);
    const stored = await redis.get<any>(key);

    if (!stored) {
      return res.status(404).json({ error: "nsu not found" });
    }

    const passwordRecord = hashPasswordPBKDF2(pin);

    await redis.set(key, {
      ...stored,
      ...passwordRecord,
      updated_at: Date.now(),
    });

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  /*
    ==================================================
    ACTION: nsu_login
    Login NSU.
    ==================================================
  */
  if (body?.action === "nsu_login") {
    const suName = normalizeSuName(body.su_name);
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);

    if (!suName) {
      return res.status(400).json({ error: "missing su_name" });
    }

    if (!nsuId) {
      return res.status(400).json({ error: "missing/invalid nsu_id" });
    }

    if (!pin) {
      return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });
    }

    const key = KEY_NSU(suName, nsuId);
    const stored = await redis.get<any>(key);

    if (!stored?.hash_hex || !stored?.salt_hex) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const enabled = stored.enabled === 1 || stored.enabled === "1" || stored.enabled === true;

    if (!enabled) {
      return res.status(403).json({ error: "NSU disabled" });
    }

    const check = hashPasswordPBKDF2(pin, stored.salt_hex);
    const isValid = timingSafeEqualHex(check.hash_hex, stored.hash_hex);

    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const jwtSecret = process.env.ADMIN_JWT_SECRET;

    if (!jwtSecret) {
      return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 60 * 60;

    const token = signJwt(
      {
        role: "NSU",
        su_name: suName,
        nsu_id: nsuId,
        iat: nowSec,
        exp,
      },
      jwtSecret
    );

    res.setHeader(
      "Set-Cookie",
      cookie.serialize("nsu_jwt", token, {
        httpOnly: true,
        secure: isProd,
        sameSite: "none",
        path: "/",
        maxAge: 60 * 60,
      })
    );

    await redis.set(key, {
      ...stored,
      last_login: Date.now(),
    });

    const hubUrl = resolveHubUrl(stored);

    return res.status(200).json({
      success: true,
      su_name: suName,
      nsu_id: nsuId,
      display_name: stored.display_name,
      token,
      role: "NSU",
      ...(hubUrl ? { hub_url: hubUrl } : {}),
    });
  }

  /*
    ==================================================
    LEGACY ADMIN LOGIN
    ==================================================

    Compatibilità con vecchio login ADMIN basato su password.
    Consigliato impostare sempre ADMIN_PASSWORD_PLAIN in Vercel.
  */
  const password = String(body?.password ?? "").trim();

  if (!password) {
    return res.status(400).json({ error: "Missing password" });
  }

  const expected = String(process.env.ADMIN_PASSWORD_PLAIN ?? "Roger-1").trim();

  if (password !== expected) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const jwtSecret = process.env.ADMIN_JWT_SECRET;

  if (!jwtSecret) {
    return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 60 * 60;

  const token = signJwt(
    {
      role: "ADMIN",
      iat: nowSec,
      exp,
    },
    jwtSecret
  );

  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_jwt", token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "none",
      path: "/",
      maxAge: 60 * 60,
    })
  );

  const hubUrl = process.env.DEFAULT_HUB_URL || undefined;

  return res.status(200).json({
    success: true,
    token,
    role: "ADMIN",
    ...(hubUrl ? { hub_url: hubUrl } : {}),
  });
}
