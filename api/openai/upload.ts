// api/openai/upload.ts - VERSIONE CON DEBUG DETTAGLIATO
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { Readable } from 'stream';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Gestione CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // DEBUG DETTAGLIATO - Controlla ogni variabile separatamente
    console.log('🔍 ENVIRONMENT VARIABLES DETAILED CHECK:');
    
    const missingVars: string[] = [];
    
    // Controlla ogni variabile individualmente
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      console.log('❌ GOOGLE_SERVICE_ACCOUNT_EMAIL: MISSING');
      missingVars.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    } else {
      console.log(`✅ GOOGLE_SERVICE_ACCOUNT_EMAIL: PRESENT (${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL.substring(0, 20)}...)`);
    }
    
    if (!process.env.GOOGLE_PRIVATE_KEY) {
      console.log('❌ GOOGLE_PRIVATE_KEY: MISSING');
      missingVars.push('GOOGLE_PRIVATE_KEY');
    } else {
      console.log(`✅ GOOGLE_PRIVATE_KEY: PRESENT (${process.env.GOOGLE_PRIVATE_KEY.length} characters)`);
      // Controlla se la private key ha il formato corretto
      if (!process.env.GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
        console.log('⚠️  GOOGLE_PRIVATE_KEY: Potrebbe non avere il formato corretto');
      }
    }
    
    if (!process.env.GOOGLE_PRIVATE_FOLDER_ID) {
      console.log('❌ GOOGLE_PRIVATE_FOLDER_ID: MISSING');
      missingVars.push('GOOGLE_PRIVATE_FOLDER_ID');
    } else {
      console.log(`✅ GOOGLE_PRIVATE_FOLDER_ID: PRESENT (${process.env.GOOGLE_PRIVATE_FOLDER_ID})`);
    }

    // Se manca qualche variabile, ritorna errore dettagliato
    if (missingVars.length > 0) {
      console.log(`🚨 VARIABILI MANCANTI: ${missingVars.join(', ')}`);
      return res.status(500).json({
        success: false,
        error: `Missing environment variables: ${missingVars.join(', ')}`,
        missing_variables: missingVars,
        debug: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'PRESENT' : 'MISSING',
          GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? `PRESENT (${process.env.GOOGLE_PRIVATE_KEY.length} chars)` : 'MISSING',
          GOOGLE_PRIVATE_FOLDER_ID: process.env.GOOGLE_PRIVATE_FOLDER_ID ? 'PRESENT' : 'MISSING'
        }
      });
    }

    console.log('✅ TUTTE LE VARIABILI DI AMBIENTE SONO PRESENTI');

    const { filename, file_content, mime_type = 'application/octet-stream' } = req.body;

    if (!filename || !file_content) {
      return res.status(400).json({ 
        error: 'Filename and file_content are required' 
      });
    }

    console.log(`📁 Tentativo di upload: ${filename}, tipo: ${mime_type}`);

    const fileId = await uploadToGoogleDrive(filename, file_content, mime_type);

    console.log(`🎉 UPLOAD COMPLETATO: ${fileId}`);

    res.status(200).json({
      success: true,
      file_id: fileId,
      file_name: filename,
      message: 'File uploaded successfully to Google Drive'
    });

  } catch (error) {
    console.error('❌ UPLOAD ERROR:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function uploadToGoogleDrive(
  filename: string, 
  fileContent: string, 
  mimeType: string
): Promise<string> {
  
  console.log('🔐 Autenticazione con Google Drive...');
  
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: 'pro-hour-465513-c3',
      private_key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    },
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  const drive = google.drive({ version: 'v3', auth });
  const folderId = process.env.GOOGLE_PRIVATE_FOLDER_ID!;

  console.log(`📂 Cartella destinazione: ${folderId}`);

  // Pulisci e decodifica il contenuto base64
  const cleanFileContent = fileContent.startsWith('data:') 
    ? fileContent.split(',')[1] 
    : fileContent;
  
  const fileBuffer = Buffer.from(cleanFileContent, 'base64');
  console.log(`📊 Dimensione file: ${fileBuffer.length} bytes`);

  const readableStream = Readable.from(fileBuffer);

  const fileMetadata = {
    name: filename,
    parents: [folderId]
  };

  const media = {
    mimeType: mimeType,
    body: readableStream
  };

  console.log('📤 Uploading file to Google Drive...');
  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  if (!response.data.id) {
    throw new Error('Failed to upload file to Google Drive - no file ID returned');
  }

  console.log('✅ File uploaded successfully:', response.data.id);
  return response.data.id;
}
