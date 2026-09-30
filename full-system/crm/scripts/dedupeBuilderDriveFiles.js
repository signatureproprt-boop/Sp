'use strict';

// Trash only byte-identical, unreferenced copies inside folders for the same
// CRM ProjectID and media category. Dry run unless --apply is supplied.
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
const fs = require('node:fs');
const checkpointPath = process.argv.includes('--apply')
  ? 'builder-drive-apply-scan-checkpoint.json'
  : 'builder-drive-scan-checkpoint.json';

const apply = process.argv.includes('--apply');
const rootId = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID;
const mongoUrl = process.env.MONGO_URL;
if (!rootId || !mongoUrl) throw new Error('Drive root ID and MONGO_URL are required');

async function listAll(drive) {
  let checkpoint;
  try { checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch (_) {}
  const result = Array.isArray(checkpoint?.files) ? checkpoint.files : [];
  let pageToken = checkpoint?.nextPageToken;
  let pages = Number(checkpoint?.pages || 0);
  if (checkpoint?.complete) {
    console.error(`DEDUPE_PROGRESS=using_complete_checkpoint,items:${result.length}`);
    return result;
  }
  do {
    let response;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        response = await drive.files.list({
          q: 'trashed = false',
          fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,parents)',
          pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true
        }, { timeout: 60000 });
        break;
      } catch (error) {
        console.error(`DEDUPE_PROGRESS=drive_retry,page:${pages + 1},attempt:${attempt}`);
        if (attempt === 4) throw error;
      }
    }
    result.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
    pages++;
    console.error(`DEDUPE_PROGRESS=drive_pages:${pages},items:${result.length}`);
    const saved = { files: result, nextPageToken: pageToken || null, pages, complete: !pageToken };
    fs.writeFileSync(checkpointPath + '.tmp', JSON.stringify(saved));
    fs.renameSync(checkpointPath + '.tmp', checkpointPath);
  } while (pageToken);
  return result;
}

function referencedIds(snapshot) {
  const ids = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, item] of Object.entries(value)) {
      if (/^DriveFileID$/i.test(key) && item) ids.add(String(item));
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(snapshot);
  return ids;
}

async function main() {
  console.error('DEDUPE_PROGRESS=connecting_mongo');
  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    console.error('DEDUPE_PROGRESS=reading_crm_snapshot');
    const snapshot = await client.db(process.env.MONGO_DB || 'signature_properties')
      .collection('db_snapshot').findOne({ _id: 'singleton' }, { maxTimeMS: 30000 });
    const projects = snapshot?.payload?.BuilderProjects;
    if (!Array.isArray(projects)) throw new Error('CRM BuilderProjects snapshot unavailable');
    const ids = referencedIds(snapshot.payload);
    const snapshotText = JSON.stringify(snapshot.payload);
    const validProjects = new Set(projects.map(p => String(p.ProjectID || '')).filter(Boolean));
    const drive = google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    }) });
    console.error(`DEDUPE_PROGRESS=listing_drive,projects:${validProjects.size}`);
    const allFiles = await listAll(drive);
    // An interrupted apply must re-scan after any files were trashed.
    if (apply) fs.unlinkSync(checkpointPath);
    const byId = new Map(allFiles.map(file => [file.id, file]));
    const rootFolders = allFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder' &&
      (f.parents || []).includes(rootId));
    const rootFolderIds = new Set(rootFolders.map(f => f.id));
    const groups = new Map();
    for (const file of allFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      const child = byId.get((file.parents || [])[0]);
      const folder = byId.get((child?.parents || [])[0]);
      if (!child || !folder || !rootFolderIds.has(folder.id)) continue;
      const projectId = String(folder.name || '').replace(/^Project-/, '').split(' ')[0];
      if (!validProjects.has(projectId)) continue;
      if (child.mimeType !== 'application/vnd.google-apps.folder') continue;
      // Checksum proves equal bytes; no checksum means no deletion.
      if (!file.md5Checksum || !Number(file.size)) continue;
      const key = JSON.stringify([projectId, child.name, file.name, file.size, file.md5Checksum]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }
    const actions = [];
    for (const [key, files] of groups) {
      if (files.length < 2) continue;
      const linked = files.filter(f => ids.has(f.id) || snapshotText.includes(f.id));
      const keep = linked[0] || files.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
      for (const file of files) {
        if (file.id === keep.id || ids.has(file.id) || snapshotText.includes(file.id)) continue;
        actions.push({ fileId: file.id, keepId: keep.id, projectId: JSON.parse(key)[0], name: file.name });
      }
    }
    // Never delete from an incomplete snapshot or while a link may be written concurrently.
    // Re-read the snapshot just before each trash operation to protect new links.
    console.error(`DEDUPE_PROGRESS=candidates:${actions.length}`);
    let trashed = 0;
    if (apply) for (const action of actions) {
      const fresh = await client.db(process.env.MONGO_DB || 'signature_properties')
        .collection('db_snapshot').findOne({ _id: 'singleton' }, { maxTimeMS: 30000 });
      if (!Array.isArray(fresh?.payload?.BuilderProjects) ||
          referencedIds(fresh.payload).has(action.fileId) ||
          JSON.stringify(fresh.payload).includes(action.fileId)) continue;
      await drive.files.update({ fileId: action.fileId, requestBody: { trashed: true }, supportsAllDrives: true });
      trashed++;
    }
    fs.writeFileSync('builder-drive-dedupe-report.json', JSON.stringify({ dryRun: !apply, actions }, null, 2));
    console.log(JSON.stringify({ dryRun: !apply, scannedProjectFolders: rootFolders.length,
      candidateCopies: actions.length, trashed, report: 'builder-drive-dedupe-report.json', examples: actions.slice(0, 5) }));
  } finally { await client.close(); }
}

main().catch(error => {
  console.error('DEDUPE_FAILED=' + String(error.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted]'));
  process.exitCode = 1;
});
