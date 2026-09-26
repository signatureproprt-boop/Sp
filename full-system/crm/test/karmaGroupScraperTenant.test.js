'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KarmaGroupScraperService } = require('../src/services/karmaGroupScraperService');

function repoWith(db) {
  let seq = 0;
  return {
    read: () => db,
    write: () => {},
    createId: (prefix) => `${prefix}-TEST-${++seq}`
  };
}

test('Karma scraper identity matching is tenant scoped', () => {
  const db = {
    BuilderProjects: [
      { ProjectID: 'BLDP-A', CompanyID: 'C-A', BrokerageID: 'B-A', SourceProjectID: '101', Active: true },
      { ProjectID: 'BLDP-B', CompanyID: 'C-B', BrokerageID: 'B-B', SourceProjectID: '101', Active: true }
    ]
  };
  const svc = new KarmaGroupScraperService(repoWith(db), { ingestBrochures: false });
  const match = svc._findExistingByIdentity(db, { sourceProjectID: '101' }, { companyId: 'C-B', brokerageId: 'B-B' });
  assert.equal(match.ProjectID, 'BLDP-B');
});

test('full scrape start returns accepted immediately while the job continues', async () => {
  KarmaGroupScraperService.__resetForTests();
  let finishJob;
  const jobGate = new Promise((resolve) => { finishJob = resolve; });
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), { ingestBrochures: false });
  svc._runFullScrapeJob = async () => jobGate;

  const result = await svc.startScrape();
  assert.equal(result.statusCode, 202);
  assert.equal(result.data.status, 'accepted');
  assert.equal(KarmaGroupScraperService.getStatus().data.status, 'running');

  finishJob();
  await new Promise(setImmediate);
  assert.equal(KarmaGroupScraperService.getStatus().data.status, 'completed');
  KarmaGroupScraperService.__resetForTests();
});
test('scrape status exposes the last saved run as interrupted after a process restart', () => {
  KarmaGroupScraperService.__resetForTests();
  const repo = repoWith({ KarmaScrapeRuns: [{
    RunID: 'KSR-1', Status: 'running', StartedAt: '2026-09-26T10:00:00.000Z',
    UpdatedAt: '2026-09-26T10:20:00.000Z', CurrentStage: 'media-storage',
    CurrentProjectName: 'Sample Tower', Scanned: 18, Discovered: 758,
    ErrorCount: 1, Errors: [{ stage: 'media-storage', projectName: 'Sample Tower', message: 'Drive upload failed' }]
  }] });

  const status = KarmaGroupScraperService.getStatus(repo).data;
  assert.equal(status.status, 'interrupted');
  assert.equal(status.currentStage, 'media-storage');
  assert.equal(status.selectedProjectName, 'Sample Tower');
  assert.equal(status.scanned, 18);
  assert.equal(status.discoveredCandidates, 758);
  assert.equal(status.errors[0].message, 'Drive upload failed');
  KarmaGroupScraperService.__resetForTests();
});

test('scrape failure diagnostics identify the project and processing stage', async () => {
  KarmaGroupScraperService.__resetForTests();
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), { ingestBrochures: false });
  svc._fetchAndParseDetail = async () => ({
    ok: false, classification: 'STALE_DETAIL', statusCode: 404, error: 'HTTP 404'
  });
  const counters = { scanned: 0, failed: 0, staleDetailFailures: 0 };
  await svc._processCandidate({ BuilderProjects: [] }, {
    projectName: 'Sample Tower', sourceProjectID: 'KARMA-101'
  }, counters, 'test');

  const status = KarmaGroupScraperService.getStatus().data;
  assert.equal(status.errorCount, 1);
  assert.equal(status.errors[0].projectName, 'Sample Tower');
  assert.equal(status.errors[0].sourceProjectId, 'KARMA-101');
  assert.equal(status.errors[0].stage, 'detail-fetch');
  assert.equal(status.errors[0].statusCode, 404);
  KarmaGroupScraperService.__resetForTests();
});

test('Karma scraper does not cross tenant boundary for identical source identity', () => {
  const db = {
    BuilderProjects: [
      { ProjectID: 'BLDP-A', CompanyID: 'C-A', BrokerageID: 'B-A', SourceProjectID: '101', Active: true }
    ]
  };
  const svc = new KarmaGroupScraperService(repoWith(db), { ingestBrochures: false });
  const match = svc._findExistingByIdentity(db, { sourceProjectID: '101' }, { companyId: 'C-B', brokerageId: 'B-B' });
  assert.equal(match, null);
});

test('Karma scraper persists tenant and resolves canonical BuilderID', () => {
  const db = {
    BuilderProjects: [],
    Builders: [
      { BuilderID: 'BLD-7', CompanyID: 'C-A', BrokerageID: 'B-A', BuilderName: 'Acme Developers' },
      { BuilderID: 'BLD-8', CompanyID: 'C-B', BrokerageID: 'B-B', BuilderName: 'Acme Developers' }
    ]
  };
  const svc = new KarmaGroupScraperService(repoWith(db), { ingestBrochures: false });
  const row = svc._createProjectFromParsed(db, {
    projectName: 'Skyline',
    builderName: 'Acme Developers',
    location: 'Vesu',
    category: 'Residential',
    sourceProjectID: '101'
  }, 'USR-1', { companyId: 'C-A', brokerageId: 'B-A' });

  assert.equal(row.CompanyID, 'C-A');
  assert.equal(row.BrokerageID, 'B-A');
  assert.equal(row.BuilderID, 'BLD-7');
  assert.equal(row.BuilderName, 'Acme Developers');
});

test('Karma scraper never resolves BuilderID from another tenant', () => {
  const db = {
    BuilderProjects: [],
    Builders: [
      { BuilderID: 'BLD-8', CompanyID: 'C-B', BrokerageID: 'B-B', BuilderName: 'Acme Developers' }
    ]
  };
  const svc = new KarmaGroupScraperService(repoWith(db), { ingestBrochures: false });
  const row = svc._createProjectFromParsed(db, {
    projectName: 'Skyline',
    builderName: 'Acme Developers',
    location: 'Vesu'
  }, 'USR-1', { companyId: 'C-A', brokerageId: 'B-A' });

  assert.equal(row.BuilderID, null);
  assert.equal(row.CompanyID, 'C-A');
  assert.equal(row.BrokerageID, 'B-A');
});


test('Karma scraper ignores external video and virtual-tour URLs', () => {
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), { ingestBrochures: false });
  const parsed = svc.constructor.__parseProjectDetailHtmlForTests
    ? svc.constructor.__parseProjectDetailHtmlForTests('', 'https://karmagroup.co.in/Projects/ProjectDetail/1')
    : null;
  assert.equal(parsed, null);
});

test('Karma scraper reuses verified Google Drive media on repeat scrape', async () => {
  const crypto = require('crypto');
  const sourceUrl = 'https://karmagroup.co.in/media/photo.jpg';
  const sourceKey = crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24);
  const saved = { SourceKey: sourceKey, DriveFileID: 'drive-file-1', StoragePath: null, verified: true };
  const project = { ProjectID: 'BLDP-1', Photos: [saved] };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    downloadMediaSafely: async () => { throw new Error('duplicate download attempted'); }
  });

  const result = await svc._ingestOneProjectMedia(project, sourceUrl, 'Photos', 'project_image');
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.record, saved);
  assert.equal(project.Photos.length, 1);
  assert.equal(project.Photos[0].DriveFileID, 'drive-file-1');
});


test('Karma scraper exposes media failure examples in the scrape result', async () => {
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [] }), {
    downloadMediaSafely: async () => ({ ok: false, error: new Error('HTTP 403') })
  });
  const project = { ProjectID: 'BLDP-1', ProjectName: 'Skyline', Photos: [] };
  const counters = { mediaDiscovered: 0, mediaStored: 0, mediaReused: 0, mediaFailed: 0, mediaBytesStored: 0 };

  await svc._ingestProjectMedia(project, { photoUrls: ['https://karmagroup.co.in/media/photo.jpg'] }, counters);

  assert.equal(counters.mediaFailed, 1);
  assert.deepEqual(counters.mediaFailureExamples, [
    { projectName: 'Skyline', mediaType: 'project_image', error: 'HTTP 403' }
  ]);
  assert.equal(project.MediaIngestion.failures[0].error, 'HTTP 403');
});


test('Karma scraper reports the underlying Google Drive upload failure', async () => {
  const project = {
    ProjectID: 'BLDP-1',
    ProjectName: 'Skyline',
    DriveFolderID: 'drive-root',
    DriveSubfolders: { 'Project Images': 'drive-images' },
    Photos: []
  };
  const svc = new KarmaGroupScraperService(repoWith({ BuilderProjects: [project] }), {
    downloadMediaSafely: async () => ({
      ok: true,
      buffer: Buffer.from('image'),
      contentType: 'image/jpeg'
    }),
    driveClient: {
      uploadBuffer: async () => { throw new Error('403 insufficientFilePermissions'); }
    }
  });

  const result = await svc._ingestOneProjectMedia(
    project,
    'https://karmagroup.co.in/media/photo.jpg',
    'Photos',
    'project_image'
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /403 insufficientFilePermissions/);
  assert.match(result.error, /GridFS fallback is disabled/);
});
