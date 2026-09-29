'use strict';

const { google } = require('googleapis');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_DRIVE_REQUEST_TIMEOUT_MS = 30000;
const MAX_DRIVE_REQUEST_TIMEOUT_MS = 120000;

function createDriveAuth(env = process.env) {
  const clientId = String(env.SIG_REALTY_GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.SIG_REALTY_GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.SIG_REALTY_GOOGLE_REFRESH_TOKEN || '').trim();
  const values = [clientId, clientSecret, refreshToken];
  const configured = values.every(Boolean);

  if (!configured && values.some(Boolean)) {
    throw new Error('Incomplete Google OAuth configuration: SIG_REALTY_GOOGLE_CLIENT_ID, SIG_REALTY_GOOGLE_CLIENT_SECRET, and SIG_REALTY_GOOGLE_REFRESH_TOKEN must all be set');
  }
  if (configured) {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    return auth;
  }
  return new google.auth.GoogleAuth({ scopes: [DRIVE_SCOPE] });
}

function createBufferStream(buffer) {
  const { Readable } = require('stream');
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  return Readable.from([value]);
}

function driveRequestTimeoutMs(env = process.env) {
  const configured = Number(env.SIG_REALTY_GOOGLE_DRIVE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_DRIVE_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_DRIVE_REQUEST_TIMEOUT_MS, Math.max(1000, Math.floor(configured)));
}

function createGoogleDriveClient({ env = process.env, driveFactory = google.drive } = {}) {
  const auth = createDriveAuth(env);
  const drive = driveFactory({ version: 'v3', auth });
  const requestOptions = { timeout: driveRequestTimeoutMs(env) };

  return {
    async listFilesInFolder(parentId) {
      if (!parentId) throw new Error('A parent folder is required for Drive file listing');
      const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const files = [];
      let pageToken;
      do {
        const res = await drive.files.list({
          q: `trashed = false and '${escape(parentId)}' in parents`,
          fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,webViewLink,webContentLink,parents)',
          pageSize: 100,
          pageToken
        }, requestOptions);
        files.push(...(res.data.files || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return files;
    },
    async findFolder(name, parentId) {
      if (!parentId) throw new Error('A parent folder is required for Drive folder lookup');
      const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const res = await drive.files.list({
        q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escape(name)}' and '${escape(parentId)}' in parents`,
        fields: 'files(id,name,webViewLink)',
        orderBy: 'createdTime asc',
        pageSize: 1
      }, requestOptions);
      const folder = res.data.files?.[0];
      return folder ? {
        id: folder.id,
        name: folder.name,
        url: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`
      } : null;
    },
    async createFolder(name, parentId) {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId ? [parentId] : undefined
        },
        fields: 'id,name,webViewLink'
      }, requestOptions);
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
      }, requestOptions);
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

module.exports = {
  createGoogleDriveClient,
  createBufferStream,
  createDriveAuth,
  driveRequestTimeoutMs,
  DEFAULT_DRIVE_REQUEST_TIMEOUT_MS
};
