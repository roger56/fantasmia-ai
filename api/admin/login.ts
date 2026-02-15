// api/admin/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

type ApiOk = { success: true; token: string; role?: "ADMIN" | "SUPERUSER" };
type ApiErr = { error: string };

type Body =
  | { password?: string; action?: undefined } // legacy ADMIN login
  | { action: "su_create"; su_name?: string; su_password?: string }
  | { action: "su_login"; su_name?: string; su_password?: string };

// ✅ Lista origin ammessi (IMPORTANTISSIMO: con credentials non puoi usare "*")
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  /^https:\/\/.*\.lovableproject\.com$/, // preview Lovable
  /^https:\/\/.*\.lovable\.app$/, // preview/hosting lovable
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

/**
 * CORS robusto:
 * - Imposta SEMPRE i metodi/header di preflight
 * - Se origin è ammesso, riflette l'origin e abilita credentials
 * - Se origin assente (server-to-server), ok
 */
function applyCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = (req.headers.origin || "").trim();

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Requested-With, Authorization"
  );
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

// helper base64url per oggetti JSON
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
const KEY_SU = (suName: string) => `auth:su:${suName}`;

// Normalizzazione nome SU: coerente e “verificabile”
function normalizeSuName(x: any) {
  return String(x || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Password hashing (PBKDF2) → robusto e semplice
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

// Verifica token ADMIN (stessa logica di rooms)
function verifyAdminBearer(req: NextApiRequest): boolean {
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
  if (payload.exp * 1000 < Date.now()) return false;

  return true;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>
) {
  const cors = applyCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!cors.ok) return res.status(403).json({ error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!cors.ok) return res.status(403).json({ error: "CORS origin not allowed" });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Body parsing robusto
  let body: Body | any = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const isProd = process.env.NODE_ENV === "production";

  // =========================
  // ACTION: su_create (ADMIN)
  // =========================
  if (body?.action === "su_create") {
    // Richiede ADMIN Bearer
    if (!verifyAdminBearer(req)) {
      return res.status(401).json({ error: "admin only" });
    }

    const suName = normalizeSuName(body.su_name);
    const suPass = String(body.su_password || "").trim();

    if (!suName) return res.status(400).json({ error: "missing su_name" });
    if (!suPass) return res.status(400).json({ error: "missing su_password" });

    const rec = hashPasswordPBKDF2(suPass);
    const now = Date.now();

    await redis.set(KEY_SU(suName), {
      su_name: suName,
      ...rec,
      updated_at: now,
    });

    // Per comodità, torniamo success + role
    // (NON restituiamo la password, ovviamente)
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
    if (!stored?.hash_hex || !stored?.salt_hex) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const check = hashPasswordPBKDF2(suPass, stored.salt_hex);
    const ok = timingSafeEqualHex(check.hash_hex, stored.hash_hex);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const jwtSecret = process.env.ADMIN_JWT_SECRET; // riusiamo lo stesso secret per semplicità
    if (!jwtSecret) return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + 60 * 60; // 1h

    const token = signJwt(
      { role: "SUPERUSER", su_name: suName, iat: nowSec, exp },
      jwtSecret
    );

    // Cookie SU (se ti serve lato browser)
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

    return res.status(200).json({ success: true, token, role: "SUPERUSER" });
  }

  // =========================
  // Legacy: ADMIN login (come prima)
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

  return res.status(200).json({ success: true, token, role: "ADMIN" });
}
