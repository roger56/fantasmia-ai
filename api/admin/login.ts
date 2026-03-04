// api/admin/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

type ApiOk =
  | { success: true; token: string; role?: "ADMIN" | "SUPERUSER" | "NSU"; hub_url?: string; su_name?: string }
  | { success: true; items: any[] }
  | { success: true; su_name: string; nsu_id: string; display_name?: string; token: string; role: "NSU"; hub_url?: string };

type ApiErr = { error: string };

type Body =
  | { password?: string; action?: undefined } // legacy ADMIN login
  | { action: "su_create"; su_name?: string; su_password?: string; hub_url?: string } // (optional hub_url)
  | { action: "su_login"; su_name?: string; su_password?: string }
  // ===== NSU =====
  | { action: "nsu_create"; nsu_id?: string; nsu_pin?: string; display_name?: string; hub_url?: string } // (optional hub_url)
  | { action: "nsu_list" }
  | { action: "nsu_disable"; nsu_id?: string; enabled?: boolean }
  | { action: "nsu_reset_pin"; nsu_id?: string; nsu_pin?: string }
  | { action: "nsu_login"; su_name?: string; nsu_id?: string; nsu_pin?: string };

// ✅ Allowed origins (with credentials you can't use "*")
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
  return allowedOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
}

/**
 * Robust CORS:
 * - Always set preflight method/headers
 * - Reflect allowed Origin and enable credentials
 * - If Origin absent (server-to-server), ok
 */
function applyCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = (req.headers.origin || "").trim();

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (origin) {
    if (isOriginAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      return { ok: true, origin };
    }
    return { ok: false, origin };
  }

  return { ok: true, origin: "" };
}

// helper base64url for JSON objects
const b64url = (obj: any) =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

function signJwt(payload: any, jwtSecret: string) {
  const header = { alg: "HS256", typ: "JWT" };
  const toSign = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto
    .createHmac("sha256", jwtSecret)
    .update(toSign)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${toSign}.${sig}`;
}

// ===== Redis (Upstash) =====
const redis = Redis.fromEnv();

// ===== Keys =====
const KEY_SU = (suName: string) => `auth:su:${suName}`;
const KEY_NSU = (suName: string, nsuId: string) => `auth:nsu:${suName}:${nsuId}`;
const KEY_NSU_LIST = (suName: string) => `auth:nsu_list:${suName}`;

// Normalize SU name
function normalizeSuName(x: any) {
  return String(x || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Normalize nsu_id
function normalizeNsuId(x: any) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 40);
}

// PIN 4 digits
function normalizePin4(x: any) {
  const s = String(x || "").trim();
  if (!/^\d{4}$/.test(s)) return "";
  return s;
}

// Password hashing (PBKDF2)
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

function timingSafeEqualHex(aHex: string, bHex: string) {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify ADMIN token (Bearer)
function verifyAdminBearer(req: NextApiRequest): boolean {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;

  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return false;

  const check = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (check !== s) return false;

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return false;
  }

  if (payload.role !== "ADMIN") return false;
  if (typeof payload.exp !== "number") return false;
  if (payload.exp * 1000 < Date.now()) return false;

  return true;
}

// Verify SUPERUSER token and return su_name
function verifySuBearer(req: NextApiRequest): { ok: boolean; su_name?: string } {
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

  if (payload.role !== "SUPERUSER") return { ok: false };
  if (typeof payload.exp !== "number") return { ok: false };
  if (payload.exp * 1000 < Date.now()) return { ok: false };

  const suName = normalizeSuName(payload.su_name);
  if (!suName) return { ok: false };

  return { ok: true, su_name: suName };
}

/**
 * Resolve hub_url for responses.
 * Priority:
 * 1) record.hub_url (per-SU / per-NSU)
 * 2) env DEFAULT_HUB_URL (manual/static)
 */
function resolveHubUrl(record: any): string | undefined {
  return record?.hub_url || process.env.DEFAULT_HUB_URL || undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const cors = applyCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!cors.ok) return res.status(403).json({ error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!cors.ok) return res.status(403).json({ error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Robust body parsing
  let body: Body | any = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Body;
  } catch {
    body = {};
  }

  const isProd = process.env.NODE_ENV === "production";

  // =========================
  // ACTION: su_create (ADMIN)
  // =========================
  if (body?.action === "su_create") {
    if (!verifyAdminBearer(req)) return res.status(401).json({ error: "admin only" });

    const suName = normalizeSuName(body.su_name);
    const suPass = String(body.su_password || "").trim();
    const hub_url_in = String(body.hub_url || "").trim(); // optional

    if (!suName) return res.status(400).json({ error: "missing su_name" });
    if (!suPass) return res.status(400).json({ error: "missing su_password" });

    const rec = hashPasswordPBKDF2(suPass);
    const now = Date.now();

    // If hub_url provided, store it in SU record; else keep previous (if any)
    const prev = await redis.get<any>(KEY_SU(suName));
    const hub_url = hub_url_in || prev?.hub_url || undefined;

    await redis.set(KEY_SU(suName), { su_name: suName, ...rec, updated_at: now, ...(hub_url ? { hub_url } : {}) });

    // Keep legacy response shape (no breaking changes)
    return res.status(200).json({ success: true, token: "", role: "ADMIN" });
  }

  // =========================
  // ACTION: su_login (SU)
  // =========================
  if (body?.action === "su_login") {
    const suName = normalizeSuName(body.su_name);
    const suPass = String(body.su_password || "").trim();

    if (!suName) return res.status(400).json({ error: "missing su_name" });
    if (!suPass) return res.status(400).json({ error: "missing su_password" });

    const stored = await redis.get<any>(KEY_SU(suName));
    if (!stored?.hash_hex || !stored?.salt_hex) return res.status(401).json({ error: "Invalid credentials" });

    const check = hashPasswordPBKDF2(suPass, stored.salt_hex);
    const ok = timingSafeEqualHex(check.hash_hex, stored.hash_hex);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const jwtSecret = process.env.ADMIN_JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 60 * 60; // 1h

    const token = signJwt({ role: "SUPERUSER", su_name: suName, iat: nowSec, exp }, jwtSecret);

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

    const hub_url = resolveHubUrl(stored);

    return res.status(200).json({
      success: true,
      token,
      role: "SUPERUSER",
      su_name: suName,
      ...(hub_url ? { hub_url } : {}),
    });
  }

  // ======================================
  // ACTION: nsu_create (ONLY SUPERUSER)
  // ======================================
  if (body?.action === "nsu_create") {
    const suAuth = verifySuBearer(req);
    if (!suAuth.ok || !suAuth.su_name) return res.status(401).json({ error: "superuser only" });

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);
    const displayName = String(body.display_name || "").trim().slice(0, 60);

    if (!nsuId) return res.status(400).json({ error: "missing/invalid nsu_id" });
    if (!pin) return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });

    // Allow override from request, else inherit from SU record, else env default
    const suStored = await redis.get<any>(KEY_SU(suName));
    const hub_url_in = String(body.hub_url || "").trim(); // optional
    const hub_url = hub_url_in || resolveHubUrl(suStored);

    const now = Date.now();
    const rec = hashPasswordPBKDF2(pin);

    const key = KEY_NSU(suName, nsuId);
    await redis.set(key, {
      su_name: suName,
      nsu_id: nsuId,
      display_name: displayName || nsuId,
      enabled: 1,
      ...rec,
      created_at: now,
      updated_at: now,
      ...(hub_url ? { hub_url } : {}),
    });

    await redis.sadd(KEY_NSU_LIST(suName), nsuId);

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  // ======================================
  // ACTION: nsu_list (ONLY SUPERUSER)
  // ======================================
  if (body?.action === "nsu_list") {
    const suAuth = verifySuBearer(req);
    if (!suAuth.ok || !suAuth.su_name) return res.status(401).json({ error: "superuser only" });

    const suName = suAuth.su_name;
    const ids = (await redis.smembers<string[]>(KEY_NSU_LIST(suName))) || [];

    const items: any[] = [];
    for (const id of ids) {
      const rec = await redis.get<any>(KEY_NSU(suName, id));
      if (!rec) continue;
      items.push({
        nsu_id: rec.nsu_id || id,
        display_name: rec.display_name || id,
        enabled: rec.enabled === 1 || rec.enabled === "1" || rec.enabled === true,
        updated_at: rec.updated_at || null,
        created_at: rec.created_at || null,
      });
    }

    // Sort: enabled desc, then name
    items.sort((a, b) => {
      const ea = a.enabled ? 1 : 0;
      const eb = b.enabled ? 1 : 0;
      if (ea !== eb) return eb - ea;
      return String(a.nsu_id).localeCompare(String(b.nsu_id));
    });

    return res.status(200).json({ success: true, items });
  }

  // ======================================
  // ACTION: nsu_disable (ONLY SUPERUSER)
  // ======================================
  if (body?.action === "nsu_disable") {
    const suAuth = verifySuBearer(req);
    if (!suAuth.ok || !suAuth.su_name) return res.status(401).json({ error: "superuser only" });

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);
    if (!nsuId) return res.status(400).json({ error: "missing/invalid nsu_id" });

    const enabled = body.enabled === true;
    const key = KEY_NSU(suName, nsuId);

    const stored = await redis.get<any>(key);
    if (!stored) return res.status(404).json({ error: "nsu not found" });

    await redis.set(key, { ...stored, enabled: enabled ? 1 : 0, updated_at: Date.now() });

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  // ======================================
  // ACTION: nsu_reset_pin (ONLY SUPERUSER)
  // ======================================
  if (body?.action === "nsu_reset_pin") {
    const suAuth = verifySuBearer(req);
    if (!suAuth.ok || !suAuth.su_name) return res.status(401).json({ error: "superuser only" });

    const suName = suAuth.su_name;
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);

    if (!nsuId) return res.status(400).json({ error: "missing/invalid nsu_id" });
    if (!pin) return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });

    const key = KEY_NSU(suName, nsuId);
    const stored = await redis.get<any>(key);
    if (!stored) return res.status(404).json({ error: "nsu not found" });

    const rec = hashPasswordPBKDF2(pin);
    await redis.set(key, { ...stored, ...rec, updated_at: Date.now() });

    return res.status(200).json({ success: true, token: "", role: "SUPERUSER" });
  }

  // ======================================
  // ACTION: nsu_login (NSU)
  // ======================================
  if (body?.action === "nsu_login") {
    const suName = normalizeSuName(body.su_name);
    const nsuId = normalizeNsuId(body.nsu_id);
    const pin = normalizePin4(body.nsu_pin);

    if (!suName) return res.status(400).json({ error: "missing su_name" });
    if (!nsuId) return res.status(400).json({ error: "missing/invalid nsu_id" });
    if (!pin) return res.status(400).json({ error: "missing/invalid nsu_pin (must be 4 digits)" });

    const stored = await redis.get<any>(KEY_NSU(suName, nsuId));
    if (!stored?.hash_hex || !stored?.salt_hex) return res.status(401).json({ error: "Invalid credentials" });

    const enabled = stored.enabled === 1 || stored.enabled === "1" || stored.enabled === true;
    if (!enabled) return res.status(403).json({ error: "NSU disabled" });

    const check = hashPasswordPBKDF2(pin, stored.salt_hex);
    const ok = timingSafeEqualHex(check.hash_hex, stored.hash_hex);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const jwtSecret = process.env.ADMIN_JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 60 * 60; // 1h

    const token = signJwt({ role: "NSU", su_name: suName, nsu_id: nsuId, iat: nowSec, exp }, jwtSecret);

    // Cookie NSU (optional)
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

    // update last login
    await redis.set(KEY_NSU(suName, nsuId), { ...stored, last_login: Date.now() });

    const hub_url = resolveHubUrl(stored);

    return res.status(200).json({
      success: true,
      su_name: suName,
      nsu_id: nsuId,
      display_name: stored.display_name,
      token,
      role: "NSU",
      ...(hub_url ? { hub_url } : {}),
    });
  }

  // =========================
  // Legacy: ADMIN login (as before)
  // =========================
  const password = String(body?.password ?? "").trim();
  if (!password) return res.status(400).json({ error: "Missing password" });

  const expected = (process.env.ADMIN_PASSWORD_PLAIN ?? "Roger-1").trim();
  if (password !== expected) return res.status(401).json({ error: "Invalid credentials" });

  const jwtSecret = process.env.ADMIN_JWT_SECRET;
  if (!jwtSecret) return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 60 * 60;

  const token = signJwt({ role: "ADMIN", iat: nowSec, exp }, jwtSecret);

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

  // Include DEFAULT_HUB_URL optionally for admin debug (harmless)
  const hub_url = process.env.DEFAULT_HUB_URL || undefined;

  return res.status(200).json({ success: true, token, role: "ADMIN", ...(hub_url ? { hub_url } : {}) });
}
