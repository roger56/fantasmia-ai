/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — AI/api/openai/sm/rt-token.ts.
 * Solo osservatori di ingresso/errori; argomenti e risultati originali conservati. */
import {tracePoint as __fantasmiaTracePoint,withTrace as __fantasmiaWithTrace,withTraceRequest as __fantasmiaWithTraceRequest} from "../../../lib/traceRuntime.js";
/**
 * Endpoint serverless per generare una chiave temporanea Speechmatics
 * destinata al riconoscimento vocale realtime dal browser.
 *
 * Il frontend non riceve mai la SPEECHMATICS_API_KEY permanente:
 * questa funzione usa la chiave privata lato server per richiedere
 * a Speechmatics una chiave temporanea con durata limitata.
 *
 * Funzioni principali:
 * - gestione CORS per i domini autorizzati Fantasmia;
 * - accettazione delle sole richieste POST/OPTIONS;
 * - lettura di SPEECHMATICS_API_KEY e SPEECHMATICS_REGION;
 * - richiesta di una temporary key Speechmatics realtime;
 * - restituzione al frontend di:
 *   - jwt temporaneo;
 *   - URL WebSocket realtime;
 *   - durata della chiave.
 *
 * Variabili ambiente richieste:
 * - SPEECHMATICS_API_KEY
 * - SPEECHMATICS_REGION (opzionale, default EU1)
 *
 * Endpoint:
 *   POST /api/openai/sm/rt-token
 */
import Cors from "cors";
import type { NextApiRequest, NextApiResponse } from "next";

const cors = Cors({
  origin: (origin, callback) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","origin_L30_C11");

	const allowed = [
	  ".lovableproject.com",
	  ".lovable.app",
	  "fantasmia.it",
	  "fantas-ia.it",
	  "localhost",
	  "fantasmia-web-",
	  "fantasmia-web.vercel.app",
        "fantasmia.it",
        "www.fantasmia.it",
	  "fantasmia-5tcgfmiwp-rogers-projects-68a7bd87.vercel.app",
	];
    if (!origin || allowed.some((d) => (/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","callback_L43_C33"), (origin.includes(d))))) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  credentials: true,
  optionsSuccessStatus: 204,
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","runMiddleware_L52_C1");

  return new Promise<void>((resolve, reject) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","callback_L53_C28");

    fn(req, res, (result: any) => (/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","callback_L54_C18"), ((result instanceof Error ? reject(result) : resolve()))));
  });
}

type Body = { ttl?: number }; // seconds

// Speechmatics response for POST /v1/api_keys?type=rt
type SpeechmaticsTempKeyResponse = {
  key_value?: string | null;
  // Speechmatics may return additional fields; keep it flexible
  [k: string]: unknown;
};

  async function handler(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","handler_L67_C1");

  // CORS
  await runMiddleware(req, res, cors);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only POST
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Env
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing SPEECHMATICS_API_KEY" });

  // Body parsing (Lovable sometimes sends stringified JSON)
  let body: Body = {};
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Body;
  } catch {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","handler_L67_C1",true);

    body = {};
  }

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

  // Parse response robustly
  let data: SpeechmaticsTempKeyResponse | unknown = null;
  try {
    data = (await smResp.json()) as SpeechmaticsTempKeyResponse;
  } catch {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sm/rt-token.ts","handler_L67_C1",true);

    // keep raw fallback; smResp.ok handling below will surface it
    data = { error: "Invalid JSON from Speechmatics" };
  }

  if (!smResp.ok) {
    return res.status(smResp.status).json({ error: "Speechmatics temp-key failed", detail: data });
  }

  const smData = data as SpeechmaticsTempKeyResponse;

  // docs: response contains key_value
  const key = smData?.key_value ?? null;
  if (!key) return res.status(502).json({ error: "No key_value returned", detail: smData });

  // Region endpoint list
  const region = (process.env.SPEECHMATICS_REGION || "EU1").toUpperCase();
  const wsHost = region === "US1" ? "us.rt.speechmatics.com" : "eu.rt.speechmatics.com";

  // browser WS format with jwt query param
  return res.status(200).json({
    jwt: key,
    ws_url: `wss://${wsHost}/v2?jwt=${encodeURIComponent(key)}`,
    ttl,
  });
}

export default __fantasmiaWithTrace("api/openai/sm/rt-token.ts",handler);
