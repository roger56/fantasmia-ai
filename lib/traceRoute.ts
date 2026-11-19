/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE – AI/lib/traceRoute.ts – rev 0.6.
 * Handler isolato, da collegare a Next/Vercel solo nel ramo di prova.
 * Nessuna modifica alle API operative. */
import type {integration} from './traceIntegration.js';
type Service=ReturnType<typeof integration>&{grant?:(token:string,target:string)=>Promise<unknown>};
type Req={method?:string;headers:Record<string,string|string[]|undefined>;body?:unknown};
type Res={status(n:number):Res;json(v:unknown):void;setHeader(k:string,v:string):void;end():void};
export function makeTraceRoute(service:Service,origins:readonly (string|RegExp)[]){
 return async (req:Req,res:Res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Origin');
  const origin=req.headers.origin;
  if(typeof origin!=='string'||!origins.some(x=>typeof x==='string'?x===origin:x.test(origin)))return res.status(403).json({error:'origin'});
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({error:'method'});
  const auth=req.headers.authorization;if(typeof auth!=='string'||!auth.startsWith('Bearer ')||auth.length>8200)return res.status(401).json({error:'auth'});
  try{const token=auth.slice(7);const b=req.body as Record<string,unknown>|null;
   if(!b||typeof b!=='object'||Array.isArray(b))return res.status(400).json({error:'body'});
   if(b.action==='context'){const c=await service.context(token);return res.status(200).json({config:c?{...c.identity,...c.config,build_id:'trace-pilot-06'}:null});}
   if(b.action==='configure'){if(typeof b.target!=='string'||!(b.level===null||['DEBUG','INFO','WARN','ERROR'].includes(String(b.level))))return res.status(400).json({error:'body'});const ok=await service.configure(token,b.target,b.level as 'DEBUG'|'INFO'|'WARN'|'ERROR'|null);const grant=ok&&b.level!==null&&service.grant?await service.grant(token,b.target):null;return res.status(ok?200:403).json({ok,...(grant?{grant}:{})});}
   if(b.action==='report'&&typeof b.log==='string'&&new TextEncoder().encode(b.log).length<=2000000){const result=await service.submit(token,b.log);return res.status(({sent:200,denied:403,invalid:400,limited:429,failed:503})[result]).json({result});}
   return res.status(400).json({error:'body'});
  }catch{return res.status(503).json({error:'trace_unavailable'});}
 };
}
