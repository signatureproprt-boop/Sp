'use strict';

const { MongoClient, GridFSBucket } = require('mongodb');
const { google } = require('googleapis');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMongoError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '').toLowerCase();
  return name.includes('MongoNetwork') || name.includes('MongoServerSelection') || name.includes('MongoSocket') || message.includes('timed out') || message.includes('connection') && message.includes('closed');
}

function isRetryableDriveError(error) {
  const status = Number(error?.response?.status || error?.code || 0);
  const message = String(error?.message || error || '').toLowerCase();

  return status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    message.includes('request timeout') ||
    message.includes('timed out') ||
    message.includes('socket hang up') ||
    message.includes('econnreset');
}

async function readGridFsToBuffer(bucket, file) {
  const chunks = [];
  let total = 0;
  const stream = bucket.openDownloadStream(file._id);
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  if (total !== Number(file.length || 0)) {
    throw new Error(`GridFS read verification failed for ${file.filename}: expected ${file.length}, got ${total}`);
  }
  return Buffer.concat(chunks, total);
}

async function createDriveFileFromGridFs({ drive, bucket, file, projectFolderId, metadata, originalFilename, mimeType }) {
  // Google returned HTTP 408 when a large GridFS stream was proxied directly
  // into Drive for several minutes. Stage large objects in memory first so
  // the Drive request receives bytes immediately instead of waiting on Mongo.
  const largeFileThreshold = 8 * 1024 * 1024;
  const body = Number(file.length || 0) >= largeFileThreshold
    ? await readGridFsToBuffer(bucket, file)
    : bucket.openDownloadStream(file._id);
  const stream = Buffer.isBuffer(body) ? null : body;
  let streamError = null;
  stream.once('error', (error) => { streamError = error; });
  try {
    const created = await drive.files.create({
      requestBody: {
        name: originalFilename,
        parents: [projectFolderId],
        appProperties: {
          logicalKey: file.filename,
          projectId: String(metadata.projectId || projectIdFromKey(file.filename)),
          mediaType: String(metadata.mediaType || ''),
          checksum: String(metadata.checksum || ''),
          originalUrl: String(metadata.originalUrl || '')
        },
        description: JSON.stringify({ key: file.filename, migratedFrom: 'MongoGridFS', metadata })
      },
      media: { mimeType, body },
      fields: 'id,name,mimeType,size,webViewLink,webContentLink,appProperties,parents'
    }, {
      // Large GridFS PDFs can take several minutes to upload. The default
      // HTTP timeout was causing Google Drive 408 responses around 6 minutes.
      // Disable the client-side request timeout for this migration; the
      // existing retry + exact-size verification remain the safety boundary.
      timeout: 0,
      retry: false
    });
    if (streamError) throw streamError;
    return created;
  } finally {
    if (stream) stream.destroy();
  }
}

async function uploadFromGridFs({ drive, bucket, file, rootFolderId, readRetries = 4, retryDelayMs = 5000 }) {
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

  let created;
  let lastError;
  for (let attempt = 1; attempt <= readRetries; attempt += 1) {
    try {
      created = await createDriveFileFromGridFs({ drive, bucket, file, projectFolderId, metadata, originalFilename, mimeType });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const retryableMongo = isRetryableMongoError(error);
      const retryableDrive = isRetryableDriveError(error);
      if ((!retryableMongo && !retryableDrive) || attempt === readRetries) break;
      console.error(JSON.stringify({
        key,
        status: retryableDrive ? 'retrying-drive-upload' : 'retrying-gridfs-read',
        attempt,
        maxAttempts: readRetries,
        error: String(error.message || error)
      }));
      await sleep(retryDelayMs * attempt);
    }
  }
  if (lastError) throw lastError;

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


function collectLinkedDriveIds(payload) {
  const links = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const key = String(value.StoragePath || value.storagePath || '').trim();
    const id = String(value.DriveFileID || value.DriveFileId || value.driveFileId || '').trim();
    if (key && id) {
      if (!links.has(key)) links.set(key, new Set());
      links.get(key).add(id);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(payload);
  return links;
}

async function main() {
  const mongoUrl = env('MONGO_URL', true);
  const mongoDb = env('MONGO_DB') || 'signature_properties';
  const rootFolderId = env('GOOGLE_DRIVE_FOLDER_ID', true);
  const dryRun = boolEnv('DRIVE_BACKFILL_DRY_RUN', true);
  const deleteAfterVerify = boolEnv('DRIVE_BACKFILL_DELETE_GRIDFS_AFTER_VERIFY', false);
  const limit = intEnv('DRIVE_BACKFILL_LIMIT', 10000);
  const readRetries = intEnv('DRIVE_BACKFILL_READ_RETRIES', 4);
  const retryDelayMs = intEnv('DRIVE_BACKFILL_RETRY_DELAY_MS', 5000);

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
  const oauthClientId = env('SIG_REALTY_GOOGLE_CLIENT_ID');
  const oauthClientSecret = env('SIG_REALTY_GOOGLE_CLIENT_SECRET');
  const oauthRefreshToken = env('SIG_REALTY_GOOGLE_REFRESH_TOKEN');

  const oauthValues = [oauthClientId, oauthClientSecret, oauthRefreshToken];
  const oauthConfigured = oauthValues.every(Boolean);
  if (!oauthConfigured && oauthValues.some(Boolean)) {
    throw new Error('Incomplete Google OAuth configuration: SIG_REALTY_GOOGLE_CLIENT_ID, SIG_REALTY_GOOGLE_CLIENT_SECRET, and SIG_REALTY_GOOGLE_REFRESH_TOKEN must all be set');
  }

  let auth;
  if (oauthConfigured) {
    auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    auth.setCredentials({ refresh_token: oauthRefreshToken });
    console.log('[gridfs-drive-backfill] Drive auth: OAuth2 user refresh token');
  } else {
    auth = new google.auth.GoogleAuth({ scopes: [DRIVE_SCOPE] });
    console.log('[gridfs-drive-backfill] Drive auth: application default credentials');
  }
  const drive = google.drive({ version: 'v3', auth });

  const snapshot = await db.collection('db_snapshot').findOne({ _id: 'singleton' }, { projection: { payload: 1 } });
  if (!snapshot?.payload) throw new Error('CRM snapshot missing; refusing migration');
  const linkedDriveIds = collectLinkedDriveIds(snapshot.payload);
  const files = await bucket.find({}).sort({ uploadDate: 1 }).limit(limit).toArray();
  const summary = {
    total: files.length,
    dryRun,
    deleteAfterVerify,
    uploaded: 0,
    alreadyPresent: 0,
    eligibleForDeletion: 0,
    blockedUnlinked: 0,
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
        const linked = verified && linkedDriveIds.get(key)?.has(verified.id);
        if (linked) summary.eligibleForDeletion += 1;
        else summary.blockedUnlinked += 1;
        if (verified) {
          summary.alreadyPresent += 1;
          summary.bytesVerified += Number(file.length || 0);
          console.log(JSON.stringify({ key, status: 'already-present', bytes: file.length, crmLinked: Boolean(linked) }));
        } else {
          console.log(JSON.stringify({ key, status: 'would-upload', bytes: file.length, crmLinked: false }));
        }
        continue;
      }

      const result = await uploadFromGridFs({ drive, bucket, file, rootFolderId, readRetries, retryDelayMs });
      if (result.status === 'uploaded') summary.uploaded += 1;
      else summary.alreadyPresent += 1;
      summary.bytesVerified += Number(file.length || 0);

      const crmLinked = linkedDriveIds.get(key)?.has(result.file?.id);
      if (crmLinked) summary.eligibleForDeletion += 1;
      else summary.blockedUnlinked += 1;
      if (deleteAfterVerify && crmLinked) {
        await bucket.delete(file._id);
        summary.deletedGridFs += 1;
      }

      console.log(JSON.stringify({
        key,
        status: result.status,
        driveFileId: result.file?.id || null,
        bytes: file.length,
        crmLinked: Boolean(crmLinked),
        gridFsDeleted: Boolean(deleteAfterVerify && crmLinked)
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
