# FANTASMIA — AI: riferimento sorgenti 19 novembre 2026

Repository: `roger56/fantasmia-ai`. Ramo di riferimento: `reference/fantasmia-trace-20261119`.
Baseline: **TRACE 5B-R2 2.6 collaudato + consolidamento sorgenti**.

Questa cartella e il progetto completo. Non sovrapporre vecchi ZIP di correzione.
Le credenziali e la configurazione di un'installazione sono rimandate alla fase
successiva; `.env.example` e un modello senza valori. Nessuna chiave va copiata
automaticamente dalle vecchie prove.

## Stato

- Storia NSU creata, salvata e riaperta: collaudo utente riuscito.
- Catena WEB -> AI -> IndexedDB -> email al SU: collaudo reale riuscito.
- Ultimo report esaminato: coppia AI/WEB con identico request_id, utente e ruolo NSU.
- TRACE circolare 2 MB logici per utente; attivazione su richiesta; nessun nuovo polling.
- API operative e autorizzazioni conservate. Nessuna generazione AI a pagamento eseguita nei test controllati.
- Configurazione chiavi/ambienti, installazione operativa e rilascio in produzione: fase successiva.

## Backend AI consolidato

Usare Node 22.x. Restano 12 funzioni Vercel. `/api/admin/trace` e riscritto verso
il ramo diagnostico di `api/admin/login`, senza aggiungere una tredicesima funzione.
Il login mantiene un budget diagnostico di 300 ms; una richiesta API con TRACE
esplicito dispone di 3000 ms. Una lookup indisponibile non spegne la sessione WEB;
la risposta puo indicare `__fantasmia_trace_status: context_unavailable`.
OFF, gli adattatori conservano richiesta, Promise e risposta operative.

## Verifica dei sorgenti

Dalla cartella AI:

```bat
npm ci
npx --no-install tsc --noEmit
```

`npm run build` stampa soltanto un messaggio: non sostituisce il controllo TypeScript.
Dipendenze e lockfile sono invariati. Le configurazioni e le chiavi dei servizi
saranno definite nella fase successiva, prima di un'installazione/deployment operativo.

## Documentazione

Questo README e il punto di ingresso della baseline consolidata. Il README
precedente e conservato in `docs/STORICO/README_PRE_RIFERIMENTO.md`.
Le vecchie guide, patch e documenti di migrazione restano storici: non sono
pacchetti da applicare sopra questa cartella.

**Prossimo passo da ricordare:** chiavi, variabili d'ambiente, URL/domìni, configurazione
dell'installazione e verifica degli ambienti. Questo riordino riguarda i sorgenti.

## Pubblicazione separata dall'installazione

Il solo ramo di riferimento ha l'auto-deployment Git disabilitato in `vercel.json`.
Il merge in main e il rilascio operativo saranno trattati dopo la configurazione.
La regola e limitata a questo ramo e non modifica le impostazioni degli altri rami.
