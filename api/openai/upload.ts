import { google } from 'googleapis';
import { Readable } from 'stream';
export const runtime = 'nodejs';

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY, // NON serve replace, già formattata
  },
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });
function normalizePrivateKey(input?: string): string | undefined {
  if (!input) return undefined;
  // Se arrivano \n letterali, li trasformo in newline reali
  let key = input.replace(/\\n/g, '\n').trim();
  // Rimuovo eventuali doppi apici avvolgenti
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  return key;
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  },
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
try {
  const client = await auth.getClient();
  console.log('✅ Google auth OK - project id:', await auth.getProjectId());
} catch (e) {
  console.error('❌ Google auth FAILED:', e);
  return Response.json({ error: 'Google auth failed: ' + (e as Error).message }, { status: 500 });
}

// ✅ UNA SOLA FUNZIONE GET - versione migliorata
export async function GET() {
  console.log('🔍 DEBUG ENV VARIABLES:');
  
  const envStatus = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? "PRESENTE" : "MANCANTE",
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? `PRESENTE (${process.env.GOOGLE_PRIVATE_KEY.length} chars)` : "MANCANTE",
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID ? "PRESENTE" : "MANCANTE",
    privateKeyStartsWith: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.substring(0, 30) : "N/A",
    privateKeyContainsNewlines: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.includes('\\n') : false,
    privateKeyFormatCorrect: process.env.GOOGLE_PRIVATE_KEY ? 
      process.env.GOOGLE_PRIVATE_KEY.startsWith('-----BEGIN PRIVATE KEY-----') : false
  };
  
  console.log('Environment Status:', envStatus);
  
  return Response.json(envStatus);
}

export async function POST(request: Request) {
  console.log('🔍 Upload API chiamata');
  
  // 🔴 DEBUG ESTESO - Aggiungi questa sezione
  console.log('🔐 DEBUG CREDENZIALI:');
  console.log('GOOGLE_SERVICE_ACCOUNT_EMAIL:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'PRESENTE' : 'MANCANTE');
  console.log('GOOGLE_DRIVE_FOLDER_ID:', process.env.GOOGLE_DRIVE_FOLDER_ID ? 'PRESENTE' : 'MANCANTE');
  console.log('GOOGLE_PRIVATE_KEY length:', process.env.GOOGLE_PRIVATE_KEY?.length || 'MANCANTE');
  console.log('GOOGLE_PRIVATE_KEY startsWith -----BEGIN:', process.env.GOOGLE_PRIVATE_KEY?.startsWith('-----BEGIN'));
   console.log('📁 GOOGLE_DRIVE_FOLDER_ID:', process.env.GOOGLE_DRIVE_FOLDER_ID);
  console.log('📁 Folder ID length:', process.env.GOOGLE_DRIVE_FOLDER_ID?.length);
  console.log('📁 Folder ID trimmed:', process.env.GOOGLE_DRIVE_FOLDER_ID?.trim());
  
  if (process.env.GOOGLE_PRIVATE_KEY) {
    console.log('GOOGLE_PRIVATE_KEY primi 50 chars:', process.env.GOOGLE_PRIVATE_KEY.substring(0, 50));
    console.log('GOOGLE_PRIVATE_KEY contiene \\n:', process.env.GOOGLE_PRIVATE_KEY.includes('\\n'));
  }
  
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    console.log('📁 File ricevuto:', file?.name);
    
    if (!file) {
      console.log('❌ Nessun file fornito');
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    // Verifica credenziali
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.log('❌ Credenziali Google mancanti');
      console.log('EMAIL:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'OK' : 'MISSING');
      console.log('KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'OK' : 'MISSING');
      return Response.json({ error: 'Google credentials missing' }, { status: 500 });
    }

    // 🔴 TEST AUTH - Verifica che l'autenticazione funzioni
    try {
      const client = await auth.getClient();
      console.log('✅ Autenticazione Google riuscita');
    } catch (authError) {
      console.error('❌ Errore autenticazione Google:', authError);
      const errorMessage = authError instanceof Error ? authError.message : 'Unknown auth error';
      return Response.json({ error: 'Google auth failed: ' + errorMessage }, { status: 500 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    console.log('📊 Dimensione file:', buffer.length, 'bytes');

    const response = await drive.files.create({
      requestBody: {
        name: `${Date.now()}_${file.name}`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID!],
      },
      media: {
        mimeType: file.type,
        body: Readable.from(buffer),
      },
      fields: 'id, name, webViewLink, webContentLink',
    });

    console.log('✅ File caricato su Drive:', response.data.id);

    await drive.permissions.create({
      fileId: response.data.id!,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    console.log('✅ Permessi impostati');

    return Response.json({
      success: true,
      fileId: response.data.id,
      fileName: response.data.name,
      viewUrl: response.data.webViewLink,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
    });

  } catch (error: any) {
    console.error('❌ Upload error:', error);
    return Response.json({ error: 'Upload failed: ' + error.message }, { status: 500 });
  }
}
export async function GET() {
  const pk = process.env.GOOGLE_PRIVATE_KEY || '';
  return Response.json({
    email: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    folder: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
    pk_present: !!pk,
    pk_starts_begin: pk.startsWith('-----BEGIN') || pk.startsWith('"-----BEGIN') || pk.startsWith('-----BEGIN PRIVATE KEY-----\\n'),
    pk_has_backslash_n: pk.includes('\\n'),
    pk_length: pk.length,
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
