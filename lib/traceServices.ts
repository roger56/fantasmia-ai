/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE – AI/lib/traceServices.ts – rev 0.5.
 * Collegamento Redis via client esistente iniettato; Resend mediante HTTPS.
 * Nessun effetto all'importazione. Non installare ancora come route pubblica.
 */
import {integration} from './traceIntegration.js';
import {verifyTraceJwt,traceHash,verifyLocalTraceGrant,verifyTraceOtl,issueLocalTraceGrant} from './traceJwt.js';
type Services=Parameters<typeof integration>[0];
export function createTraceServices(redis:Services['redis'],config:{jwtSecret:string;oneTimeSecret?:string;resendKey:string;from:string;adminEmail:string}){
 const service=integration({redis,verify:async t=>(await verifyTraceJwt(t,config.jwtSecret))||(await verifyLocalTraceGrant(t,config.jwtSecret))||(await verifyTraceOtl(t,config.oneTimeSecret||'')),hash:traceHash,adminEmail:config.adminEmail,send:async m=>{
  if(!config.resendKey||!config.from)throw new Error('TRACE_MAIL_CONFIG');
  const bytes=new TextEncoder().encode(m.content);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+config.resendKey,'Content-Type':'application/json'},body:JSON.stringify({from:config.from,to:[m.to],subject:m.subject,text:'Rapporto diagnostico Fantasmia in allegato.',attachments:[{filename:m.filename,content:btoa(binary)}]}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('TRACE_MAIL_FAILED');
 }});
 return {...service,async grant(token:string,target:string){
  const p=await verifyTraceJwt(token,config.jwtSecret);
  if(!p||p.role!=='SUPERUSER'||!target.startsWith('local:'))return null;
  const subject=target.slice(6);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(subject))return null;
  const grant=await issueLocalTraceGrant(p.su_name,subject,config.jwtSecret);
  const ctx=await service.context(grant);
  return ctx?{token:grant,config:{...ctx.identity,...ctx.config,build_id:'trace-pilot-06'}}:null;
 }};
}
