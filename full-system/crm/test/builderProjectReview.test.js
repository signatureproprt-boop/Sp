'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BuilderProjectService } = require('../src/services/builderProjectService');
const { brochureStatusReport } = require('../src/services/builderBrochureStatusReport');

function repo(projects) {
  const data = { BuilderProjects: projects };
  return { read: () => data, write: () => {}, list: () => data.BuilderProjects };
}

test('filters BHK and carpet/built-up sizes within the same configuration', () => {
  const service = new BuilderProjectService(repo([
    { ProjectID: 'one', ConfigDetails: [{ Type: '2 BHK', CarpetAreaSqft: 800, BuiltUpAreaSqft: 1000 }, { Type: '3 BHK', CarpetAreaSqft: 1100, BuiltUpAreaSqft: 1400 }] },
    { ProjectID: 'legacy', ConfigDetails: [{ Type: '2 BHK', AreaSqft: 900 }] }
  ]));
  assert.deepEqual(service.list({ bhk: '2 BHK', carpetMin: 750, carpetMax: 850, builtUpMin: 950 }).data.map(p => p.ProjectID), ['one']);
  assert.equal(service.list({ bhk: '2 BHK', carpetMin: 900 }).count, 0);
  assert.equal(service.list({ bhk: '2 BHK' }).count, 2);
});

test('manual review records who checked and becomes stale after brochure or form changes', () => {
  const project = { ProjectID: 'p1', Active: true, ProjectName: 'Home', BuilderName: 'Builder', Location1: 'Vesu', Brochures: [{ verified: true, DriveFileId: 'file-1' }] };
  const service = new BuilderProjectService(repo([project]));
  assert.equal(service.setReview('p1', 'brochure', true, 'agent-1').ok, true);
  assert.equal(service.setReview('p1', 'form', true, 'agent-1').ok, true);
  assert.equal(brochureStatusReport([project]).rows[0].brochureChecked, true);
  project.Brochures.push({ verified: true, DriveFileId: 'file-2' });
  assert.equal(brochureStatusReport([project]).rows[0].brochureChecked, false);
  assert.equal(service.update('p1', { Address: 'New address' }).ok, true);
  assert.equal(project.FormReview, null);
});

test('land, tower, floor, height and penthouse details survive project edits', () => {
  const project = { ProjectID: 'p-floor', Active: true, ProjectName: 'Tower', BuilderName: 'Builder', Location1: 'Vesu' };
  const service = new BuilderProjectService(repo([project]));
  const result = service.update('p-floor', {
    ProjectArea: '2.5 acres', TotalTowers: '3', TotalFloors: '18', FloorHeightFt: '10.5',
    ConfigDetails: [{ Type: 'Penthouse', CarpetAreaSqft: 2400, BuiltUpAreaSqft: 3000 }]
  });
  assert.equal(result.ok, true);
  assert.equal(project.ProjectArea, '2.5 acres');
  assert.equal(project.TotalTowers, 3);
  assert.equal(project.TotalFloors, 18);
  assert.equal(project.FloorHeightFt, 10.5);
  assert.equal(project.ConfigDetails[0].Type, 'Penthouse');
  assert.equal(project.ConfigDetails[0].BuiltUpAreaSqft, 3000);
});
