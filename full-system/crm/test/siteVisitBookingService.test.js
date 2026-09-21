'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SiteVisitBookingService } = require('../src/services/siteVisitBookingService');

function makeRepo({ shortlisted = true } = {}) {
  let seq = 0;
  const db = {
    SiteVisits: [],
    Shortlists: shortlisted ? [{ RequirementID: 'REQ-1', PropertyID: 'PROP-1', Status: 'Active' }] : []
  };
  return {
    read: () => db,
    readRequirement: (id) => id === 'REQ-1' ? { RequirementID: id, LeadID: 'LEAD-1', TransactionID: 'TXN-1' } : null,
    readLead: (id) => id === 'LEAD-1' ? { LeadID: id, ClientName: 'Test Client', PrimaryMobile: '9999999999' } : null,
    find: (collection, key, value) => collection === 'Inventory' && key === 'PropertyID' && value === 'PROP-1'
      ? { PropertyID: 'PROP-1', Title: 'Test Property', Price: 10000000 }
      : null,
    createId: (prefix) => prefix + '-' + (++seq),
    write: (next) => Object.assign(db, next),
    addTimelineEntry: () => {}
  };
}

test('site visit rejects property that is not actively shortlisted', () => {
  const svc = new SiteVisitBookingService(makeRepo({ shortlisted: false }));
  const result = svc.create({
    requirementId: 'REQ-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  }, { userId: 'agent-1' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROPERTY_NOT_SHORTLISTED');
});

test('site visit validates date and time formats', () => {
  const svc = new SiteVisitBookingService(makeRepo());

  const badDate = svc.create({
    requirementId: 'REQ-1',
    propertyIds: ['PROP-1'],
    visitDate: '01-10-2026',
    visitTime: '11:00'
  });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /YYYY-MM-DD/);

  const badTime = svc.create({
    requirementId: 'REQ-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '25:99'
  });
  assert.equal(badTime.ok, false);
  assert.match(badTime.error, /visitTime is invalid/);
});

test('site visit creates when property is shortlisted and slot is valid', () => {
  const repo = makeRepo();
  const svc = new SiteVisitBookingService(repo);
  const result = svc.create({
    requirementId: 'REQ-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  }, { userId: 'agent-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.RequirementID, 'REQ-1');
  assert.equal(result.data.PropertyCount, 1);
  assert.equal(repo.read().SiteVisits.length, 1);
  assert.equal(repo.read().SiteVisits[0].ShortlistID, null);
});
