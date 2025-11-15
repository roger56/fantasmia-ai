# api/upload.py
from http.server import BaseHTTPRequestHandler
import json
import os
import base64
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
import io

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            # Leggi i dati della richiesta
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            data = json.loads(post_data)
            filename = data.get('filename', 'uploaded_file')
            file_content_b64 = data.get('file_content')  # Dati in base64
            mime_type = data.get('mime_type', 'application/octet-stream')
            
            # Upload a Google Drive
            file_id = self.upload_to_drive(filename, file_content_b64, mime_type)
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            response = {
                'success': True,
                'file_id': file_id,
                'message': 'File uploaded successfully to fantasmia-upload'
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            error_response = {
                'success': False,
                'error': str(e)
            }
            self.wfile.write(json.dumps(error_response).encode())
    
    def upload_to_drive(self, filename, file_content_b64, mime_type):
        """Carica file su Google Drive usando le variabili d'ambiente"""
        
        # Recupera le credenziali dalle variabili d'ambiente
        service_account_info = {
            "type": "service_account",
            "project_id": "pro-hour-465513-c3",
            "private_key_id": os.environ.get('COOGLE_PRIVATE_KEY', '').replace('\\n', '\n'),
            "private_key": os.environ.get('COOGLE_PRIVATE_KEY', '').replace('\\n', '\n'),
            "client_email": os.environ.get('COOGLE_SERVICE_ACCOUNT_EMAIL', ''),
            "client_id": "",  # Opzionale
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs"
        }
        
        SCOPES = ['https://www.googleapis.com/auth/drive.file']
        folder_id = os.environ.get('COOGLE_PRIVATE_FOLDER_ID', '')
        
        # Autenticazione con service account
        creds = service_account.Credentials.from_service_account_info(
            service_account_info, scopes=SCOPES)
        
        service = build('drive', 'v3', credentials=creds)
        
        # Metadata del file
        file_metadata = {
            'name': filename,
            'parents': [folder_id]  # La cartella "fantasmia-upload"
        }
        
        # Decodifica i dati base64
        if file_content_b64.startswith('data:'):
            file_content_b64 = file_content_b64.split(',')[1]
        
        file_data = base64.b64decode(file_content_b64)
        
        media = MediaIoBaseUpload(
            io.BytesIO(file_data),
            mimetype=mime_type,
            resumable=True
        )
        
        # Crea il file su Google Drive
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, webViewLink'
        ).execute()
        
        return file.get('id')

    def do_OPTIONS(self):
        """Gestisce le preflight requests CORS"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
