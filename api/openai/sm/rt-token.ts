import Cors from "cors";
import type { NextApiRequest, NextApiResponse } from "next";

const cors = Cors({
  origin: (origin, callback) => {
    const allowed = [".lovableproject.com", ".lovable.app", "fantasmia.it", "localhost"];
    if (!origin || allowed.some(d => origin.includes(d))) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  credentials: true,
  optionsSuccessStatus: 204,
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => (result instanceof Error ? reject(result) : resolve(result)));
  });
}

type Body = { ttl?: number }; // seconds

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing SPEECHMATICS_API_KEY" });

  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Body;
  const ttl = Math.max(30, Math.min(body?.ttl ?? 60, 300)); // demo: 30..300s

  // Speechmatics temporary key endpoint (type=rt)
  const smResp = await fetch("https://mp.speechmatics.com/v1/api_keys?type=rt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ttl }),
  });

  const data = await smResp.json();

  if (!smResp.ok) {
    return res.status(smResp.status).json({ error: "Speechmatics temp-key failed", detail: data });
  }

  // docs: response contains key_value :contentReference[oaicite:4]{index=4}
  const key = data?.key_value;
  if (!key) return res.status(502).json({ error: "No key_value returned", detail: data });

  // Region endpoint list :contentReference[oaicite:5]{index=5}
  const region = (process.env.SPEECHMATICS_REGION || "EU1").toUpperCase();
  const wsHost = region === "US1" ? "us.rt.speechmatics.com" : "eu.rt.speechmatics.com";

  // browser WS format with jwt query param :contentReference[oaicite:6]{index=6}
  return res.status(200).json({
    jwt: key,
    ws_url: `wss://${wsHost}/v2?jwt=${encodeURIComponent(key)}`,
    ttl,
  });
}
