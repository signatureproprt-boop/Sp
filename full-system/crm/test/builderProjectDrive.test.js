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
    assert.equal(repo.writes(), 1);
  } finally {
    if (oldRoot === undefined) delete process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID;
    else process.env.BUILDER_PROJECTS_DRIVE_FOLDER_ID = oldRoot;
  }
});

test('existing Drive linkage is idempotent and creates no duplicate folder', async () => {
  const db = {
    BuilderProjects: [{
      ProjectID: 'BLDP-A', ProjectName: 'Alpha', CompanyID: 'C-A', BrokerageID: 'B-A',
      DriveFolderID: 'EXISTING', DriveFolderURL: 'https://drive.google.com/drive/folders/EXISTING', Active: true
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
