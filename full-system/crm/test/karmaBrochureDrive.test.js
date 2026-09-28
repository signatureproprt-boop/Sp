'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { KarmaGroupScraperService } = require('../src/services/karmaGroupScraperService');

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
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Alpha', Brochures: [] };

  const out = await svc._ingestBrochure(project, 'https://karmagroup.co.in/files/alpha.pdf');

  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.equal(out.driveFileId, 'DRIVE-FILE-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'builder-projects/BLDP-1/brochures/alpha.pdf');
  assert.equal(calls[0].options.metadata.mediaType, 'brochure');

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
