// api/openai/upload.ts
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
    // DEBUG: Verifica le env vars corrette
    const envVars = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL 
        ? `Present (${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL.substring(0, 10)}...)` 
        : 'MISSING',
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY 
        ? `Present (${process.env.GOOGLE_PRIVATE_KEY.length} chars)` 
        : 'MISSING',
      GOOGLE_PRIVATE_FOLDER_ID: process.env.GOOGLE_PRIVATE_FOLDER_ID 
        ? `Present (${process.env.GOOGLE_PRIVATE_FOLDER_ID})` 
        : 'MISSING'
    };

    console.log('🔍 Environment Variables:', envVars);

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

    const fileId = await uploadToGoogleDrive(filename, file_content, mime_type);

    res.status(200).json({
      success: true,
      file_id: fileId,
      file_name: filename,
      message: 'File uploaded successfully to Google Drive'
    });

  } catch (error) {
    console.error('Upload error:', error);
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

  // Pulisci e decodifica il contenuto base64
  const cleanFileContent = fileContent.startsWith('data:') 
    ? fileContent.split(',')[1] 
    : fileContent;
  
  const fileBuffer = Buffer.from(cleanFileContent, 'base64');
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
    throw new Error('Failed to upload file to Google Drive');
  }

  console.log('✅ File uploaded successfully:', response.data.id);
  return response.data.id;
}
