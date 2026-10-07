'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonRepository } = require('../src/data/repository');
const { V2Router } = require('../src/api/v2Router');
const { ShortlistServiceV2 } = require('../src/services/shortlistServiceV2');
const { SiteVisitBookingService } = require('../src/services/siteVisitBookingService');
const { SmartMatchService } = require('../src/services/smartMatchService');
const actor = { userId: 'admin', role: 'ADMIN', companyId: 'C', brokerageId: 'B' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-centric-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = new JsonRepository(path.join(dir, 'db.json'));
  const db = repo.read();
  db.Leads = [{ LeadID: 'L1', ClientName: 'Client One', PrimaryMobile: '9876543210', Phone: '9876543210', ClientStatus: 'New', ClientLifecycle: 'Prospect', CompanyID: 'C', BrokerageID: 'B', SheetBasicRequirements: [{ SourceTab: 'Comm', BudgetMax: 50000 }] },
    { LeadID: 'L2', ClientName: 'Other', PrimaryMobile: '9876543211', CompanyID: 'C', BrokerageID: 'B' }];
  db.Transactions = []; db.Requirements = []; db.Activities = []; db.FollowUps = []; db.Shortlists = []; db.SiteVisits = [];
  db.Inventory = [{ PropertyID: 'P1', Title: 'Flat', Category: 'Residential', SubCategory: 'Flat', ListingFor: 'Sale', Location1: 'Vesu', AskingPrice: 7000000, Status: 'Available' }];
  repo.write(db);
  const router = new V2Router(repo, () => actor);
  return { repo, router, request: (method, route, body = {}) => router.handle({ method, headers: {} }, {}, new URL(route, 'http://localhost'), body) };
}
const need = { TransactionType: 'Purchase', Category: 'Residential', SubCategory: 'Flat', BudgetMax: 8000000, Location1: 'Vesu', BHKMin: 2, RequirementStatus: 'Active', ClientRequestID: 'save-1' };

test('basic client edits, calls and quick capture never create a transaction', async t => {
  const {repo, router, request} = fixture(t);
  const changed = await request('PATCH', '/api/v2/clients/L1', { BudgetMax: 6000000, Location1: 'Pal', BHK: '3' });
  assert.equal(changed.body.ok, true);
  assert.equal(repo.readLead('L1').ClientName, 'Client One');
  assert.equal(repo.readLead('L1').PrimaryMobile, '9876543210');
  assert.equal(repo.readLead('L1').SheetBasicRequirements.length, 1);
  const call = router.actSvc.createActivity({LeadID: 'L1', ActivityType: 'CALL'}, actor);
  assert.equal(call.ok, true);
  assert.equal(repo.read().Transactions.length, 0);
  assert.equal(repo.read().Requirements.length, 0);
  const capture = router.quickCaptureSvc.capture({client: {name: 'New Person', primaryMobile: '9876543212'}, transaction: {transactionType: 'Rent'}, requirement: {category: 'Commercial', BudgetMax: 30000, Location1: 'Vesu'}}, actor);
  assert.equal(capture.ok, true, capture.error);
  assert.equal(capture.transaction, null);
  assert.equal(repo.read().Transactions.length, 0);
  assert.equal(repo.read().Requirements.length, 0);
  assert.equal(repo.readLead(capture.client.leadId).BudgetMax, 30000);
});

test('direct requirement create retries once, edit keeps ID, another need is explicit', async t => {
  const {repo, request} = fixture(t);
  const created = await request('POST', '/api/v2/clients/L1/requirements', need);
  assert.equal(created.body.ok, true, created.body.error);
  const id = created.body.data.RequirementID;
  assert.equal(created.body.data.TransactionID, null);
  const retry = await request('POST', '/api/v2/clients/L1/requirements', need);
  assert.equal(retry.body.data.RequirementID, id);
  const edited = await request('PATCH', '/api/v2/requirements/' + id, {BudgetMax: 9000000, TransactionType: 'Rent', SubCategory: null});
  assert.equal(edited.body.ok, true, edited.body.error);
  assert.equal(edited.body.data.requirement.RequirementID, id);
  assert.equal(edited.body.data.requirement.BudgetMax, 9000000);
  assert.equal(edited.body.data.requirement.TransactionType, 'Rent');
  const second = await request('POST', '/api/v2/clients/L1/requirements', {...need, ClientRequestID: 'save-2'});
  assert.notEqual(second.body.data.RequirementID, id);
  assert.equal(repo.read().Requirements.length, 2);
  assert.equal(repo.read().Transactions.length, 0);
  const ws = await request('GET', '/api/v2/clients/L1/workspace');
  assert.equal(ws.body.data.requirements.length, 2);
  assert.equal(ws.body.data.transactions.length, 0);
});

test('requirement-linked followup, shortlist and visit work before a deal', async t => {
  const {repo, router, request} = fixture(t);
  const created = await request('POST', '/api/v2/clients/L1/requirements', need);
  const id = created.body.data.RequirementID;
  const fuPayload = {LeadID: 'L1', RequirementID: id, DueAt: '2026-11-01T05:30:00Z', ClientRequestID: 'follow-1'};
  assert.equal(router.fuSvc.createFollowUp(fuPayload, actor).ok, true);
  assert.equal(router.fuSvc.createFollowUp(fuPayload, actor).reused, true);
  assert.equal(router.fuSvc.listFollowUps({LeadID: 'L1'}).data[0].RequirementID, id);
  assert.equal(router.fuSvc.createFollowUp({...fuPayload, LeadID: 'L2'}, actor).ok, false);
  const sl = new ShortlistServiceV2(repo);
  assert.equal(sl.add(id, {propertyId: 'P1'}).ok, true);
  assert.equal(sl.add(id, {propertyId: 'P1'}).alreadyShortlisted, true);
  assert.equal(repo.read().Shortlists[0].RequirementID, id);
  assert.equal(repo.read().Shortlists[0].TransactionID, null);
  const visits = new SiteVisitBookingService(repo);
  const booked = visits.create({requirementId: id, propertyIds: ['P1'], visitDate: '2026-11-01', visitTime: '11:00'}, actor);
  assert.equal(booked.ok, true, booked.error);
  assert.equal(visits.listByRequirement(id).length, 1);
  assert.equal(repo.read().SiteVisits[0].RequirementID, id);
  assert.equal(repo.read().Transactions.length, 0);
  assert.equal(new SmartMatchService(repo).matchByRequirementId(id).ok, true);
  assert.equal(router.nextQSvc.getNextQuestions(id).ok, true);
  assert.equal(router.scoringSvc.recalculateRequirementScore(id).ok, true);
  const act = router.actSvc.createActivity({LeadID: 'L1', RequirementID: id, ActivityType: 'CALL'}, actor);
  assert.equal(act.ok, true);
  assert.equal(router.actSvc.listActivitiesByRequirement(id).data.length, 1);
});

test('only Start Deal creates a transaction, repeated action reuses it and wrong client is rejected', async t => {
  const {repo, request} = fixture(t);
  const created = await request('POST', '/api/v2/clients/L1/requirements', need);
  const id = created.body.data.RequirementID;
  const denied = await request('POST', '/api/v2/clients/L2/start-deal', {RequirementID: id});
  assert.equal(denied.statusCode, 404);
  const first = await request('POST', '/api/v2/clients/L1/start-deal', {RequirementID: id});
  assert.equal(first.body.ok, true, first.body.error);
  const again = await request('POST', '/api/v2/clients/L1/start-deal', {RequirementID: id});
  assert.equal(again.body.data.TransactionID, first.body.data.TransactionID);
  assert.equal(repo.read().Transactions.length, 1);
  assert.equal(repo.read().Requirements.length, 1);
  assert.equal(repo.read().Transactions[0].SourceRequirementID, id);
  assert.equal(repo.read().Leads.length, 2);
});

test('Lost and Closed update the same requirement and Sheet projection keeps its stable ID', async t => {
  const {repo, request} = fixture(t);
  const created = await request('POST', '/api/v2/clients/L1/requirements', need);
  const id = created.body.data.RequirementID;
  const lost = await request('PATCH', '/api/v2/requirements/' + id, {RequirementStatus: 'Lost', LostReason: 'No longer looking'});
  assert.equal(lost.body.ok, true, lost.body.error);
  const {buildProjection} = require('../src/services/crmSheetReportService');
  let projection = buildProjection(repo.read());
  assert.equal(projection.Requirements.length, 1);
  assert.equal(projection.Lost.some(row => row[0] === 'REQ:' + id), true);
  assert.equal((await request('PATCH', '/api/v2/requirements/' + id, {RequirementStatus: 'Active'})).body.ok, true);
  assert.equal((await request('PATCH', '/api/v2/requirements/' + id, {RequirementStatus: 'Closed', ClosedReason: 'Completed elsewhere'})).body.ok, true);
  projection = buildProjection(repo.read());
  assert.equal(projection.Closed.some(row => row[0] === 'REQ:' + id), true);
  assert.equal(repo.read().Requirements.length, 1);
  assert.equal(repo.read().Transactions.length, 0);
  const cleared = await request('PATCH', '/api/v2/requirements/' + id, {BudgetMax: null, BHKMin: null});
  assert.equal(cleared.body.data.requirement.Fields.BHKMin.state, 'UNKNOWN');
  assert.equal(cleared.body.data.requirement.BHKMin, null);
});
