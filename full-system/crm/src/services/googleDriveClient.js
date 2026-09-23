'use strict';

const { google } = require('googleapis');

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
    }
  };
}

module.exports = { createGoogleDriveClient };
