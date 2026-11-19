/** FANTASMIA TRACE – AI/lib/traceManager.ts – rev 0.2. Buffer esclusivamente per richiesta, nessuna persistenza Redis. */
type Level='DEBUG'|'INFO'|'WARN'|'ERROR';
type Event='START'|'SUCCESS'|'FAILURE'|'NETWORK_ERROR'|'UNHANDLED_ERROR';
const messages:Record<Event,string>={START:'Operazione iniziata',SUCCESS:'Operazione completata',FAILURE:'Operazione fallita',NETWORK_ERROR:'Errore di rete',UNHANDLED_ERROR:'Errore non gestito'};
const rank:Record<Level,number>={DEBUG:0,INFO:1,WARN:2,ERROR:3};
const safe=(s:string)=>typeof s==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(s);
export function createTrace(config?:{user_id:string;role:'ADMIN'|'SU'|'NSU'|'WRITER';level:Level;expires_at:number;request_id:string;build_id:string}){
 const c=config?{...config}:undefined;const rows:Record<string,unknown>[]=[];
 return {log(module:string,fn:string,level:Level,event:Event,duration_ms?:number):void{try{if(!c||c.expires_at<=Date.now()||!Object.prototype.hasOwnProperty.call(rank,c.level)||!Object.prototype.hasOwnProperty.call(rank,level)||rank[level]<rank[c.level]||!Object.prototype.hasOwnProperty.call(messages,event)||![module,fn,c.user_id,c.request_id,c.build_id].every(safe)||!['ADMIN','SU','NSU','WRITER'].includes(c.role))return;const r={timestamp:new Date().toISOString(),user_id:c.user_id,role:c.role,source:'AI',module,function:fn,level,request_id:c.request_id,event,message:messages[event],duration_ms:Number.isFinite(duration_ms)&&duration_ms!>=0?duration_ms:undefined,build_id:c.build_id};rows.push(r);if(rows.length>100)rows.shift();console.info('[FANTASMIA_TRACE]',JSON.stringify(r));}catch{/* mai propagare */}},snapshot(){return rows.map(r=>({...r}));}};
}
