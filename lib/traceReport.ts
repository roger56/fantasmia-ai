/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
import {allowedPoint,allowedMetadata} from './traceCatalog.js';
/** FANTASMIA TRACE – AI/lib/traceReport.ts – rev 0.3.
 *  Servizio isolato: richiede adattatori autenticazione, deduplica e posta reali.
 *  Non espone endpoint e non modifica Redis o autenticazione esistente.
 */
export interface Identity { user_id:string; role:'SU'|'NSU'|'WRITER'|'ADMIN' }
export interface ReportDeps {
  // Deve verificare firma, scadenza, appartenenza e attivazione diagnostica.
  authorize(token:string):Promise<Identity|null>;
  // Destinatario ricavato esclusivamente da configurazione server.
  recipient(identity:Identity):Promise<string|null>;
  // Prenotazione atomica con TTL; false se già presente o limite raggiunto.
  reserve(identity:Identity, fingerprint:string):Promise<boolean>;
  mail(input:{to:string;subject:string;filename:string;content:string}):Promise<void>;
}
const id=(x:unknown):x is string=>typeof x==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(x);
const messages:Record<string,string>={START:'Operazione iniziata',SUCCESS:'Operazione completata',FAILURE:'Operazione fallita',NETWORK_ERROR:'Errore di rete',UNHANDLED_ERROR:'Errore non gestito'};
export async function report(token:string, raw:string, deps:ReportDeps):Promise<'sent'|'denied'|'invalid'|'limited'|'failed'>{
 try{
  const who=await deps.authorize(token);if(!who||!id(who.user_id))return 'denied';
  if(typeof raw!=='string'||new TextEncoder().encode(raw).length>2_000_000||!raw)return 'invalid';
  const rows=raw.split('\n');if(rows.length>15000)return 'invalid';
  let lastError='';const clean:string[]=[];
  for(const line of rows){const r=JSON.parse(line);if(r.user_id!==who.user_id||r.role!==who.role||![r.module,r.function,r.request_id,r.build_id].every(id)||!allowedPoint(r.source,r.module,r.function)||!allowedMetadata(r.request_id,r.build_id)||!['WEB','AI'].includes(r.source)||!['DEBUG','INFO','WARN','ERROR'].includes(r.level)||!Object.prototype.hasOwnProperty.call(messages,r.event)||typeof r.timestamp!=='string'||!Number.isFinite(Date.parse(r.timestamp)))return 'invalid';
   const row={timestamp:new Date(r.timestamp).toISOString(),user_id:who.user_id,role:who.role,source:r.source,module:r.module,function:r.function,level:r.level,event:r.event,request_id:r.request_id,build_id:r.build_id,message:messages[r.event],...(Number.isFinite(r.duration_ms)&&r.duration_ms>=0?{duration_ms:r.duration_ms}:{})};
   clean.push(JSON.stringify(row));if(r.level==='ERROR')lastError=[r.source,r.module,r.function,r.event].join(':');
  }
  if(!lastError)return 'invalid';const to=await deps.recipient(who);if(!to)return 'denied';
  if(!await deps.reserve(who,lastError))return 'limited';
  await deps.mail({to,subject:'FANTASMIA – ERROR REPORT',filename:'FANTASMIA_TRACE.jsonl',content:clean.join('\n')});return 'sent';
 }catch{return 'failed';}
}
