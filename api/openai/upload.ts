// api/openai/upload.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { Readable } from 'stream';

export const config = {
  api: {
    bodyParser: false,
  },
};

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
    // Per multipart/form-data, devi parsare manualmente
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // Estrai filename dal Content-Disposition header o usa un nome di default
    const contentType = req.headers['content-type'];
    let filename = 'uploaded_file';
    
    if (contentType?.includes('multipart/form-data')) {
      // Parsing semplificato - in produzione usa una libreria come 'busboy'
      const contentDisposition = req.headers['content-disposition'];
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="([^"]+)"/);
        if (match) {
          filename = match[1];
        }
      }
    }

    const fileId = await uploadToGoogleDrive(filename, buffer.toString('base64'), req.headers['content-type']?.split(';')[0] || 'application/octet-stream');

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
  
  if (!process.env.COOGLE_PRIVATE_KEY || !process.env.COOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.COOGLE_PRIVATE_FOLDER_ID) {
    throw new Error('Missing required environment variables for Google Drive');
  }

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

  const fileBuffer = Buffer.from(fileContent, 'base64');
  const readableStream = Readable.from(fileBuffer);

  const fileMetadata = {
    name: filename,
    parents: [folderId]
  };

  const media = {
    mimeType: mimeType,
    body: readableStream
  };

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
