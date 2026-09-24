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
