/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA-AI/lib/traceEndpoint.ts — 5B-R2 / 2.3.
 * Endpoint diagnostico separato. Disabilitato salvo opt-in esplicito.
 * Non modifica login, archivi o API operative. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Redis } from '@upstash/redis';
import { createTraceServices } from './traceServices.js';
import { makeTraceRoute } from './traceRoute.js';
const origins = ['https://fantasmia.it','https://www.fantasmia.it','https://fantas-ia.it','https://www.fantas-ia.it','https://fantasmia-web.vercel.app',/^https:\/\/fantasmia-web-.*\.vercel\.app$/,/^https:\/\/fantasmia-[a-z0-9-]+-rogers-projects-68a7bd87\.vercel\.app$/,/^https:\/\/.*\.lovableproject\.com$/,/^https:\/\/.*\.lovable\.app$/,'https://lovable.app','https://www.lovable.app','https://lovable.dev',/^https:\/\/.*\.lovable\.dev$/,'http://localhost:5173','http://localhost:3000','http://localhost:8080'];
export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };
export default async function handler(req: NextApiRequest,res: NextApiResponse) {
 res.setHeader('Cache-Control','no-store');
 if(process.env.FANTASMIA_TRACE_ENABLED !== '1') return res.status(404).json({error:'trace_disabled'});
 try {
  const jwtSecret=process.env.ADMIN_JWT_SECRET;
  if(!jwtSecret) return res.status(503).json({error:'trace_unavailable'});
  const redis=Redis.fromEnv();
  const service=createTraceServices(redis,{jwtSecret,oneTimeSecret:process.env.NSU_ONE_TIME_SECRET||'',resendKey:process.env.RESEND_API_KEY||'',from:process.env.TRACE_MAIL_FROM||'Fantasmia <no-reply@fantasmia.it>',adminEmail:process.env.TRACE_ADMIN_EMAIL||''});
  await makeTraceRoute(service,origins)(req,res);
 } catch { if(!res.headersSent) return res.status(503).json({error:'trace_unavailable'}); }
}
