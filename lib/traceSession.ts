/** FANTASMIA TRACE – AI/lib/traceSession.ts – rev 1.6.
 * Solo dopo verifica NSU esistente. Nessuna scrittura, nessuna rete propria.
 */
export async function sessionTrace(enabled:boolean, active:boolean, su:string, nsu:string, read:(key:string)=>Promise<unknown>, hash:(value:string)=>Promise<string>) {
 if(!enabled || !active)return undefined;
 try {
  const id=await hash(JSON.stringify([su,nsu]));
  const raw=await read('trace:v1:config:'+id);
  if(raw===null)return null;
  const c=raw as {level:string;expires_at:number};
  if(!c||!['DEBUG','INFO','WARN','ERROR'].includes(c.level)||!Number.isFinite(c.expires_at)||c.expires_at<=Date.now()||c.expires_at>Date.now()+86400000)return null;
  return {user_id:id,role:'NSU',level:c.level,expires_at:c.expires_at,build_id:'trace-pilot-06'};
 } catch {return undefined;}
}
