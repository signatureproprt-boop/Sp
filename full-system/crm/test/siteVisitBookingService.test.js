'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SiteVisitBookingService } = require('../src/services/siteVisitBookingService');

function makeRepo({ shortlisted = true } = {}) {
  let seq = 0;
  const db = {
    SiteVisits: [],
    Shortlists: shortlisted ? [{ TransactionID: 'TXN-1', PropertyID: 'PROP-1', Status: 'Active' }] : []
  };
  return {
    read: () => db,
    readLead: (id) => id === 'LEAD-1' ? { LeadID: id, ClientName: 'Test Client', PrimaryMobile: '9999999999' } : null,
    find: (collection, key, value) => {
      if (collection === 'Transactions' && key === 'TransactionID' && value === 'TXN-1') {
        return { TransactionID: 'TXN-1', LeadID: 'LEAD-1' };
      }
      if (collection === 'Inventory' && key === 'PropertyID' && value === 'PROP-1') {
        return { PropertyID: 'PROP-1', Title: 'Test Property', Price: 10000000 };
      }
      return null;
    },
    createId: (prefix) => prefix + '-' + (++seq),
    write: (next) => Object.assign(db, next),
    addTimelineEntry: () => {}
  };
}

test('site visit rejects property that is not actively shortlisted', () => {
  const svc = new SiteVisitBookingService(makeRepo({ shortlisted: false }));
  const result = svc.create({
    transactionId: 'TXN-1',
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
    transactionId: 'TXN-1',
    propertyIds: ['PROP-1'],
    visitDate: '01-10-2026',
    visitTime: '11:00'
  });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /YYYY-MM-DD/);

  const badTime = svc.create({
    transactionId: 'TXN-1',
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
    transactionId: 'TXN-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  }, { userId: 'agent-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.TransactionID, 'TXN-1');
  assert.equal(result.data.PropertyCount, 1);
  assert.equal(repo.read().SiteVisits.length, 1);
  assert.equal(repo.read().SiteVisits[0].ShortlistID, null);
});


test('site visit rejects unsupported property changes instead of silently ignoring them', () => {
  const repo = makeRepo();
  const svc = new SiteVisitBookingService(repo);
  const created = svc.create({
    transactionId: 'TXN-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  });
  assert.equal(created.ok, true);

  const result = svc.update(created.data.VisitBookingID, {
    propertyIds: ['PROP-1']
  }, { userId: 'agent-1' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROPERTY_CHANGE_UNSUPPORTED');
});

test('legacy malformed slot can still be cancelled without slot validation', () => {
  const repo = makeRepo();
  repo.read().SiteVisits.push({
    VisitID: 'VISIT-LEGACY-1',
    VisitBookingID: 'BOOK-LEGACY-1',
    LeadID: 'LEAD-1',
    TransactionID: 'TXN-1',
    PropertyID: 'PROP-1',
    VisitDate: '',
    VisitTime: 'invalid',
    Status: 'Scheduled',
    CreatedAt: '2026-01-01T00:00:00.000Z',
    UpdatedAt: '2026-01-01T00:00:00.000Z'
  });
  const svc = new SiteVisitBookingService(repo);

  const result = svc.cancel('BOOK-LEGACY-1', { userId: 'agent-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.Status, 'Cancelled');
});

test('legacy malformed slot can still be completed without slot validation', () => {
  const repo = makeRepo();
  repo.read().SiteVisits.push({
    VisitID: 'VISIT-LEGACY-2',
    VisitBookingID: 'BOOK-LEGACY-2',
    LeadID: 'LEAD-1',
    TransactionID: 'TXN-1',
    PropertyID: 'PROP-1',
    VisitDate: 'bad-date',
    VisitTime: 'bad-time',
    Status: 'Scheduled',
    CreatedAt: '2026-01-01T00:00:00.000Z',
    UpdatedAt: '2026-01-01T00:00:00.000Z'
  });
  const svc = new SiteVisitBookingService(repo);

  const result = svc.complete('BOOK-LEGACY-2', { userId: 'agent-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.Status, 'Completed');
});

test('site visit rejects invalid explicit reschedule slot', () => {
  const repo = makeRepo();
  const svc = new SiteVisitBookingService(repo);
  const created = svc.create({
    transactionId: 'TXN-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  });
  assert.equal(created.ok, true);

  const result = svc.update(created.data.VisitBookingID, {
    visitDate: '2026-99-99',
    visitTime: '11:00'
  }, { userId: 'agent-1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /visitDate is invalid/);
});

test('site visit accepts valid reschedule', () => {
  const repo = makeRepo();
  const svc = new SiteVisitBookingService(repo);
  const created = svc.create({
    transactionId: 'TXN-1',
    propertyIds: ['PROP-1'],
    visitDate: '2026-10-01',
    visitTime: '11:00'
  });
  assert.equal(created.ok, true);

  const result = svc.update(created.data.VisitBookingID, {
    visitDate: '2026-10-02',
    visitTime: '14:30'
  }, { userId: 'agent-1' });

  assert.equal(result.ok, true);
  assert.equal(result.data.VisitDate, '2026-10-02');
  assert.equal(result.data.VisitTime, '14:30');
});
