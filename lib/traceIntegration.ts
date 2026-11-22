/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — lib/traceIntegration.ts.
 * Redis diagnostico separato; destinatario sempre ricavato dal SU autenticato.
 * NSU credenziali, OTL già attivato e grant diagnostici per profili locali.
 */
import {report,type Identity} from './traceReport.js';
type Level='DEBUG'|'INFO'|'WARN'|'ERROR';
export type Principal={role:'SUPERUSER'|'NSU';su_name:string;nsu_id?:string;session_hash?:string;access_id?:string;local?:boolean};
type Config={level:Level;expires_at:number};
interface RedisPort {get<T>(key:string):Promise<T|null>;set(key:string,value:unknown,options:{ex:number}&({nx:true}|{nx?:never})):Promise<unknown>;del(key:string):Promise<unknown>}
interface Services {redis:RedisPort;verify(token:string):Promise<Principal|null>;send(input:{to:string;subject:string;filename:string;content:string}):Promise<void>;adminEmail:string;hash(value:string):Promise<string>}
const enabled=(x:unknown)=>x===1||x==='1'||x===true;
export function integration(s:Services){
 const key=async(su:string,nsu:string)=>'trace:v1:config:'+await s.hash(JSON.stringify([su,nsu]));
 async function principal(token:string){
  const p=await s.verify(token);if(!p||!p.su_name||!['SUPERUSER','NSU'].includes(p.role))return null;
  const su=await s.redis.get<{su_email?:string}>('auth:su:'+p.su_name);if(!su)return null;
  if(p.role==='NSU'){
   if(!p.nsu_id)return null;
   if(p.access_id){
    const n=await s.redis.get<{su_name:string;revoked?:boolean;first_login_at?:string;expires_at?:string|null;permanent?:boolean}>('ot_access:'+p.access_id);
    if(!n||n.su_name!==p.su_name||n.revoked===true||!n.first_login_at||(!n.permanent&&(!n.expires_at||!Number.isFinite(Date.parse(n.expires_at))||Date.parse(n.expires_at)<=Date.now())))return null;
   }else if(!p.local){
    const n=await s.redis.get<{enabled:unknown;access_type?:string;active_session_hash?:string}>('auth:nsu:'+p.su_name+':'+p.nsu_id);
    if(!n||!enabled(n.enabled)||(n.access_type==='remote'&&(!p.session_hash||p.session_hash!==n.active_session_hash)))return null;
   }
  }
  return {p,su};
 }
 async function configure(token:string,target:string,level:Level|null){
  const a=await principal(token);if(!a||a.p.role!=='SUPERUSER')return false;
  if(target){
   if(target.startsWith('local:')){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(target.slice(6)))return false;}
   else if(target.startsWith('otl:')){const id=target.slice(4);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return false;const n=await s.redis.get<{su_name:string}>('ot_access:'+id);if(!n||n.su_name!==a.p.su_name)return false;}
   else {if(!/^[a-z0-9_-]{1,40}$/.test(target))return false;const n=await s.redis.get<{enabled:unknown}>('auth:nsu:'+a.p.su_name+':'+target);if(!n||!enabled(n.enabled))return false;}
  }
  const k=await key(a.p.su_name,target);
  if(level===null){await s.redis.del(k);return true;}
  if(!['DEBUG','INFO','WARN','ERROR'].includes(level))return false;
  await s.redis.set(k,{level,expires_at:Date.now()+86400000},{ex:86400});return true;
 }
 async function context(token:string){
  const a=await principal(token);if(!a)return null;
  const target=a.p.role==='NSU'?a.p.nsu_id!:'';
  const cfg=await s.redis.get<Config>(await key(a.p.su_name,target));
  if(!cfg||!['DEBUG','INFO','WARN','ERROR'].includes(cfg.level)||!Number.isFinite(cfg.expires_at)||cfg.expires_at<=Date.now()||cfg.expires_at>Date.now()+86400000)return null;
  const identity:Identity={user_id:await s.hash(JSON.stringify([a.p.su_name,target])),role:a.p.role==='NSU'?'NSU':'SU'};
  // Anche i log SU sono inviati al SU competente; ADMIN è solo fallback esplicito.
  return {identity,config:cfg,to:a.su.su_email};
 }
 async function submit(token:string,raw:string){
  let ctx:Awaited<ReturnType<typeof context>>=null;
  return report(token,raw,{authorize:async t=>{ctx=await context(t);return ctx?.identity??null;},recipient:async()=>ctx?.to&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctx.to)?ctx.to:null,reserve:async(i,f)=>{
   const k='trace:v1:mail:'+await s.hash(JSON.stringify([i.user_id,f]));
   if(await s.redis.set(k,1,{ex:300,nx:true})!=='OK')return false;
   return await s.redis.set('trace:v1:mail:global',1,{ex:60,nx:true})==='OK';
  },mail:s.send});
 }
 return {configure,context,submit};
}
