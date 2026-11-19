/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE – AI/lib/traceCorrelation.ts – rev 0.9.
 * Contesto server verificato. Nessuna modifica alle route operative.
 * Non utilizzare il token diagnostico per autorizzare la normale operazione AI.
 */
import {openAITrace} from './traceOpenAI.js';
import type {integration} from './traceIntegration.js';
import {allowedMetadata} from './traceCatalog.js';
type Service=Pick<ReturnType<typeof integration>,'context'>;
export async function correlateTrace(service:Service, authorization:unknown, body:unknown){
 const off=()=>openAITrace();
 try {
  if(!body||typeof body!=='object'||Array.isArray(body))return off();
  const id=(body as Record<string,unknown>).trace_request_id;
  if(typeof id!=='string'||!allowedMetadata(id,'trace-pilot-06'))return off();
  if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||authorization.length>8200)return off();
  // Timeout diagnostico indipendente: non annulla l'operazione applicativa.
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const ctx=await Promise.race([service.context(authorization.slice(7)),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),300);})]);
   if(!ctx)return off();
   return openAITrace({...ctx.identity,...ctx.config,request_id:id,build_id:'trace-pilot-06'});
  }finally{if(timer!==undefined)clearTimeout(timer);}
 }catch{return off();}
}
