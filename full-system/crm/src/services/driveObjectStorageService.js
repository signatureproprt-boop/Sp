'use strict';

const { google } = require('googleapis');
const { Readable } = require('stream');
const { createDriveAuth } = require('./googleDriveClient');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
let driveClient = null;

function getConfig() {
  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!folderId) throw new Error('Google Drive storage requires GOOGLE_DRIVE_FOLDER_ID');
  return { folderId };
}

function getDrive() {
  if (driveClient) return driveClient;
  getConfig();
  // A service account has no storage quota in a user's My Drive. Fail before
  // uploading unless all user OAuth credentials are configured.
  const required = ['SIG_REALTY_GOOGLE_CLIENT_ID', 'SIG_REALTY_GOOGLE_CLIENT_SECRET', 'SIG_REALTY_GOOGLE_REFRESH_TOKEN'];
  if (!required.every((name) => String(process.env[name] || '').trim())) {
    throw new Error(`Google Drive brochure storage requires user OAuth: ${required.join(', ')}`);
  }
  const auth = createDriveAuth(process.env);
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFilesByKey(key) {
  const drive = getDrive();
  const response = await drive.files.list({
    q: `trashed = false and appProperties has { key = 'logicalKey' and value = '${escapeDriveQuery(key)}' }`,
    fields: 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,appProperties,parents)',
    pageSize: 100,
    spaces: 'drive'
  });
  return response.data.files || [];
}

async function ensureFolder(name, parentId) {
  const drive = getDrive();
  const escapedName = escapeDriveQuery(name);
  const response = await drive.files.list({
    q: `trashed = false and mimeType = '${FOLDER_MIME}' and name = '${escapedName}' and '${escapeDriveQuery(parentId)}' in parents`,
    fields: 'files(id,name)',
    pageSize: 10,
    spaces: 'drive'
  });
  if (response.data.files?.[0]) return response.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id'
  });
  return created.data.id;
}

function projectIdFromKey(key) {
  const match = String(key).match(/^builder-projects\/([^/]+)\//);
  return match ? match[1] : 'unassigned';
}

async function putObject(key, buffer, contentType, filename, options = {}) {
  return putObjectStream(key, Readable.from(buffer), contentType, filename, { ...options, size: buffer.length });
}

async function putObjectStream(key, readable, contentType, filename, options = {}) {
  const drive = getDrive();
  const { folderId } = getConfig();
  const projectFolder = await ensureFolder(`Project-${projectIdFromKey(key)}`, folderId);
  const existing = await findFilesByKey(key);

  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const created = await drive.files.create({
    requestBody: {
      name: filename || key.split('/').pop() || 'media.bin',
      parents: [projectFolder],
      appProperties: {
        logicalKey: key,
        projectId: String(metadata.projectId || projectIdFromKey(key)),
        mediaType: String(metadata.mediaType || ''),
        checksum: String(metadata.checksum || ''),
        originalUrl: String(metadata.originalUrl || '')
      },
      description: JSON.stringify({ key, metadata })
    },
    media: { mimeType: contentType || 'application/octet-stream', body: readable },
    fields: 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,appProperties,parents'
  });
  const file = created.data;
  // Do not remove the last valid copy until the replacement exists.
  for (const old of existing) {
    if (old.id !== file.id) {
      try { await drive.files.delete({ fileId: old.id }); }
      catch (error) { console.error('[drive-storage] obsolete file cleanup failed:', error.message); }
    }
  }
  return {
    path: key,
    key,
    size: Number(file.size || options.size || 0),
    contentType: contentType || 'application/octet-stream',
    fileId: file.id,
    webViewLink: file.webViewLink || null,
    webContentLink: file.webContentLink || null
  };
}

async function getObjectInfo(key) {
  const file = (await findFilesByKey(key))[0];
  if (!file) return null;
  return {
    key,
    path: key,
    contentType: file.mimeType || 'application/octet-stream',
    size: Number(file.size || 0),
    filename: file.name,
    uploadDate: file.createdTime || null,
    fileId: file.id,
    webViewLink: file.webViewLink || null,
    webContentLink: file.webContentLink || null,
    metadata: file.appProperties || {}
  };
}

async function findLatestObjectByMetadata(filters = {}) {
  const drive = getDrive();
  const clauses = ["trashed = false"];
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '') continue;
    clauses.push(`appProperties has { key = '${escapeDriveQuery(key)}' and value = '${escapeDriveQuery(value)}' }`);
  }
  if (clauses.length === 1) return null;
  const response = await drive.files.list({
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,appProperties)',
    pageSize: 10,
    spaces: 'drive'
  });
  const file = response.data.files?.[0];
  return file ? {
    key: file.appProperties?.logicalKey,
    path: file.appProperties?.logicalKey,
    fileId: file.id,
    contentType: file.mimeType || 'application/octet-stream',
    size: Number(file.size || 0),
    filename: file.name,
    uploadDate: file.createdTime || null,
    webViewLink: file.webViewLink || null,
    webContentLink: file.webContentLink || null,
    metadata: file.appProperties || {}
  } : null;
}

async function getObject(key) {
  const file = (await findFilesByKey(key))[0];
  if (!file) throw new Error(`Download failed: HTTP 404 (object not found: ${key})`);
  const response = await getDrive().files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(response.data), contentType: file.mimeType || 'application/octet-stream', size: Number(file.size || response.data.byteLength) };
}

async function getObjectStream(key) {
  const object = await getObject(key);
  return { stream: Readable.from(object.buffer), contentType: object.contentType, size: object.size, filename: key.split('/').pop() };
}

async function deleteObject(key) {
  const files = await findFilesByKey(key);
  for (const file of files) await getDrive().files.delete({ fileId: file.id });
  return { deleted: files.length };
}

function resetForTests() { driveClient = null; }

module.exports = {
  putObject,
  putObjectStream,
  getObject,
  getObjectStream,
  getObjectInfo,
  findLatestObjectByMetadata,
  deleteObject,
  resetForTests
};
