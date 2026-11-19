/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.6 — AI/lib/traceRuntime.ts.
 * Contesto AsyncLocalStorage PER RICHIESTA. OFF senza Redis o rete.
 * L'opt-in diagnostico non autorizza mai l'operazione applicativa.
 * Una risposta operativa mantiene status/campi; solo ON riceve campi diagnostici.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {Redis} from '@upstash/redis';
import {createTraceServices} from './traceServices.js';
import {createTrace} from './traceManager.js';
import {allowedMetadata} from './traceCatalog.js';
const storage=new AsyncLocalStorage<ReturnType<typeof createTrace>>();
export function tracePoint(module:string,fn:string,error=false):void {
 try {storage.getStore()?.log(module,fn,error?'ERROR':'INFO',error?'FAILURE':'START');}catch{/* isolato */}
}
function services(){
 return createTraceServices(Redis.fromEnv(),{jwtSecret:process.env.ADMIN_JWT_SECRET||'',oneTimeSecret:process.env.NSU_ONE_TIME_SECRET||'',resendKey:process.env.RESEND_API_KEY||'',from:process.env.TRACE_MAIL_FROM||'Fantasmia <no-reply@fantasmia.it>',adminEmail:process.env.TRACE_ADMIN_EMAIL||''});
}
// Il login mantiene 300 ms; le sole richieste API con TRACE esplicito hanno
// 3000 ms per verificare identità/configurazione su Redis. Nessun retry/polling.
async function boundedContext(token:string,budgetMs=300){
 let timer:ReturnType<typeof setTimeout>|undefined;
 // Un timeout è uno stato sconosciuto, non una revoca della configurazione.
 try {return await Promise.race([services().context(token),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),budgetMs);})]);}
 catch{return undefined;}finally{if(timer)clearTimeout(timer);}
}
/** Da chiamare soltanto DOPO il successo dell'autenticazione già esistente. */
export async function sessionTraceForToken(token:string):Promise<Record<string,unknown>> {
 if(process.env.FANTASMIA_TRACE_ENABLED!=='1')return {};
 // L'opt-in esplicito permette al WEB un solo recupero asincrono al login
 // se il limite diagnostico scade. Non aggiunge attese al login operativo.
 try {const ctx=await boundedContext(token);return ctx===undefined?{trace_available:true}:{trace_available:true,trace_config:ctx?{...ctx.identity,...ctx.config,build_id:'trace-pilot-06'}:null};}
 catch{return {trace_available:true};}
}
function metadata(body:unknown):{token:string;request_id:string}|undefined {
 try {const b=typeof body==='string'?JSON.parse(body):body;
  const m=b?.__fantasmia_trace;
  if(m&&typeof m.token==='string'&&m.token.length<=8192&&allowedMetadata(m.request_id,'trace-pilot-06'))return m;
 }catch{/* non JSON */}
 return undefined;
}
/** Adapter Pages API: this, argomenti, valore e Promise OFF vengono conservati. */
export function withTrace<T extends (...args:any[])=>any>(module:string,handler:T):T {
 const wrapped=function(this:unknown,...args:Parameters<T>){
  if(process.env.FANTASMIA_TRACE_ENABLED!=='1')return handler.apply(this,args);
  const req=args[0],res=args[1];
  // Il preflight diagnostico è additivo e soltanto dopo opt-in server.
  if(req?.method==='OPTIONS'&&String(req.headers?.['access-control-request-headers']||'').toLowerCase().includes('x-fantasmia-trace')&&res?.setHeader){
   const set=res.setHeader;
   res.setHeader=function(name:string,value:any){if(name.toLowerCase()==='access-control-allow-headers'&&!String(value).toLowerCase().includes('x-fantasmia-trace'))value=String(value)+', X-Fantasmia-Trace';return set.call(this,name,value);};
   try{const result=handler.apply(this,args);if(result&&typeof result.then==='function')return result.finally(()=>{res.setHeader=set;});res.setHeader=set;return result;}catch(e){res.setHeader=set;throw e;}
  }
  let meta=metadata(req?.body);
  if(!meta&&typeof req?.headers?.['x-fantasmia-trace']==='string'){try{meta=metadata({__fantasmia_trace:JSON.parse(req.headers['x-fantasmia-trace'])});}catch{/* header non valido */}}
  if(!meta||!res?.json||req?.method==='OPTIONS')return handler.apply(this,args);
  const self=this;
  return (async()=>{
   const ctx=await boundedContext(meta.token,3000);
   const recorder=createTrace(ctx?{...ctx.identity,...ctx.config,request_id:meta.request_id,build_id:'trace-pilot-06'}:undefined);
   const original=res.json;
   res.json=function(body:unknown){
    // La strumentazione non deve far fallire un invio JSON altrimenti valido.
    let output=body;
    try {
     if(ctx)recorder.log(module,'handler',res.statusCode>=400?'ERROR':'INFO',res.statusCode>=400?'FAILURE':'SUCCESS');
     if(body&&typeof body==='object'&&!Array.isArray(body)){
      output=ctx===undefined
       ? {...body,__fantasmia_trace_status:'context_unavailable'}
       : {...body,__fantasmia_trace:recorder.snapshot(),trace_config:ctx?{...ctx.identity,...ctx.config,build_id:'trace-pilot-06'}:null};
      try{res.setHeader('Cache-Control','no-store');}catch{/* header già inviati */}
     }
    }catch{/* risposta originale */}
    return original.call(this,output);
   };
   try{return await storage.run(recorder,()=>handler.apply(self,args));}
   catch(error){recorder.log(module,'handler','ERROR','UNHANDLED_ERROR');throw error;}
   finally{res.json=original;}
  })();
 };
 return wrapped as T;
}
/** Adapter Request/Response, senza consumare il corpo originale. */
export function withTraceRequest<T extends (request:Request,...rest:any[])=>any>(module:string,handler:T):T {
 const wrapped=function(this:unknown,request:Request,...rest:any[]){
  if(process.env.FANTASMIA_TRACE_ENABLED!=='1'||request.method!=='POST')return handler.call(this,request,...rest);
  const self=this;
  return (async()=>{
   let meta:ReturnType<typeof metadata>;
   try{meta=metadata(await request.clone().json());}catch{/* corpo non JSON */}
   if(!meta)return handler.call(self,request,...rest);
   const ctx=await boundedContext(meta.token,3000);
   const recorder=createTrace(ctx?{...ctx.identity,...ctx.config,request_id:meta.request_id,build_id:'trace-pilot-06'}:undefined);
   const response:Response=await storage.run(recorder,()=>handler.call(self,request,...rest));
   try{
    if(ctx)recorder.log(module,'handler',response.status>=400?'ERROR':'INFO',response.status>=400?'FAILURE':'SUCCESS');
    if((response.headers.get('content-type')||'').includes('json')){
     const body=await response.clone().json();
     if(body&&typeof body==='object'&&!Array.isArray(body)){
      const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');headers.delete('content-length');
      const output=ctx===undefined
       ? {...body,__fantasmia_trace_status:'context_unavailable'}
       : {...body,__fantasmia_trace:recorder.snapshot(),trace_config:ctx?{...ctx.identity,...ctx.config,build_id:'trace-pilot-06'}:null};
      return new Response(JSON.stringify(output),{status:response.status,statusText:response.statusText,headers});
     }
    }
   }catch{/* conserva risposta originale */}
   return response;
  })();
 };
 return wrapped as T;
}
