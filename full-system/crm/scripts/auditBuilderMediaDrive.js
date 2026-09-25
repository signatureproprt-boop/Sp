'use strict';

// Read-only comparison of BuilderProjects media references with files visible in Drive.
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');

async function listAll(drive, q, fields) {
  const out = [];
  let pageToken;
  do {
    const response = await drive.files.list({
      q, fields: `nextPageToken,files(${fields})`, pageSize: 1000,
      pageToken, spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    out.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function main() {
  const url = String(process.env.MONGO_URL || '').trim();
  const rootId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!url || !rootId) throw new Error('MONGO_URL and GOOGLE_DRIVE_FOLDER_ID are required');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const snap = await client.db(process.env.MONGO_DB || 'signature_properties')
      .collection('db_snapshot').findOne({ _id: 'singleton' }, { projection: { 'payload.BuilderProjects': 1 } });
    const projects = snap?.payload?.BuilderProjects;
    if (!Array.isArray(projects)) throw new Error('BuilderProjects snapshot unavailable');
    const drive = google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    }) });
    const folders = await listAll(drive,
      `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${rootId.replace(/'/g, "\\'")}' in parents`,
      'id,name');
    const byProjectId = new Map(projects.map(p => [String(p.ProjectID), p]));
    let files = 0, pdfs = 0, placeholders = 0, sameNameAndSizeExtra = 0, foldersWithoutProject = 0;
    let mediaWithDriveId = 0, mediaWithoutDriveId = 0;
    const fileIds = new Set();
    const anomalies = [];
    for (const project of projects) {
      for (const field of ['Photos', 'FloorPlans', 'Brochures', 'Videos']) {
        for (const row of Array.isArray(project[field]) ? project[field] : []) {
          if (row?.DriveFileID) { mediaWithDriveId++; fileIds.add(String(row.DriveFileID)); }
          else mediaWithoutDriveId++;
        }
      }
    }
    let matchingProjectFolders = 0;
    for (const folder of folders) {
      const projectId = String(folder.name || '').replace(/^Project-/, '').split(' ')[0];
      if (byProjectId.has(projectId)) matchingProjectFolders++;
      else if (/^Project-/.test(folder.name || '')) foldersWithoutProject++;
      const list = await listAll(drive, `trashed = false and '${folder.id}' in parents`,
        'id,name,mimeType,size');
      const seen = new Set();
      let folderPlaceholders = 0, folderDuplicates = 0, folderPdf = 0, unlinked = 0;
      for (const file of list) {
        if (file.mimeType === 'application/vnd.google-apps.folder') continue;
        files++;
        if (file.mimeType === 'application/pdf') { pdfs++; folderPdf++; }
        if (/^(pdfimg|loader-image)\.png$/i.test(file.name || '')) { placeholders++; folderPlaceholders++; }
        const key = String(file.name || '') + ':' + String(file.size || '');
        if (seen.has(key)) { sameNameAndSizeExtra++; folderDuplicates++; }
        else seen.add(key);
        if (!fileIds.has(String(file.id))) unlinked++;
      }
      if (folderPlaceholders || folderDuplicates || folderPdf || (list.length && !byProjectId.has(projectId))) {
        anomalies.push({ folder: folder.name, count: list.length, placeholders: folderPlaceholders,
          sameNameAndSizeExtra: folderDuplicates, pdfs: folderPdf, unlinkedDriveFiles: unlinked,
          crmProjectFound: byProjectId.has(projectId) });
      }
    }
    console.log('BUILDER_MEDIA_AUDIT=' + JSON.stringify({
      dryRun: true, writes: 0, crmProjects: projects.length, crmMediaWithDriveId: mediaWithDriveId,
      crmMediaWithoutDriveId: mediaWithoutDriveId, rootProjectFolders: folders.filter(f => /^Project-/.test(f.name || '')).length,
      matchingProjectFolders, foldersWithoutProject, files, pdfs, placeholders,
      sameNameAndSizeExtra, anomalies
    }));
  } finally { await client.close(); }
}
main().catch(error => { console.error('BUILDER_MEDIA_AUDIT_FAILED=' + String(error.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted]')); process.exitCode = 1; });
