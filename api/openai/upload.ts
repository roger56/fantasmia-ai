// api/openai/upload.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

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
    // DEBUG: Ritorna tutte le env vars (senza valori sensibili)
    const envVars = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL 
        ? `Present (${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL.substring(0, 10)}...)` 
        : 'MISSING',
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY 
        ? `Present (${process.env.GOOGLE_PRIVATE_KEY.length} chars)` 
        : 'MISSING',
      GOOGLE_PRIVATE_FOLDER_ID: process.env.GOOGLE_PRIVATE_FOLDER_ID 
        ? `Present (${process.env.GOOGLE_PRIVATE_FOLDER_ID})` 
        : 'MISSING',
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV
    };

    console.log('🔍 Environment Variables:', envVars);

    // Se mancano le variabili, ritorna il debug info
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_PRIVATE_FOLDER_ID) {
      return res.status(500).json({
        success: false,
        error: 'Missing environment variables',
        debug: envVars
      });
    }

    const { filename, file_content, mime_type = 'application/octet-stream' } = req.body;

    if (!filename || !file_content) {
      return res.status(400).json({ 
        error: 'Filename and file_content are required' 
      });
    }

    // Per ora ritorna successo fittizio con info debug
    res.status(200).json({
      success: true,
      file_id: 'debug_mode',
      file_name: filename,
      message: 'Environment variables check passed',
      debug: envVars
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
