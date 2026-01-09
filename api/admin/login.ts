import Cors from "cors";
import type { NextApiRequest, NextApiResponse } from "next";
import cookie from "cookie";

const cors = Cors({
  origin: (origin, callback) => {
    const allowed = [".lovableproject.com", ".lovable.app", "fantasmia.it", "localhost"];
    if (!origin || allowed.some((d) => origin.includes(d))) callback(null, true);
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

type Body = { password?: string };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Body parsing (string o object)
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
    body = {};
  }

  const password = body?.password;
  if (!password) return res.status(400).json({ error: "Missing password" });

  // DEMO: password in env var (server-side), non salvata nel browser
  const expected = process.env.ADMIN_PASSWORD_PLAIN || "Roger-1";
  // Consiglio: su Vercel setta ADMIN_PASSWORD_PLAIN e NON affidarti al default

  if (password !== expected) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Session cookie httpOnly
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_session", "ok", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60, // 1h
    })
  );

  return res.status(200).json({ success: true });
}
