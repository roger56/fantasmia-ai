import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

/*
==============================================================================
 Fantasmia — claim-link-one-time.ts
 Validazione One-Time Token con tracciabilità SUPERUSER
==============================================================================

 SCOPO
 Questo endpoint valida un One-Time Token firmato via HMAC e restituisce
 al frontend i dati della sessione NSU remota.

 REGOLA ARCHITETTURALE
 - I One-Time Token possono essere creati solo da un SUPERUSER autenticato.
 - Ogni token contiene il su_name del SUPERUSER che lo ha creato.
 - su_name è incluso nel payload firmato e quindi non può essere alterato
   dal client senza invalidare la firma HMAC.
 - ADMIN non è un creatore valido di One-Time Token.

 DURATA
 - Il default attuale della sessione è 5 ore.
 - Il limite operativo attuale è 1-24 ore.
 - L'invito deve essere attivato entro 12 ore dalla creazione.
 - Dal primo accesso, la sessione dura per il TTL configurato
   (es. 5 ore).
 - La struttura è predisposta per future durate maggiori.

 PAYLOAD FIRMATO ATTESO
   - type: "NSU_ONE_TIME"
   - username: string
   - su_name: string
   - ttl_h: number
   - invite_exp: number
   - permanent: false
   - client_email?: string
   - su_email?: string
   - created_by: "SU"
   - v?: number

 RISPOSTA AL FRONTEND
   - user.username
   - su_name
   - first_login_at
   - expires_at
   - ttl_h
   - permanent
   - client_email
   - su_email
   - created_by: "SU"

 TRACCIABILITÀ
 Il campo su_name mantiene il legame:
     One-Time Token -> NSU -> SUPERUSER

 Questo legame potrà essere usato anche per:
   - instradamento delle storie verso l'archivio del SU corretto;
   - attribuzione dei consumi;
   - futura contabilizzazione dei costi.

 ENV RICHIESTA
   - NSU_ONE_TIME_SECRET
==============================================================================
*/



type ApiOk = {
  ok: true;
  user: { username: string; type: "NSU_ONE_TIME" };
  profileName: string;
  su_name: string;
  access_id: string;
  first_login_at: string;
  expires_at: string | null;
  ttl_h: number;
  permanent: boolean;
  client_email?: string;
  su_email?: string;
  created_by: "SU";
};

type ApiErr = { ok: false; error: string };
type Body = { token?: string };

// CORS allowlist
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  "https://fantasmia-web.vercel.app",
  // Preview Vercel del frontend Fantasmia
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

function isOriginAllowed(origin: string) {
  return allowedOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
}

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "";
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");
    res.setHeader("Vary", "Origin");
    return true;
  }
  if (!origin) return true;
  return false;
}

// base64url -> utf8
function b64urlToString(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

// HMAC SHA256 su JSON payload -> base64url
function sign(payloadJson: string, secret: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadJson)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}



export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const secret = process.env.NSU_ONE_TIME_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: "Missing NSU_ONE_TIME_SECRET" });

  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const token = (body.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

  const parts = token.split(".");
  if (parts.length !== 2) {
    return res.status(400).json({ ok: false, error: "Invalid token format" });
  }

  const payloadB64 = parts[0];
  const sig = parts[1];

  let payloadJson = "";
  try {
    payloadJson = b64urlToString(payloadB64);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token payload" });
  }

  const expectedSig = sign(payloadJson, secret);
  if (sig !== expectedSig) {
    return res.status(401).json({ ok: false, error: "Invalid token signature" });
  }

  let payload: any = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid token JSON" });
  }

  const username = typeof payload?.username === "string" ? payload.username.trim() : "";
  const access_id =
    typeof payload?.access_id === "string"
      ? payload.access_id.trim()
      : "";

  const ttl_h_raw = typeof payload?.ttl_h === "number" ? payload.ttl_h : 5;
  const ttl_h = Math.max(1, Math.min(Math.floor(ttl_h_raw), 24));
  const inviteExp = typeof payload?.invite_exp === "number" ? payload.invite_exp : 0;
  const permanent = payload?.permanent === true;
  const client_email = normalizeOptionalString(payload?.client_email);
  const su_email = normalizeOptionalString(payload?.su_email);

  const su_name =
    typeof payload?.su_name === "string"
      ? payload.su_name.trim().toLowerCase()
      : "";

  const created_by = payload?.created_by === "SU" ? "SU" : "";

  const now = Date.now();

  if (
    payload?.type !== "NSU_ONE_TIME" ||
    !username ||
    !access_id ||
    !su_name ||
    created_by !== "SU"
  ) {
    return res.status(400).json({
      ok: false,
      error: "Token payload not valid",
    });
  }
  const accessRecord = await redis.get<any>(`ot_access:${access_id}`);

  if (!accessRecord) {
    return res.status(401).json({
      ok: false,
      error: "Remote access not found",
    });
  }

  if (accessRecord.revoked === true) {
    return res.status(403).json({
      ok: false,
      error: "Remote access revoked",
    });
  }

  if (
    accessRecord.su_name !== su_name ||
    accessRecord.username !== username
  ) {
    return res.status(401).json({
      ok: false,
      error: "Remote access mismatch",
    });
  }
  // Scadenza invito solo per token non permanenti.
  if (!permanent) {
    if (!inviteExp || now > inviteExp) {
      return res.status(410).json({
        ok: false,
        error: "Invite expired",
      });
    }
  }

  const first = new Date(now);
  const expires = new Date(now + ttl_h * 60 * 60 * 1000);

  return res.status(200).json({
    ok: true,
    user: { username, type: "NSU_ONE_TIME" },
    profileName: username,
    su_name,
    access_id,
    first_login_at: first.toISOString(),
    expires_at: permanent ? null : expires.toISOString(),
    ttl_h,
    permanent,
    client_email,
    su_email,
    created_by: "SU",
  });
}
