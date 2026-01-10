// File: /pages/api/admin/login.ts
import Cors from "cors";
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";

type Body = { password?: string };

const allowedOrigins = [
  "https://fantasmia.it",
  "http://localhost:5173",
  "http://localhost:3000",
];

function isAllowedOrigin(origin?: string) {
  if (!origin) return true; // richieste server-to-server o tool
  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith(".lovable.app")) return true;
  if (origin.endsWith(".lovableproject.com")) return true;
  // fallback (se Lovable usa domini diversi, aggiungili qui)
  return false;
}

const cors = Cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin ?? undefined)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "X-Requested-With"],
  credentials: true,
  optionsSuccessStatus: 204,
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise<void>((resolve, reject) => {
    fn(req, res, (result: any) => (result instanceof Error ? reject(result) : resolve()));
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1) CORS middleware (setta anche Access-Control-Allow-Origin)
  await runMiddleware(req, res, cors);

  // 2) IMPORTANTISSIMO per cookies cross-origin:
  // Next/cors potrebbe mettere ACAO correttamente, ma qui lo rendiamo esplicito e sicuro.
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin ?? undefined) && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With");

  // 3) Preflight
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // 4) Body parsing (string o object)
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const password = body?.password?.trim();
  if (!password) return res.status(400).json({ error: "Missing password" });

  // 5) DEMO: password server-side (env var), non salvata nel browser
  const expected = (process.env.ADMIN_PASSWORD_PLAIN || "Roger-1").trim();
  if (password !== expected) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // 6) Cookie httpOnly di sessione
  // Nota: se Fantasmia frontend e API sono su domini diversi (lovableproject.com vs vercel.app),
  // serve SameSite=None; Secure per far viaggiare il cookie cross-site.
  // In produzione su HTTPS: Secure=true obbligatorio per SameSite=None.
  const isProd = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_session", "ok", {
      httpOnly: true,
      secure: isProd, // in prod deve essere true (HTTPS)
      sameSite: "none", // ✅ necessario per cookie cross-site con credentials:"include"
      path: "/",
      maxAge: 60 * 60, // 1h
    })
  );

  return res.status(200).json({ success: true });
}
