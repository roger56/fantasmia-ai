import { google } from 'googleapis';
import { Readable } from 'stream';

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

export async function POST(request: Request) {
  console.log('🔍 Upload API chiamata');
  
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
      return Response.json({ error: 'Google credentials missing' }, { status: 500 });
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

  } catch (error: any) {  // ✅ CORRETTO: 'error: any'
    console.error('❌ Upload error:', error);
    return Response.json({ error: 'Upload failed: ' + error.message }, { status: 500 });
  }
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
