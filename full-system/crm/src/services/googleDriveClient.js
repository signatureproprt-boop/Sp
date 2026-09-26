'use strict';

const { google } = require('googleapis');

function createBufferStream(buffer) {
  const { Readable } = require('stream');
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  return Readable.from([value]);
}

function createGoogleDriveClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const drive = google.drive({ version: 'v3', auth });

  return {
    async createFolder(name, parentId) {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId ? [parentId] : undefined
        },
        fields: 'id,name,webViewLink'
      });
      return {
        id: res.data.id,
        name: res.data.name,
        url: res.data.webViewLink || (res.data.id ? `https://drive.google.com/drive/folders/${res.data.id}` : null)
      };
    },
    async uploadBuffer(filename, buffer, parentId, mimeType = 'application/octet-stream') {
      const res = await drive.files.create({
        requestBody: {
          name: filename,
          parents: parentId ? [parentId] : undefined
        },
        media: {
          mimeType,
          body: createBufferStream(buffer)
        },
        fields: 'id,name,webViewLink,webContentLink,mimeType,size'
      });
      return {
        id: res.data.id,
        name: res.data.name,
        url: res.data.webViewLink || (res.data.id ? `https://drive.google.com/file/d/${res.data.id}/view` : null),
        downloadUrl: res.data.webContentLink || null,
        mimeType: res.data.mimeType || mimeType,
        size: Number(res.data.size || buffer?.length || 0)
      };
    }
  };
}

module.exports = { createGoogleDriveClient, createBufferStream };
