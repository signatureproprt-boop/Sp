'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InventoryService } = require('../src/services/inventoryService');
const { BuilderProjectService } = require('../src/services/builderProjectService');

function repoWith(db) {
  return {
    read: () => JSON.parse(JSON.stringify(db)),
    write: () => {},
    list: (collection) => {
      const rows = db[collection];
      return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
    }
  };
}

test('InventoryService listPage filters by project and returns bounded pagination', () => {
  const db = {
    Inventory: [
      { PropertyID: 'P1', ProjectID: 'PRJ-1', BuilderID: 'B1', Title: 'One', UpdatedAt: '2026-01-03T00:00:00Z' },
      { PropertyID: 'P2', ProjectID: 'PRJ-1', BuilderID: 'B1', Title: 'Two', UpdatedAt: '2026-01-02T00:00:00Z' },
      { PropertyID: 'P3', ProjectID: 'PRJ-2', BuilderID: 'B2', Title: 'Three', UpdatedAt: '2026-01-01T00:00:00Z' }
    ]
  };
  const svc = new InventoryService(repoWith(db));
  const page = svc.listPage({ projectId: 'prj-1', page: 1, limit: 1 });

  assert.equal(page.ok, true);
  assert.equal(page.pagination.total, 2);
  assert.equal(page.pagination.totalPages, 2);
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].PropertyID, 'P1');
});

test('InventoryService listPage clamps limit to 100', () => {
  const rows = Array.from({ length: 125 }, (_, i) => ({
    PropertyID: 'P' + i,
    UpdatedAt: new Date(2026, 0, 1 + i).toISOString()
  }));
  const svc = new InventoryService(repoWith({ Inventory: rows }));
  const page = svc.listPage({ limit: 999 });

  assert.equal(page.pagination.limit, 100);
  assert.equal(page.data.length, 100);
  assert.equal(page.pagination.total, 125);
});

test('BuilderProjectService listPage returns bounded pagination', () => {
  const rows = Array.from({ length: 105 }, (_, i) => ({
    ProjectID: 'PRJ-' + i,
    ProjectName: 'Project ' + i,
    BuilderName: i % 2 ? 'Builder A' : 'Builder B',
    Active: true,
    CreatedAt: new Date(2026, 0, 1 + i).toISOString()
  }));
  const svc = new BuilderProjectService(repoWith({ BuilderProjects: rows }));
  const page = svc.listPage({ page: 2, limit: 50 });

  assert.equal(page.ok, true);
  assert.equal(page.pagination.total, 105);
  assert.equal(page.pagination.totalPages, 3);
  assert.equal(page.data.length, 50);
  assert.equal(page.data[0].ProjectID, 'PRJ-54');
});


test('InventoryService canonicalizes builder metadata from linked BuilderProject', () => {
  const db = {
    Inventory: [],
    BuilderProjects: [{
      ProjectID: 'PRJ-1', ProjectName: 'Canonical Project', BuilderID: 'BLD-1',
      BuilderName: 'Canonical Builder', Active: true
    }],
    _V2Counters: { Property: 0 }
  };
  let written;
  const repo = repoWith(db);
  repo.write = (next) => { written = next; };
  const svc = new InventoryService(repo);
  const row = svc.create({
    ProjectID: 'PRJ-1',
    ProjectName: 'Wrong Project',
    BuilderID: 'WRONG',
    BuilderName: 'Wrong Builder'
  }, { userId: 'U1' });

  assert.equal(row.ProjectID, 'PRJ-1');
  assert.equal(row.ProjectName, 'Canonical Project');
  assert.equal(row.BuilderID, 'BLD-1');
  assert.equal(row.BuilderName, 'Canonical Builder');
  assert.equal(written.Inventory[0].ProjectID, 'PRJ-1');
});

test('InventoryService rejects an unknown BuilderProject link', () => {
  const db = { Inventory: [], BuilderProjects: [], _V2Counters: { Property: 0 } };
  const svc = new InventoryService(repoWith(db));
  const out = svc.create({ ProjectID: 'PRJ-MISSING' }, { userId: 'U1' });

  assert.equal(out.ok, false);
  assert.equal(out.error, 'Builder project not found');
});
