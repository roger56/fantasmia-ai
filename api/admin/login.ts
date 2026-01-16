// api/admin/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";
import crypto from "crypto";

type ApiOk = { success: true; token: string };
type ApiErr = { error: string };

type Body = { password?: string };

// ✅ Lista origin ammessi (IMPORTANTISSIMO: con credentials non puoi usare "*")
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  /^https:\/\/.*\.lovableproject\.com$/, // preview Lovable
  /^https:\/\/.*\.lovable\.app$/,        // preview/hosting lovable
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
  const origin = (req.headers.origin || "").trim();

  if (origin && isOriginAllowed(origin)) {
    // Riflette l'origin reale, non "*"
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    // ✅ aggiunto Authorization (serve a Lovable e ad altre chiamate)
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, X-Requested-With, Authorization"
    );
    // Evita cache “cross-origin” sbagliate
    res.setHeader("Vary", "Origin");
    return true;
  }

  // Se non c'è origin (call server-to-server) puoi permettere
  if (!origin) return true;

  return false;
}

// helper base64url per oggetti JSON
const b64url = (obj: any) =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!corsOk) return res.status(403).json({ error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) return res.status(403).json({ error: "CORS origin not allowed" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Body parsing robusto
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const password = (body.password ?? "").trim();
  if (!password) return res.status(400).json({ error: "Missing password" });

  // Password attesa: preferisci ENV su Vercel
  const expected = (process.env.ADMIN_PASSWORD_PLAIN ?? "Roger-1").trim();
  if (password !== expected) return res.status(401).json({ error: "Invalid credentials" });

  // ✅ Genera JWT per Bearer auth
  const jwtSecret = process.env.ADMIN_JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ error: "Missing ADMIN_JWT_SECRET" });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 60 * 60; // 1 ora

  const header = { alg: "HS256", typ: "JWT" };
  const payload = { role: "ADMIN", iat: nowSec, exp };

  const toSign = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto
    .createHmac("sha256", jwtSecret)
    .update(toSign)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const token = `${toSign}.${sig}`;

  // ✅ Cookie JWT httpOnly (così puoi anche usarlo via cookie se serve)
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_jwt", token, {
      httpOnly: true,
      secure: isProd,     // in prod true
      sameSite: "none",   // come nel tuo allegato; richiede secure=true in prod
      path: "/",
      maxAge: 60 * 60,    // 1h
    })
  );

  // ✅ Risposta richiesta da Lovable
  return res.status(200).json({ success: true, token });
}
