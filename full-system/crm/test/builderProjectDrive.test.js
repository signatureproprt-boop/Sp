'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BuilderProjectDriveService, PROJECT_SUBFOLDERS, safeFolderName } = require('../src/services/builderProjectDriveService');

function makeRepo(db) {
  let writes = 0;
  return {
    read: () => db,
    write: () => { writes += 1; },
    writes: () => writes
  };
}

test('safeFolderName keeps ProjectID/name usable in Drive', () => {
  assert.equal(safeFolderName('BLDP-1 A/B: Tower?'), 'BLDP-1 A-B- Tower-');
});

test('links only one PDF in the already linked project folder, with dry-run first', async () => {
  const db = { BuilderProjects: [
    { ProjectID: 'BLDP-A', ProjectName: 'Alpha', Active: true, DriveFolderID: 'A',
      BrochureUrl: 'https://karmagroup.co.in/files/638854364616613620.pdf',
      DriveSubfolders: { Brochures: 'PDF-A' }, Brochures: [] },
    { ProjectID: 'BLDP-B', ProjectName: 'Beta', Active: true, DriveFolderID: 'B',
      BrochureUrl: 'https://karmagroup.co.in/files/639214468173665709.pdf',
      DriveSubfolders: { Brochures: 'PDF-B' }, Brochures: [] }
  ] };
  const repo = makeRepo(db);
  repo.createId = () => 'MED-1';
  const drive = { listFilesInFolder: async (id) => id === 'PDF-A'
    ? [{ id: 'F-A', name: '638854364616613620.pdf', mimeType: 'application/pdf', size: '1234' }]
    : [{ id: 'F-B1', name: '639214468173665709.pdf', mimeType: 'application/pdf' },
      { id: 'F-B2', name: '639214468173665709.pdf', mimeType: 'application/pdf' }] };
  const svc = new BuilderProjectDriveService(repo, drive);
  const preview = await svc.linkExistingBrochures({ limit: 2 });
  assert.equal(preview.data.ready, 1);
  assert.equal(preview.data.ambiguous, 1);
  assert.equal(repo.writes(), 0);
  const applied = await svc.linkExistingBrochures({ dryRun: false, limit: 2 });
  assert.equal(applied.data.linked, 1);
  assert.equal(repo.writes(), 1);
  assert.equal(db.BuilderProjects[0].Brochures[0].DriveFileID, 'F-A');
  assert.equal(db.BuilderProjects[0].Brochures[0].verified, true);
  assert.equal(db.BuilderProjects[1].Brochures.length, 0);
  const repeated = await svc.linkExistingBrochures({ dryRun: false, limit: 2 });
  assert.equal(repeated.data.linked, 0);
});

test('completes an existing unverified Drive brochure record without duplicating it', async () => {
  const brochure = { MediaID: 'MED-OLD', DriveFileId: 'F-OLD', verified: false,
    downloadStatus: 'pending', OriginalUrl: 'https://example.com/123.pdf' };
  const project = { ProjectID: 'BLDP-OLD', DriveFolderID: 'P-OLD',
    DriveSubfolders: { Brochures: 'B-OLD' }, Brochures: [brochure] };
  const repo = makeRepo({ BuilderProjects: [project] });
  repo.createId = () => { throw new Error('must retain the existing media ID'); };
  const svc = new BuilderProjectDriveService(repo, {
    listFilesInFolder: async () => [{ id: 'F-OLD', name: '123.pdf', mimeType: 'application/pdf', size: '321' }]
  });
  const result = await svc.linkExistingBrochures({ dryRun: false });
  assert.equal(result.data.ready, 1);
  assert.equal(result.data.linked, 1);
  assert.equal(repo.writes(), 1);
  assert.equal(project.Brochures.length, 1);
  assert.equal(project.Brochures[0].MediaID, 'MED-OLD');
  assert.equal(project.Brochures[0].verified, true);
  assert.equal(project.Brochures[0].downloadStatus, 'downloaded');
});

test('finds an unlinked project folder by exact ProjectID prefix without creating folders', async () => {
  const db = { BuilderProjects: [{ ProjectID: 'BLDP-3', ProjectName: 'Gamma', Active: true,
    BrochureUrl: 'https://karmagroup.co.in/files/638853370465014309.pdf', Brochures: [] }] };
  const repo = makeRepo(db);
  repo.createId = () => 'MED-3';
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'ROOT';
  const drive = {
    listFilesInFolder: async (id) => id === 'ROOT'
      ? [{ id: 'PROJECT-3', name: 'BLDP-3 Gamma', mimeType: 'application/vnd.google-apps.folder' }]
      : [{ id: 'PDF-3', name: '638853370465014309.pdf', mimeType: 'application/pdf' }],
    findFolder: async (name, parent) => name === 'Brochures' && parent === 'PROJECT-3' ? { id: 'BROCHURES-3' } : null
  };
  try {
    const svc = new BuilderProjectDriveService(repo, drive);
    const out = await svc.linkExistingBrochures({ dryRun: false });
    assert.equal(out.data.linked, 1);
    assert.equal(db.BuilderProjects[0].DriveFolderID, 'PROJECT-3');
    assert.equal(db.BuilderProjects[0].Brochures[0].DriveFileID, 'PDF-3');
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('refuses a lone PDF with the wrong brochure number', async () => {
  const project = { ProjectID: 'BLDP-4', ProjectName: 'Delta', Active: true,
    DriveFolderID: 'PROJECT-4', DriveSubfolders: { Brochures: 'FOLDER-4' },
    BrochureUrl: 'https://karmagroup.co.in/files/638854364616613620.pdf', Brochures: [] };
  const repo = makeRepo({ BuilderProjects: [project] });
  const svc = new BuilderProjectDriveService(repo, {
    listFilesInFolder: async () => [{ id: 'WRONG', name: '639214468173665709.pdf', mimeType: 'application/pdf' }]
  });
  const out = await svc.linkExistingBrochures({ dryRun: false });
  assert.equal(out.data.unmatched, 1);
  assert.equal(out.data.linked, 0);
  assert.equal(repo.writes(), 0);
  assert.equal(project.Brochures.length, 0);
});

test('links one exact brochure number across duplicate project folders', async () => {
  const project = { ProjectID: 'BLDP-5', ProjectName: 'Epsilon', Active: true,
    BrochureUrl: 'https://karmagroup.co.in/files/123456.pdf', Brochures: [] };
  const repo = makeRepo({ BuilderProjects: [project] });
  repo.createId = () => 'MED-5';
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'ROOT';
  const drive = {
    listFilesInFolder: async (id) => id === 'ROOT'
      ? ['A', 'B'].map((folder) => ({ id: folder, name: 'BLDP-5 Epsilon', mimeType: 'application/vnd.google-apps.folder' }))
      : id === 'PDF-A' ? [{ id: 'FILE-A', name: 'wrong.pdf', mimeType: 'application/pdf' }]
        : [{ id: 'FILE-B', name: '123456.pdf', mimeType: 'application/pdf' }],
    findFolder: async (name, id) => ({ id: `PDF-${id}` })
  };
  try {
    const preview = await new BuilderProjectDriveService(repo, drive).linkExistingBrochures();
    assert.equal(preview.data.ready, 1);
    assert.equal(preview.data.ambiguous, 0);
    const out = await new BuilderProjectDriveService(repo, drive).linkExistingBrochures({ dryRun: false });
    assert.equal(out.data.linked, 1);
    assert.equal(project.Brochures[0].DriveFileID, 'FILE-B');
    assert.equal(project.DriveFolderID, 'B');
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('finds brochure in a duplicate Project-prefixed folder without disturbing other media folders', async () => {
  const project = { ProjectID: 'BLDP-7', ProjectName: 'Eta', Active: true,
    DriveFolderID: 'EMPTY', DriveSubfolders: { Brochures: 'EMPTY-PDF', Videos: 'OLD-VIDEOS' },
    BrochureUrl: 'https://example.com/777.pdf', Brochures: [] };
  const repo = makeRepo({ BuilderProjects: [project] });
  repo.createId = () => 'MED-7';
  const previous = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'ROOT';
  const drive = {
    listFilesInFolder: async (id) => id === 'ROOT'
      ? [{ id: 'REAL', name: 'Project-BLDP-7 Eta', mimeType: 'application/vnd.google-apps.folder' }]
      : id === 'REAL-PDF'
        ? [{ id: 'FILE-7', name: '777.pdf', mimeType: 'application/pdf', size: '77' }]
        : [],
    findFolder: async (name, id) => name === 'Brochures' && id === 'REAL' ? { id: 'REAL-PDF' } : null
  };
  try {
    const result = await new BuilderProjectDriveService(repo, drive).linkExistingBrochures({ dryRun: false });
    assert.equal(result.data.linked, 1);
    assert.equal(project.DriveFolderID, 'EMPTY');
    assert.deepEqual(project.DriveSubfolders, { Brochures: 'REAL-PDF', Videos: 'OLD-VIDEOS' });
    assert.equal(project.Brochures[0].DriveFileID, 'FILE-7');
  } finally {
    if (previous === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = previous;
  }
});

test('identical Drive checksums allow one link, different or absent checksums remain ambiguous', async () => {
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'ROOT';
  try {
    for (const secondChecksum of ['SAME', 'DIFFERENT', undefined]) {
      const project = { ProjectID: 'BLDP-6', ProjectName: 'Zeta', Active: true,
        BrochureUrl: 'https://karmagroup.co.in/files/654321.pdf', Brochures: [] };
      const repo = makeRepo({ BuilderProjects: [project] });
      repo.createId = () => 'MED-6';
      const drive = {
        listFilesInFolder: async (id) => id === 'ROOT'
          ? ['A', 'B'].map((folder) => ({ id: folder, name: 'BLDP-6 Zeta', mimeType: 'application/vnd.google-apps.folder' }))
          : [{ id: `FILE-${id}`, name: '654321.pdf', mimeType: 'application/pdf', size: '123',
            md5Checksum: id === 'PDF-A' ? 'SAME' : secondChecksum }],
        findFolder: async (name, id) => ({ id: `PDF-${id}` })
      };
      const out = await new BuilderProjectDriveService(repo, drive).linkExistingBrochures({ dryRun: false });
      assert.equal(out.data.linked, secondChecksum === 'SAME' ? 1 : 0);
      assert.equal(out.data.ambiguous, secondChecksum === 'SAME' ? 0 : 1);
      assert.equal(project.Brochures.length, secondChecksum === 'SAME' ? 1 : 0);
    }
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('scoped folder hint requires exact project ancestry and brochure filename', async () => {
  const project = { ProjectID: 'BLDP-8', ProjectName: 'Sky', Active: true,
    BrochureUrl: 'https://example.com/123.pdf', Brochures: [] };
  const repo = makeRepo({ BuilderProjects: [project] });
  repo.createId = () => 'MED-8';
  const previous = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'ROOT';
  let parent = 'ROOT';
  const drive = {
    async getFileMetadata() { return { id: 'PROJECT-8', name: 'BLDP-8 Sky',
      mimeType: 'application/vnd.google-apps.folder', parents: [parent] }; },
    async listFilesInFolder(id) { return id === 'BROCHURES-8'
      ? [{ id: 'PDF-8', name: '123.pdf', mimeType: 'application/pdf' }] : []; },
    async findFolder(name, id) { return name === 'Brochures' && id === 'PROJECT-8'
      ? { id: 'BROCHURES-8' } : null; }
  };
  try {
    const svc = new BuilderProjectDriveService(repo, drive);
    const options = { projectIds: ['BLDP-8'], folderHints: { 'BLDP-8': 'PROJECT-8' } };
    parent = 'WRONG-ROOT';
    const refused = await svc.linkExistingBrochures({ dryRun: false, ...options });
    assert.equal(refused.data.linked, 0);
    assert.equal(refused.data.errors.length, 1);
    parent = 'ROOT';
    const applied = await svc.linkExistingBrochures({ dryRun: false, ...options });
    assert.equal(applied.data.linked, 1);
    assert.equal(project.Brochures[0].DriveFileID, 'PDF-8');
    assert.equal(project.DriveFolderID, 'PROJECT-8');
  } finally {
    if (previous === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = previous;
  }
});

test('project Drive folder creation is tenant scoped and persists linkage', async () => {
  const db = {
    BuilderProjects: [
      { ProjectID: 'BLDP-A', ProjectName: 'Alpha', CompanyID: 'C-A', BrokerageID: 'B-A', Active: true },
      { ProjectID: 'BLDP-B', ProjectName: 'Beta', CompanyID: 'C-B', BrokerageID: 'B-B', Active: true }
    ]
  };
  const repo = makeRepo(db);
  const calls = [];
  const drive = {
    async findFolder() { return null; },
    async createFolder(name, parentId) {
      calls.push({ name, parentId });
      const id = 'F-' + calls.length;
      return { id, url: 'https://drive.google.com/drive/folders/' + id };
    }
  };

  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'MASTER';
  try {
    const svc = new BuilderProjectDriveService(repo, drive);
    const denied = await svc.ensureProjectFolder('BLDP-B', { companyId: 'C-A', brokerageId: 'B-A' });
    assert.equal(denied.ok, false);
    assert.equal(denied.statusCode, 404);
    assert.equal(calls.length, 0);

    const out = await svc.ensureProjectFolder('BLDP-A', { companyId: 'C-A', brokerageId: 'B-A' });
    assert.equal(out.ok, true);
    assert.equal(out.created, true);
    assert.equal(calls[0].name, 'BLDP-A Alpha');
    assert.equal(calls[0].parentId, 'MASTER');
    assert.equal(calls.length, 1 + PROJECT_SUBFOLDERS.length);
    assert.equal(db.BuilderProjects[0].DriveFolderID, 'F-1');
    assert.equal(Object.keys(db.BuilderProjects[0].DriveSubfolders).length, PROJECT_SUBFOLDERS.length);
    assert.equal(repo.writes(), 1 + PROJECT_SUBFOLDERS.length);
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('existing Drive linkage is idempotent and creates no duplicate folder', async () => {
  const db = {
    BuilderProjects: [{
      ProjectID: 'BLDP-A', ProjectName: 'Alpha', CompanyID: 'C-A', BrokerageID: 'B-A',
      DriveFolderID: 'EXISTING', DriveFolderURL: 'https://drive.google.com/drive/folders/EXISTING',
      DriveSubfolders: Object.fromEntries(PROJECT_SUBFOLDERS.map((name) => [name, `F-${name}`])), Active: true
    }]
  };
  const repo = makeRepo(db);
  let calls = 0;
  const svc = new BuilderProjectDriveService(repo, { createFolder: async () => { calls += 1; } });
  const out = await svc.ensureProjectFolder('BLDP-A', { companyId: 'C-A', brokerageId: 'B-A' });
  assert.equal(out.ok, true);
  assert.equal(out.created, false);
  assert.equal(calls, 0);
  assert.equal(repo.writes(), 0);
});

test('missing Drive root configuration fails before any folder is created', async () => {
  const db = { BuilderProjects: [{ ProjectID: 'BLDP-A', ProjectName: 'Alpha', CompanyID: 'C-A', Active: true }] };
  const repo = makeRepo(db);
  let calls = 0;
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  try {
    const svc = new BuilderProjectDriveService(repo, { createFolder: async () => { calls += 1; } });
    const out = await svc.ensureProjectFolder('BLDP-A', { companyId: 'C-A' });
    assert.equal(out.ok, false);
    assert.equal(out.statusCode, 503);
    assert.equal(calls, 0);
  } finally {
    if (oldRoot !== undefined) process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});


test('uploadProjectFile stores bytes in the correct Drive subfolder', async () => {
  const db = {
    BuilderProjects: [{
      ProjectID: 'BLDP-A',
      ProjectName: 'Alpha',
      CompanyID: 'C-A',
      BrokerageID: 'B-A',
      Active: true,
      DriveFolderID: 'ROOT-A',
      DriveFolderURL: 'https://drive.google.com/drive/folders/ROOT-A',
      DriveSubfolders: {
        ...Object.fromEntries(PROJECT_SUBFOLDERS.map((name) => [name, `F-${name}`])),
        Brochures: 'BROCHURES-A'
      }
    }]
  };
  const repo = makeRepo(db);
  const uploads = [];
  const drive = {
    async uploadBuffer(filename, buffer, parentId, mimeType) {
      uploads.push({ filename, bytes: buffer.length, parentId, mimeType });
      return { id: 'FILE-1', url: 'https://drive.google.com/file/d/FILE-1/view' };
    }
  };
  const svc = new BuilderProjectDriveService(repo, drive);
  const out = await svc.uploadProjectFile(
    'BLDP-A',
    'Brochures',
    'alpha.pdf',
    Buffer.from('pdf-bytes'),
    'application/pdf',
    { companyId: 'C-A', brokerageId: 'B-A' }
  );
  assert.equal(out.ok, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].parentId, 'BROCHURES-A');
  assert.equal(uploads[0].filename, 'alpha.pdf');
  assert.equal(out.data.id, 'FILE-1');
});

test('concurrent service instances share one project folder creation', async () => {
  const db = {
    BuilderProjects: [{
      ProjectID: 'BLDP-RACE', ProjectName: 'Race Test', CompanyID: 'C-A', BrokerageID: 'B-A', Active: true
    }]
  };
  const repo = makeRepo(db);
  const calls = [];
  const drive = {
    async findFolder() { return null; },
    async createFolder(name, parentId) {
      calls.push({ name, parentId });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const id = 'RACE-' + calls.length;
      return { id, url: 'https://drive.google.com/drive/folders/' + id };
    }
  };
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'MASTER';
  try {
    const tenant = { companyId: 'C-A', brokerageId: 'B-A' };
    const [first, second] = await Promise.all([
      new BuilderProjectDriveService(repo, drive).ensureProjectFolder('BLDP-RACE', tenant),
      new BuilderProjectDriveService(repo, drive).ensureProjectFolder('BLDP-RACE', tenant)
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.data.DriveFolderID, second.data.DriveFolderID);
    assert.equal(calls.length, 1 + PROJECT_SUBFOLDERS.length);
    assert.equal(repo.writes(), 1 + PROJECT_SUBFOLDERS.length);
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('retry reuses an existing project folder and its existing subfolders', async () => {
  const db = { BuilderProjects: [{ ProjectID: 'BLDP-A', ProjectName: 'Alpha', Active: true }] };
  const repo = makeRepo(db);
  const existing = new Map([['MASTER:BLDP-A Alpha', { id: 'ROOT' }], ['ROOT:Brochures', { id: 'PDFS' }]]);
  const created = [];
  const drive = {
    async findFolder(name, parent) { return existing.get(`${parent}:${name}`) || null; },
    async createFolder(name, parent) {
      created.push(name);
      const folder = { id: `NEW-${name}` };
      existing.set(`${parent}:${name}`, folder);
      return folder;
    }
  };
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'MASTER';
  try {
    const out = await new BuilderProjectDriveService(repo, drive).ensureProjectFolder('BLDP-A');
    assert.equal(out.ok, true);
    assert.equal(out.created, false);
    assert.equal(out.data.DriveFolderID, 'ROOT');
    assert.equal(out.data.DriveSubfolders.Brochures, 'PDFS');
    assert.equal(created.length, PROJECT_SUBFOLDERS.length - 1);
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('failed subfolder creation saves project linkage and retry creates only missing folders', async () => {
  const db = { BuilderProjects: [{ ProjectID: 'BLDP-A', ProjectName: 'Alpha', Active: true }] };
  const repo = makeRepo(db);
  const existing = new Map();
  let failOnce = true;
  const drive = {
    async findFolder(name, parent) { return existing.get(`${parent}:${name}`) || null; },
    async createFolder(name, parent) {
      if (name === 'Floor Plans' && failOnce) { failOnce = false; throw new Error('timeout'); }
      const folder = { id: `ID-${name}` };
      existing.set(`${parent}:${name}`, folder);
      return folder;
    }
  };
  const oldRoot = process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
  process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = 'MASTER';
  try {
    const svc = new BuilderProjectDriveService(repo, drive);
    await assert.rejects(svc.ensureProjectFolder('BLDP-A'), /timeout/);
    assert.equal(db.BuilderProjects[0].DriveFolderID, 'ID-BLDP-A Alpha');
    assert.equal(db.BuilderProjects[0].DriveSubfolders.Brochures, 'ID-Brochures');
    const retry = await svc.ensureProjectFolder('BLDP-A');
    assert.equal(retry.ok, true);
    assert.equal(existing.size, 1 + PROJECT_SUBFOLDERS.length);
    assert.equal(repo.writes(), 1 + PROJECT_SUBFOLDERS.length);
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});
