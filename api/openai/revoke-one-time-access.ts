/*
==================================================
FantasMIA / Fantasmia - REVOKE ONE-TIME ACCESS
Revoca / riabilitazione accesso remoto NSU
==================================================

SCOPO
Questo endpoint consente a un SUPERUSER autenticato di revocare
o riabilitare un accesso remoto creato tramite One-Time Link.

AUTORIZZAZIONE
- Solo un SUPERUSER autenticato tramite JWT può usare l'endpoint.
- Il su_name viene ricavato dal JWT verificato.
- Il SUPERUSER può modificare solo accessi appartenenti al proprio
  su_name.

ARCHITETTURA
Ogni accesso remoto è identificato da:

  access_id

Su Redis viene mantenuta la chiave:

  ot_access:<access_id>

con i dati minimi necessari alla gestione dell'autorizzazione.

La revoca NON modifica il token firmato e NON richiede di salvare
il token completo su Redis.

EFFETTO
- revoked = true  -> il claim viene rifiutato;
- revoked = false -> il claim torna consentito, purché il token
                     non sia scaduto.

NOTA
Questo endpoint gestisce lo stato centralizzato dell'accesso remoto.
L'anagrafica NSU resta invece nell'IndexedDB del SUPERUSER.
==================================================
*/

import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

type ApiOk = {
  ok: true;
  access_id: string;
  revoked: boolean;
};

type ApiErr = {
  ok: false;
  error: string;
};

type Body = {
  access_id?: string;
  revoked?: boolean;
};

const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  "https://fantas-ia.it",
  "https://www.fantas-ia.it",
  "https://fantasmia-web.vercel.app",
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
  return allowedOrigins.some((o) =>
    typeof o === "string" ? o === origin : o.test(origin)
  );
}

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "";

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, X-Requested-With, Authorization"
    );
    res.setHeader("Vary", "Origin");
    return true;
  }

  if (!origin) return true;

  return false;
}

function b64urlToBuf(s: string) {
  const b64 =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((s.length + 3) % 4);

  return Buffer.from(b64, "base64");
}

function b64url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);

  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHS256(data: string, secret: string) {
  return b64url(
    crypto
      .createHmac("sha256", secret)
      .update(data)
      .digest()
  );
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);

  if (ab.length !== bb.length) return false;

  return crypto.timingSafeEqual(ab, bb);
}

function verifySuBearer(
  req: NextApiRequest
): { ok: true; su_name: string } | { ok: false; error: string } {
  const secret = process.env.ADMIN_JWT_SECRET;

  if (!secret) {
    return {
      ok: false,
      error: "Missing ADMIN_JWT_SECRET",
    };
  }

  const auth = String(req.headers.authorization || "").trim();

  if (!auth.toLowerCase().startsWith("bearer ")) {
    return {
      ok: false,
      error: "Missing Superuser Bearer token",
    };
  }

  const token = auth.slice(7).trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    return {
      ok: false,
      error: "Invalid token format",
    };
  }

  const [hB64, pB64, sig] = parts;
  const expectedSig = signHS256(`${hB64}.${pB64}`, secret);

  if (!safeEqual(sig, expectedSig)) {
    return {
      ok: false,
      error: "Invalid token signature",
    };
  }

  let payload: any;

  try {
    payload = JSON.parse(
      b64urlToBuf(pB64).toString("utf8")
    );
  } catch {
    return {
      ok: false,
      error: "Invalid token payload",
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp =
    typeof payload?.exp === "number"
      ? payload.exp
      : 0;

  if (!exp || nowSec >= exp) {
    return {
      ok: false,
      error: "Token expired",
    };
  }

  if (payload?.role !== "SUPERUSER") {
    return {
      ok: false,
      error: "Superuser only",
    };
  }

  const suName =
    typeof payload?.su_name === "string"
      ? payload.su_name.trim().toLowerCase()
      : "";

  if (!suName) {
    return {
      ok: false,
      error: "Missing su_name in Superuser token",
    };
  }

  return {
    ok: true,
    su_name: suName,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>
) {
  const corsOk = setCors(req, res);

  if (req.method === "OPTIONS") {
    if (!corsOk) {
      return res.status(403).json({
        ok: false,
        error: "CORS origin not allowed",
      });
    }

    return res.status(204).end();
  }

  if (!corsOk) {
    return res.status(403).json({
      ok: false,
      error: "CORS origin not allowed",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const suAuth = verifySuBearer(req);

  if (!suAuth.ok) {
    return res.status(401).json({
      ok: false,
      error: suAuth.error,
    });
  }

  let body: Body = {};

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body ?? {};
  } catch {
    body = {};
  }

  const accessId =
    typeof body.access_id === "string"
      ? body.access_id.trim()
      : "";

  if (!accessId) {
    return res.status(400).json({
      ok: false,
      error: "Missing access_id",
    });
  }

  if (typeof body.revoked !== "boolean") {
    return res.status(400).json({
      ok: false,
      error: "Missing revoked flag",
    });
  }

  const key = `ot_access:${accessId}`;
  const record = await redis.get<any>(key);

  if (!record) {
    return res.status(404).json({
      ok: false,
      error: "Remote access not found",
    });
  }

  if (record.su_name !== suAuth.su_name) {
    return res.status(403).json({
      ok: false,
      error: "Remote access does not belong to this Superuser",
    });
  }

  await redis.set(key, {
    ...record,
    revoked: body.revoked,
    updated_at: Date.now(),
  });

  return res.status(200).json({
    ok: true,
    access_id: accessId,
    revoked: body.revoked,
  });
}