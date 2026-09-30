'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { KarmaGroupScraperService } = require('../src/services/karmaGroupScraperService');
const { resolveProjectFolder } = require('../src/services/driveObjectStorageService');

function repoWith(db) {
  let seq = 0;
  return {
    read: () => db,
    write: () => {},
    createId: (prefix) => `${prefix}-TEST-${++seq}`
  };
}

async function drain(stream) {
  // eslint-disable-next-line no-unused-vars
  for await (const _chunk of stream) { /* consume */ }
}

function driveStore(calls) {
  return {
    async putObjectStream(key, stream, contentType, filename, options) {
      await drain(stream);
      calls.push({ key, contentType, filename, options });
      return {
        path: key,
        key,
        size: 2048,
        contentType,
        fileId: 'DRIVE-FILE-1',
        webViewLink: 'https://drive.google.com/file/d/DRIVE-FILE-1/view',
        webContentLink: 'https://drive.google.com/uc?id=DRIVE-FILE-1&export=download'
      };
    }
  };
}

const okPdfStream = async () => ({ ok: true, stream: Readable.from(Buffer.from('%PDF-1.4 test')) });

test('brochure ingest saves the Drive file id and web-view/web-content links on the record', async () => {
  const calls = [];
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), {
    ingestMedia: false,
    ingestBrochures: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: driveStore(calls)
  });
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Alpha', DriveFolderID: 'existing-project-folder', Brochures: [] };

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(out.driveFileId, 'DRIVE-FILE-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'builder-projects/BLDP-1/brochures/alpha.pdf');
  assert.equal(calls[0].options.metadata.mediaType, 'brochure');
  assert.equal(calls[0].options.metadata.projectFolderId, 'existing-project-folder');

  const rec = project.Brochures[0];
  assert.equal(rec.DriveFileId, 'DRIVE-FILE-1');
  assert.equal(rec.DriveFileID, 'DRIVE-FILE-1');
  assert.equal(rec.DriveWebViewLink, 'https://drive.google.com/file/d/DRIVE-FILE-1/view');
  assert.equal(rec.DriveWebContentLink, 'https://drive.google.com/uc?id=DRIVE-FILE-1&export=download');
  assert.equal(rec.StoragePath, 'builder-projects/BLDP-1/brochures/alpha.pdf');
  assert.equal(rec.storageType, 'google-drive');
  assert.equal(rec.verified, true);
  assert.equal(rec.downloadStatus, 'downloaded');
  assert.equal(rec.Source, 'KarmaGroupScrape');
});

test('brochure ingest requests uncapped streaming while preserving Drive upload', async () => {
  let requestedMax;
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), {
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: async (_url, options) => {
      requestedMax = options.maxBytes;
      return okPdfStream();
    },
    objectStorage: driveStore([])
  });
  const out = await svc._ingestBrochure({ ProjectID: 'BLDP-2', ProjectName: 'Large', Brochures: [] }, 'https://karmagroup.co.in/large.pdf');
  assert.equal(out.ok, true);
  assert.equal(requestedMax, Infinity);
});

test('recovers an already uploaded Drive brochure after CRM save was interrupted', async () => {
  let downloads = 0;
  let uploads = 0;
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), {
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: async () => { downloads++; return okPdfStream(); },
    objectStorage: {
      findExistingBrochure: async (key, source) => {
        assert.match(key, /^builder-projects\/BLDP-RECOVER\/brochures\//);
        assert.equal(source, 'https://karmagroup.co.in/recover.pdf');
        return { fileId: 'PREVIOUS-UPLOAD', path: key, size: 123, recovered: true };
      },
      putObjectStream: async () => { uploads++; throw new Error('Unexpected duplicate upload'); }
    }
  });
  const project = { ProjectID: 'BLDP-RECOVER', ProjectName: 'Recover', BrochureUrl: 'https://karmagroup.co.in/recover.pdf', Brochures: [] };
  const out = await svc._ingestBrochure(project, project.BrochureUrl);
  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(out.driveFileId, 'PREVIOUS-UPLOAD');
  assert.equal(project.Brochures[0].verified, true);
  assert.equal(project.BrochureUrl, null);
  assert.equal(downloads, 0);
  assert.equal(uploads, 0);
});

test('Drive upload reuses the exact project folder and rejects ambiguous duplicates', async () => {
  const files = [{ id: 'folder-1', name: 'BLDP-1 Alpha' }];
  const drive = { files: {
    list: async () => ({ data: { files } }),
    create: async () => { throw new Error('Unexpected duplicate project folder'); }
  } };
  assert.equal(await resolveProjectFolder(drive, 'root', 'BLDP-1', null), 'folder-1');
  files.push({ id: 'folder-2', name: 'Project-BLDP-1 Alpha' });
  await assert.rejects(resolveProjectFolder(drive, 'root', 'BLDP-1', null), /Multiple project folders/);
});

test('brochure ingest refuses GridFS fallback when Drive is not the configured provider', async () => {
  let touched = false;
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), {
    ingestBrochures: true,
    isDriveStorageConfigured: () => false,
    openPdfStreamSafely: async () => { touched = true; return okPdfStream(); },
    objectStorage: { putObjectStream: async () => { touched = true; return { path: 'x' }; } }
  });
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Alpha', Brochures: [] };

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, false);
  assert.match(out.error, /Google Drive storage is required/);
  assert.match(out.error, /refusing GridFS fallback/);
  assert.equal(touched, false, 'must not download or upload when Drive is required but unconfigured');
  assert.equal(project.Brochures.length, 0);
});

test('brochure ingest is retry-safe: an already-stored Drive brochure is reused without a second upload', async () => {
  let uploads = 0;
  const project = {
    ProjectID: 'BLDP-1',
    ProjectName: 'Alpha',
    Brochures: [{
      OriginalUrl: 'https://karmagroup.co.in/files/alpha.pdf',
      verified: true,
      DriveFileId: 'EXISTING-FILE',
      DriveWebViewLink: 'https://drive.google.com/file/d/EXISTING-FILE/view',
      StoragePath: 'builder-projects/BLDP-1/brochures/alpha.pdf'
    }]
  };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    ingestBrochures: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: async () => { uploads += 1; return okPdfStream(); },
    objectStorage: { putObjectStream: async () => { uploads += 1; return { path: 'x' }; } }
  });

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(uploads, 0, 'no duplicate Drive file created on retry');
  assert.equal(project.Brochures.length, 1);
  assert.equal(project.Brochures[0].DriveFileId, 'EXISTING-FILE');
});

test('a verified GridFS brochure is uploaded to Drive instead of being reused', async () => {
  const calls = [];
  const sourceUrl = 'https://karmagroup.co.in/files/alpha.pdf';
  const project = {
    ProjectID: 'BLDP-1', ProjectName: 'Alpha',
    Brochures: [{ OriginalUrl: sourceUrl, verified: true, StoragePath: 'old-gridfs-key' }]
  };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    ingestBrochures: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: driveStore(calls)
  });

  const out = await svc._ingestBrochure(project, sourceUrl);

  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(calls.length, 1);
  assert.equal(project.Brochures.length, 1);
  assert.equal(project.Brochures[0].DriveFileId, 'DRIVE-FILE-1');
  assert.match(project.Brochures[0].DriveWebViewLink, /^https:\/\/drive\.google\.com\//);
});

test('an older Drive brochure with a file ID gets a direct link on reuse', async () => {
  const project = {
    ProjectID: 'BLDP-1', ProjectName: 'Alpha',
    Brochures: [{
      OriginalUrl: 'https://karmagroup.co.in/files/alpha.pdf',
      verified: true,
      DriveFileId: 'EXISTING-FILE'
    }]
  };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: async () => { throw new Error('unexpected download'); }
  });

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, true);
  assert.equal(out.reused, true);
  assert.equal(project.Brochures[0].DriveWebViewLink, 'https://drive.google.com/file/d/EXISTING-FILE/view');
});

test('a storage response without a Drive file ID is not marked verified', async () => {
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Alpha', Brochures: [] };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: {
      putObjectStream: async (_key, stream) => {
        await drain(stream);
        return { path: 'builder-projects/BLDP-1/brochures/alpha.pdf' };
      }
    }
  });

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, false);
  assert.match(out.error, /did not return a file ID/);
  assert.equal(project.Brochures.length, 0);
});

test('a failed brochure re-upload never loses the existing brochure record', async () => {
  const stale = { OriginalUrl: 'https://karmagroup.co.in/files/alpha.pdf', verified: false, downloadStatus: 'failed' };
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Alpha', Brochures: [stale] };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    ingestBrochures: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: { putObjectStream: async () => { throw new Error('drive 503 unavailable'); } }
  });

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, false);
  assert.match(out.error, /Upload failed/);
  assert.equal(project.Brochures.length, 1);
  assert.equal(project.Brochures[0], stale, 'prior record preserved on failed retry');
});

test('brochure-only scrape stores no photos, floor plans or videos and uploads only the brochure', async () => {
  KarmaGroupScraperService.__resetForTests();
  const db = { BuilderProjects: [], Builders: [] };
  const storeCalls = [];
  const svc = new KarmaGroupScraperService(repoWith(db), {
    ingestMedia: false,
    ingestBrochures: true,
    allowProjectCreation: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: {
      async putObjectStream(key, stream, contentType, filename) {
        await drain(stream);
        storeCalls.push(key);
        return { path: key, fileId: 'D1', webViewLink: 'https://v', webContentLink: 'https://c', size: 12 };
      }
    }
  });

  let mediaIngestCalled = false;
  svc._ingestProjectMedia = async () => { mediaIngestCalled = true; };
  svc._fetchAndParseDetail = async () => ({
    ok: true,
    parsed: {
      projectName: 'Alpha', builderName: 'Acme', location: 'Vesu', category: 'Residential',
      sourceProjectID: '101', sourceUrl: 'https://karmagroup.co.in/Projects/ProjectDetail/101',
      brochureUrl: 'https://karmagroup.co.in/files/alpha.pdf',
      photoUrls: ['https://karmagroup.co.in/images/projects/p1.jpg'],
      floorPlanUrls: ['https://karmagroup.co.in/images/projects/floorplans/f1.jpg'],
      directVideoUrls: ['https://karmagroup.co.in/v/v1.mp4'],
      configurations: [], amenities: [], highlights: [], specifications: []
    }
  });

  const counters = {
    scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    errorCount: 0, errors: [], brochuresStored: 0, brochuresReused: 0, brochuresFailed: 0
  };
  await svc._processCandidate(db, {
    projectName: 'Alpha', sourceProjectID: '101',
    sourceUrl: 'https://karmagroup.co.in/Projects/ProjectDetail/101'
  }, counters, 'system', {});

  const created = db.BuilderProjects[0];
  assert.ok(created, 'project created');
  assert.equal(mediaIngestCalled, false, 'photo/video media ingestion path is never invoked');
  assert.deepEqual(storeCalls, [`builder-projects/${created.ProjectID}/brochures/alpha.pdf`], 'only the brochure is uploaded');
  assert.equal(counters.brochuresStored, 1);
  assert.equal(created.Videos.length, 0, 'no videos stored');
  assert.ok((created.Photos || []).every((ph) => !ph.StoragePath && !ph.DriveFileId && !ph.DriveFileID), 'photos are URL references only, no stored bytes');
  assert.ok((created.FloorPlans || []).every((fp) => !fp.StoragePath && !fp.DriveFileId && !fp.DriveFileID), 'floor plans are URL references only, no stored bytes');
  assert.equal(created.Brochures.length, 1);
  assert.equal(created.Brochures[0].DriveFileId, 'D1');
  KarmaGroupScraperService.__resetForTests();
});

test('a brochure storage failure is recorded per project and the scrape continues', async () => {
  KarmaGroupScraperService.__resetForTests();
  const db = { BuilderProjects: [], Builders: [] };
  const svc = new KarmaGroupScraperService(repoWith(db), {
    ingestMedia: false,
    ingestBrochures: true,
    allowProjectCreation: true,
    isDriveStorageConfigured: () => true,
    openPdfStreamSafely: okPdfStream,
    objectStorage: { putObjectStream: async () => { throw new Error('drive 500'); } }
  });
  svc._fetchAndParseDetail = async () => ({
    ok: true,
    parsed: {
      projectName: 'Beta', builderName: 'Acme', location: 'Vesu', category: 'Residential',
      sourceProjectID: '102', sourceUrl: 'https://karmagroup.co.in/Projects/ProjectDetail/102',
      brochureUrl: 'https://karmagroup.co.in/files/beta.pdf',
      photoUrls: [], floorPlanUrls: [], directVideoUrls: [],
      configurations: [], amenities: [], highlights: [], specifications: []
    }
  });

  const counters = {
    scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
    errorCount: 0, errors: [], brochuresStored: 0, brochuresReused: 0, brochuresFailed: 0
  };
  await assert.doesNotReject(() => svc._processCandidate(db, {
    projectName: 'Beta', sourceProjectID: '102',
    sourceUrl: 'https://karmagroup.co.in/Projects/ProjectDetail/102'
  }, counters, 'system', {}));

  assert.equal(counters.created, 1, 'project still saved despite brochure failure');
  assert.equal(counters.brochuresFailed, 1);
  const status = KarmaGroupScraperService.getStatus().data;
  const brochureError = status.errors.find((e) => e.stage === 'brochure-storage');
  assert.ok(brochureError, 'brochure failure recorded with its stage');
  assert.equal(brochureError.projectName, 'Beta');
  assert.match(brochureError.message, /Upload failed/);
  KarmaGroupScraperService.__resetForTests();
});

test('brochure backfill updates only existing pending projects and can retry a failed upload', async () => {
  KarmaGroupScraperService.__resetForTests();
  const pending = { ProjectID: 'BLDP-1', ProjectName: 'Pending', ImportedFrom: 'KarmaGroupScrape',
    BrochureUrl: 'https://karmagroup.co.in/files/a.pdf', Brochures: [], Active: true };
  const stored = { ProjectID: 'BLDP-2', ProjectName: 'Stored', ImportedFrom: 'KarmaGroupScrape',
    BrochureUrl: 'https://karmagroup.co.in/files/b.pdf',
    Brochures: [{ verified: true, DriveFileId: 'already-saved' }] };
  const db = { BuilderProjects: [pending, stored], KarmaScrapeRuns: [] };
  const calls = [];
  const svc = new KarmaGroupScraperService(repoWith(db), {
    isDriveStorageConfigured: () => true, objectStorage: driveStore(calls), openPdfStreamSafely: okPdfStream
  });
  svc._flushScrapeWrites = async () => {};
  const accepted = await svc.startBrochureBackfill({ limit: 20 });
  assert.equal(accepted.statusCode, 202);
  for (let n = 0; n < 20 && KarmaGroupScraperService.isRunning(); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.BuilderProjects.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(pending.Brochures[0].DriveFileId, 'DRIVE-FILE-1');
  assert.equal(pending.BrochureUrl, null);
  assert.equal(stored.Brochures[0].DriveFileId, 'already-saved');
  assert.equal(KarmaGroupScraperService.getStatus().data.result.brochuresStored, 1);
  KarmaGroupScraperService.__resetForTests();
});
