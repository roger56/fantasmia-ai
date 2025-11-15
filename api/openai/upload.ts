// api/openai/upload.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { Readable } from 'stream';

interface UploadRequest {
  filename: string;
  file_content: string;
  mime_type?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Gestione CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { filename, file_content, mime_type = 'application/octet-stream' } = req.body as UploadRequest;

    if (!filename || !file_content) {
      return res.status(400).json({ 
        error: 'Filename and file_content are required' 
      });
    }

    const fileId = await uploadToGoogleDrive(filename, file_content, mime_type);

    res.status(200).json({
      success: true,
      file_id: fileId,
      message: 'File uploaded successfully to fantasmia-upload'
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
  
  if (!process.env.COOGLE_PRIVATE_KEY || !process.env.COOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.COOGLE_PRIVATE_FOLDER_ID) {
    throw new Error('Missing required environment variables for Google Drive');
  }

  // Configura l'autenticazione con Google Drive
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: 'pro-hour-465513-c3',
      private_key: process.env.COOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.COOGLE_SERVICE_ACCOUNT_EMAIL,
    },
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  const drive = google.drive({ version: 'v3', auth });
  const folderId = process.env.COOGLE_PRIVATE_FOLDER_ID;

  // Pulisci e decodifica il contenuto base64
  const cleanFileContent = fileContent.startsWith('data:') 
    ? fileContent.split(',')[1] 
    : fileContent;
  
  const fileBuffer = Buffer.from(cleanFileContent, 'base64');
  const readableStream = Readable.from(fileBuffer);

  // Metadata del file
  const fileMetadata = {
    name: filename,
    parents: [folderId]
  };

  const media = {
    mimeType: mimeType,
    body: readableStream
  };

  // Upload del file
  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  if (!response.data.id) {
    throw new Error('Failed to upload file to Google Drive');
  }

  return response.data.id;
}
