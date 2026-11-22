/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE – AI/lib/traceOpenAI.ts – rev 0.8.
 * Adattatore pilota per improve-text. Nessuna rete, nessun effetto all'import.
 * Il contesto deve essere fornito esclusivamente dal server dopo verifica JWT.
 */
import {createTrace} from './traceManager.js';
type Context = Parameters<typeof createTrace>[0];
export function openAITrace(context?: Context) {
  const manager = createTrace(context);
  const valid = !!context && context.expires_at > Date.now();
  const start = valid ? Date.now() : 0;
  const event = (fn: 'handler' | 'callOpenAI', outcome: 'START' | 'SUCCESS' | 'FAILURE', since: number) => {
    try { if (valid) manager.log('improve-text.ts', fn, outcome === 'FAILURE' ? 'ERROR' : 'INFO', outcome, outcome === 'START' ? undefined : Date.now() - since); } catch { /* diagnostica isolata */ }
  };
  event('handler','START',start);
  return {
    async call<T>(operation: () => Promise<T>): Promise<T> {
      if (!valid) return operation();
      const t = Date.now(); event('callOpenAI','START',t);
      try { const result = await operation(); event('callOpenAI','SUCCESS',t); return result; }
      catch (error) { event('callOpenAI','FAILURE',t); throw error; }
    },
    finish(ok: boolean) { event('handler',ok?'SUCCESS':'FAILURE',start); },
    snapshot() { return manager.snapshot(); }
  };
}
