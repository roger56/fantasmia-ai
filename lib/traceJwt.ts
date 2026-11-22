/** FANTASMIA TRACE – AI/lib/traceJwt.ts – rev 0.5.
 * Verifica isolata HS256 compatibile con login.ts; nessuna modifica al login.
 */
export async function verifyTraceJwt(token:string,secret:string){
 try{
  if(!secret||token.length>8192)return null;
  const parts=token.split('.');if(parts.length!==3||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))return null;
  const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const json=(v:string)=>JSON.parse(new TextDecoder().decode(decode(v)));
  if(json(parts[0]).alg!=='HS256')return null;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,decode(parts[2]),new TextEncoder().encode(parts.slice(0,2).join('.'))))return null;
  const p=json(parts[1]);if(!Number.isFinite(p.exp)||p.exp*1000<=Date.now()||!['SUPERUSER','NSU'].includes(p.role))return null;
  const su=typeof p.su_name==='string'?p.su_name.trim().replace(/\s+/g,' ').toLowerCase():'';
  if(!su||su.includes(':'))return null;
  if(p.role==='SUPERUSER')return {role:'SUPERUSER' as const,su_name:su};
  if(typeof p.nsu_id!=='string'||! /^[a-z0-9_-]{1,40}$/.test(p.nsu_id))return null;
  return {role:'NSU' as const,su_name:su,nsu_id:p.nsu_id,session_hash:typeof p.session_hash==='string'?p.session_hash:undefined};
 }catch{return null;}
}
export async function traceHash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}

/** Grant SOLO diagnostico: non viene accettato dalle API di autenticazione. */
export async function issueLocalTraceGrant(su:string,profile:string,secret:string):Promise<string>{
 const encode=(s:string)=>btoa(unescape(encodeURIComponent(s))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
 const payload={role:'TRACE_LOCAL',su_name:su,profile,exp:Math.floor(Date.now()/1000)+86400};
 const data=encode(JSON.stringify({alg:'HS256',typ:'JWT'}))+'.'+encode(JSON.stringify(payload));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(data)));
 const sig=btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');return data+'.'+sig;
}
export async function verifyLocalTraceGrant(token:string,secret:string){
 try{
  const parts=token.split('.');if(!secret||token.length>8192||parts.length!==3)return null;
  const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const json=(v:string)=>JSON.parse(new TextDecoder().decode(decode(v)));
  if(json(parts[0]).alg!=='HS256')return null;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,decode(parts[2]),new TextEncoder().encode(parts.slice(0,2).join('.'))))return null;
  const p=json(parts[1]);
  if(p.role!=='TRACE_LOCAL'||typeof p.su_name!=='string'||!p.su_name||p.su_name.includes(':')||!Number.isFinite(p.exp)||p.exp*1000<=Date.now()||p.exp*1000>Date.now()+86400000||! /^[a-zA-Z0-9_-]{1,100}$/.test(p.profile))return null;
  return {role:'NSU' as const,su_name:p.su_name,nsu_id:'local:'+p.profile,local:true};
 }catch{return null;}
}
/** Verifica OTL senza riattivarlo o modificarne la scadenza. */
export async function verifyTraceOtl(token:string,secret:string){
 try{
  const parts=token.split('.');if(!secret||token.length>8192||parts.length!==2)return null;
  const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const bytes=decode(parts[0]);const p=JSON.parse(new TextDecoder().decode(bytes));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,decode(parts[1]),bytes))return null;
  if(p.type!=='NSU_ONE_TIME'||p.created_by!=='SU'||typeof p.su_name!=='string'||!p.su_name||p.su_name.includes(':')||! /^[a-zA-Z0-9_-]{1,100}$/.test(p.access_id))return null;
  return {role:'NSU' as const,su_name:p.su_name.trim().toLowerCase(),nsu_id:'otl:'+p.access_id,access_id:p.access_id};
 }catch{return null;}
}
