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
  "https://fantasmia-web.vercel.app",

  // Preview/alias Vercel del frontend Fantasmia.
  // Vercel può usare sia alias che iniziano con "fantasmia-web-" sia URL
  // deployment del tipo "fantasmia-<hash>-rogers-projects-68a7bd87.vercel.app".
  /^https:\/\/fantasmia-web-.*\.vercel\.app$/,
  /^https:\/\/fantasmia-[a-z0-9-]+-rogers-projects-68a7bd87\.vercel\.app$/,

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
