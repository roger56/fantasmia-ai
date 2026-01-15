// api/admin/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";

type ApiOk = { success: true };
type ApiErr = { error: string };

type Body = { password?: string };

// ✅ Lista origin ammessi (IMPORTANTISSIMO: con credentials non puoi usare "*")
const allowedOrigins: Array<string | RegExp> = [
  "https://fantasmia.it",
  "https://www.fantasmia.it",
  /^https:\/\/.*\.lovableproject\.com$/, // preview Lovable
  /^https:\/\/.*\.lovable\.app$/,        // <-- AGGIUNGI (preview/hosting lovable)
  "https://lovable.app",                 // <-- AGGIUNGI
  "https://www.lovable.app",             // <-- AGGIUNGI
  "https://lovable.dev",
  /^https:\/\/.*\.lovable\.dev$/,        // <-- AGGIUNGI (se capita)
  "http://localhost:5173",
  "http://localhost:3000",
];


function isOriginAllowed(origin: string) {
  return allowedOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
}

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "";
  if (origin && isOriginAllowed(origin)) {
    // Riflette l'origin reale, non "*"
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");
    // Evita cache “cross-origin” sbagliate
    res.setHeader("Vary", "Origin");
    return true;
  }

  // Se non c'è origin (call server-to-server) puoi permettere
  // oppure chiudere. Qui permetto solo senza CORS:
  if (!origin) return true;

  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOk | ApiErr>) {
  const corsOk = setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    // Se origin non ammesso: 403
    if (!corsOk) return res.status(403).json({ error: "CORS origin not allowed" });
    return res.status(204).end();
  }

  if (!corsOk) {
    return res.status(403).json({ error: "CORS origin not allowed" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

  if (password !== expected) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Cookie session httpOnly
  const isProd = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_session", "ok", {
      httpOnly: true,
      secure: isProd,     // in prod deve essere true
      sameSite: "none",    // con fetch cross-site spesso "lax" è più tollerante di "strict"
      path: "/",
      maxAge: 60 * 60,    // 1h
    })
  );

  return res.status(200).json({ success: true });
}
