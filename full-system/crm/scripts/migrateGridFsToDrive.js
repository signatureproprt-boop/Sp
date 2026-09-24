'use strict';

const { MongoClient, GridFSBucket } = require('mongodb');
const { google } = require('googleapis');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BUCKET_NAME = 'signature_objects';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function env(name, required = false) {
  const value = String(process.env[name] || '').trim();
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function projectIdFromKey(key) {
  const match = String(key || '').match(/^builder-projects\/([^/]+)\//);
  return match ? match[1] : 'unassigned';
}

async function ensureFolder(drive, name, parentId) {
  const response = await drive.files.list({
    q: `trashed = false and mimeType = '${FOLDER_MIME}' and name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents`,
    fields: 'files(id,name)',
    pageSize: 10,
    spaces: 'drive'
  });
  if (response.data.files?.[0]) return response.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id'
  });
  if (!created.data.id) throw new Error(`Failed to create Drive folder: ${name}`);
  return created.data.id;
}

async function findDriveFilesByKey(drive, key) {
  const response = await drive.files.list({
    q: `trashed = false and appProperties has { key = 'logicalKey' and value = '${escapeDriveQuery(key)}' }`,
    fields: 'files(id,name,mimeType,size,appProperties,parents,webViewLink,webContentLink)',
    pageSize: 100,
    spaces: 'drive'
  });
  return response.data.files || [];
}

async function uploadFromGridFs({ drive, bucket, file, rootFolderId }) {
  const key = file.filename;
  const existing = await findDriveFilesByKey(drive, key);
  if (existing.length) {
    const candidate = existing[0];
    const sameSize = Number(candidate.size || 0) === Number(file.length || 0);
    if (sameSize) return { status: 'already-present', file: candidate };
  }

  const projectId = projectIdFromKey(key);
  const projectFolderId = await ensureFolder(drive, `Project-${projectId}`, rootFolderId);
  const metadata = file.metadata && typeof file.metadata === 'object' ? file.metadata : {};
  const originalFilename = metadata.originalFilename || key.split('/').pop() || 'media.bin';
  const mimeType = metadata.contentType || 'application/octet-stream';

  const stream = bucket.openDownloadStream(file._id);
  const created = await drive.files.create({
    requestBody: {
      name: originalFilename,
      parents: [projectFolderId],
      appProperties: {
        logicalKey: key,
        projectId: String(metadata.projectId || projectId),
        mediaType: String(metadata.mediaType || ''),
        checksum: String(metadata.checksum || ''),
        originalUrl: String(metadata.originalUrl || '')
      },
      description: JSON.stringify({ key, migratedFrom: 'MongoGridFS', metadata })
    },
    media: { mimeType, body: stream },
    fields: 'id,name,mimeType,size,webViewLink,webContentLink,appProperties,parents'
  });

  const uploaded = created.data;
  const uploadedSize = Number(uploaded.size || 0);
  if (uploadedSize !== Number(file.length || 0)) {
    if (uploaded.id) {
      try { await drive.files.delete({ fileId: uploaded.id }); } catch (_) {}
    }
    throw new Error(`Drive size verification failed for ${key}: expected ${file.length}, got ${uploadedSize}`);
  }

  return { status: 'uploaded', file: uploaded };
}

async function main() {
  const mongoUrl = env('MONGO_URL', true);
  const mongoDb = env('MONGO_DB') || 'signature_properties';
  const rootFolderId = env('GOOGLE_DRIVE_FOLDER_ID', true);
  const dryRun = boolEnv('DRIVE_BACKFILL_DRY_RUN', true);
  const deleteAfterVerify = boolEnv('DRIVE_BACKFILL_DELETE_GRIDFS_AFTER_VERIFY', false);
  const limit = intEnv('DRIVE_BACKFILL_LIMIT', 10000);

  if (!dryRun && deleteAfterVerify && !boolEnv('DRIVE_BACKFILL_I_UNDERSTAND_DELETE', false)) {
    throw new Error('Refusing GridFS deletion: set DRIVE_BACKFILL_I_UNDERSTAND_DELETE=true after a successful dry run');
  }

  const client = new MongoClient(mongoUrl, {
    retryWrites: true,
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 120000
  });
  await client.connect();

  const db = client.db(mongoDb);
  const bucket = new GridFSBucket(db, { bucketName: BUCKET_NAME });
  const auth = new google.auth.GoogleAuth({ scopes: [DRIVE_SCOPE] });
  const drive = google.drive({ version: 'v3', auth });

  const files = await bucket.find({}).sort({ uploadDate: 1 }).limit(limit).toArray();
  const summary = {
    total: files.length,
    dryRun,
    deleteAfterVerify,
    uploaded: 0,
    alreadyPresent: 0,
    deletedGridFs: 0,
    failed: 0,
    bytesVerified: 0,
    errors: []
  };

  for (const file of files) {
    const key = file.filename;
    try {
      if (dryRun) {
        const existing = await findDriveFilesByKey(drive, key);
        const verified = existing.find((item) => Number(item.size || 0) === Number(file.length || 0));
        if (verified) {
          summary.alreadyPresent += 1;
          summary.bytesVerified += Number(file.length || 0);
          console.log(JSON.stringify({ key, status: 'already-present', bytes: file.length }));
        } else {
          console.log(JSON.stringify({ key, status: 'would-upload', bytes: file.length }));
        }
        continue;
      }

      const result = await uploadFromGridFs({ drive, bucket, file, rootFolderId });
      if (result.status === 'uploaded') summary.uploaded += 1;
      else summary.alreadyPresent += 1;
      summary.bytesVerified += Number(file.length || 0);

      if (deleteAfterVerify) {
        await bucket.delete(file._id);
        summary.deletedGridFs += 1;
      }

      console.log(JSON.stringify({
        key,
        status: result.status,
        driveFileId: result.file?.id || null,
        bytes: file.length,
        gridFsDeleted: deleteAfterVerify
      }));
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ key, message: String(error.message || error).slice(0, 300) });
      console.error(JSON.stringify({ key, status: 'failed', error: String(error.message || error) }));
    }
  }

  console.log('MIGRATION_SUMMARY=' + JSON.stringify(summary));
  await client.close();

  if (summary.failed) process.exitCode = 2;
}

main().catch((error) => {
  console.error('[gridfs-drive-backfill] fatal:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
