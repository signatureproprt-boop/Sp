'use strict';

// Move JPG/PNG files in the Builder Projects folder tree to Drive Trash.
// Scan the complete tree before changing any file. Folders and PDFs are kept.
const { google } = require('googleapis');
const { createDriveAuth } = require('../src/services/googleDriveClient');

const ROOT_ID = '1_Y-siVnZu9rAmkwGbG3OSdIpQ82jTCLD';
const FOLDER = 'application/vnd.google-apps.folder';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

function isTarget(file) {
  if (!IMAGE_MIMES.has(file.mimeType)) return false;
  const name = String(file.name || '').toLowerCase();
  return !name.endsWith('.pdf');
}

async function listChildren(drive, parentId) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `trashed = false and '${parentId}' in parents`,
      fields: 'nextPageToken,files(id,name,mimeType,parents)',
      pageSize: 1000, pageToken, supportsAllDrives: true,
      includeItemsFromAllDrives: true
    }, { timeout: 120000 });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function main() {
  if (process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID !== ROOT_ID) {
    throw new Error('Builder Projects root ID mismatch; no files were changed');
  }
  const apply = process.argv.includes('--apply');
  const drive = google.drive({ version: 'v3', auth: createDriveAuth() });
  const root = await drive.files.get({ fileId: ROOT_ID, fields: 'id,mimeType,trashed' });
  if (root.data.trashed || root.data.mimeType !== FOLDER) throw new Error('Builder Projects root is unavailable');
  const queue = [ROOT_ID];
  const visited = new Set();
  const targets = [];
  let scanned = 0;
  while (queue.length) {
    const folderId = queue.shift();
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    const children = await listChildren(drive, folderId);
    for (const file of children) {
      scanned++;
      if (file.mimeType === FOLDER) queue.push(file.id);
      else if (isTarget(file)) targets.push({ id: file.id, name: file.name, parentId: folderId });
    }
    if (visited.size % 100 === 0) console.log(`IMAGE_SCAN=${JSON.stringify({ folders: visited.size, scanned, candidates: targets.length })}`);
  }
  console.log(`IMAGE_SCAN_RESULT=${JSON.stringify({ folders: visited.size, scanned, candidates: targets.length, sample: targets.slice(0, 5) })}`);
  if (!apply) return;
  let trashed = 0;
  let skipped = 0;
  for (const file of targets) {
    // Verify each candidate still belongs to a scanned folder and is an image.
    const latest = await drive.files.get({ fileId: file.id, fields: 'id,name,mimeType,parents,trashed', supportsAllDrives: true });
    if (latest.data.trashed || !latest.data.parents?.includes(file.parentId) || !isTarget(latest.data)) {
      skipped++;
      continue;
    }
    await drive.files.update({ fileId: file.id, requestBody: { trashed: true }, fields: 'id,trashed', supportsAllDrives: true });
    trashed++;
    if (trashed % 100 === 0) console.log(`IMAGE_TRASH_PROGRESS=${JSON.stringify({ trashed, skipped, candidates: targets.length })}`);
  }
  console.log(`IMAGE_TRASH_RESULT=${JSON.stringify({ folders: visited.size, scanned, candidates: targets.length, trashed, skipped })}`);
}

if (require.main === module) main().catch(error => {
  console.error(`IMAGE_TRASH_FAILED=${String(error.message || error).slice(0, 300)}`);
  process.exitCode = 1;
});

module.exports = { isTarget, listChildren };
