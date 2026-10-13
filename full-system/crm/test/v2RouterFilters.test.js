'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { V2Router } = require('../src/api/v2Router');

function routerForFilters() {
  return Object.create(V2Router.prototype);
}

test('client location filter requires a real match when requirement has locations', () => {
  const router = routerForFilters();

  assert.equal(router._reqMatchesFilters({
    Location1: 'Vesu',
    Location2: 'Adajan'
  }, { location: 'vesu' }, []), true);

  assert.equal(router._reqMatchesFilters({
    Location1: 'Vesu',
    Location2: 'Adajan'
  }, { location: 'City Light' }, []), false);

  assert.equal(router._reqMatchesFilters({
    Location1: '',
    Location2: ''
  }, { location: 'Vesu' }, []), false);
});

test('client location filter is case-insensitive and matches either location slot', () => {
  const router = routerForFilters();

  assert.equal(router._reqMatchesFilters({
    Location1: 'vesu',
    Location2: 'PAL'
  }, { location: 'PAL' }, []), true);

  assert.equal(router._reqMatchesFilters({
    Location1: 'vesu',
    Location2: 'PAL'
  }, { location: 'city' }, []), false);
});

test('client workspace rejects duplicate LeadIDs instead of opening the wrong client', async () => {
  const router = routerForFilters();
  router.repo = {
    list: (collection) => collection === 'Leads' ? [
      { LeadID: 'COMM-0057', ClientName: 'Kenil Shah' },
      { LeadID: 'COMM-0057', ClientName: 'Dr Arohi' }
    ] : []
  };
  router.actorResolver = () => ({ userId: 'USR-TEST-ADMIN', role: 'ADMIN' });

  const response = await router.handle(
    { method: 'GET', headers: {} },
    null,
    new URL('https://crm.test/api/clients/COMM-0057/workspace'),
    null
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'AMBIGUOUS_CLIENT_ID');
  assert.match(response.body.error, /multiple client records/i);
});

test('Sale list includes Sheet basics and captured purpose before a deal, without duplicates', () => {
  const router=routerForFilters();
  const db={Leads:[
    {LeadID:'sheet',SheetBasicRequirements:[{TransactionType:'Sale'},{TransactionType:'Sale'}]},
    {LeadID:'captured',RequirementType:'Sale'},
    {LeadID:'confirmed'},
    {LeadID:'rent',SheetBasicRequirements:[{TransactionType:'Rent'}]},
    {LeadID:'unknown'}
  ],Requirements:[{LeadID:'confirmed',TransactionType:'Sell'}],Transactions:[]};
  router.repo={read:()=>db};
  router._enrichClientsForList=rows=>rows;
  assert.deepEqual(router._queryClientsByNeed({txnType:'Sale'}).data.map(l=>l.LeadID),['sheet','captured','confirmed']);
  assert.equal(db.Requirements.length,1);
  assert.equal(db.Transactions.length,0);
  assert.equal(router._queryClientsByNeed({txnType:'Sale',category:'Residential'}).totalCount,0);
});


test('Sale Sheet filter keeps imported Purchase purpose and includes only that source group', () => {
  const router=routerForFilters();
  router.repo={read:()=>({Leads:[
    {LeadID:'sale',SheetBasicRequirements:[{SourceTab:'Sale',TransactionType:'Purchase'}]},
    {LeadID:'rent',SheetBasicRequirements:[{SourceTab:'Rent',TransactionType:'Rent'}]},
    {LeadID:'manual',RequirementType:'Sale'}
  ]})};
  router._enrichClientsForList=rows=>rows;
  assert.deepEqual(router._queryClientsByNeed({sourceTab:'Sale'}).data.map(l=>l.LeadID),['sale']);
  assert.deepEqual(router._queryClientsByNeed({sourceTab:'Sale',txnType:'Purchase'}).data.map(l=>l.LeadID),['sale']);
});

test('single quoted Sheet budget participates in bounded filters without treating missing budgets as matches',()=>{
 const router=routerForFilters();
 assert.equal(router._reqMatchesFilters({BudgetMax:7500000},{budgetMin:5000000,budgetMax:9999999},[]),true);
 assert.equal(router._reqMatchesFilters({BudgetMax:45000},{budgetMax:4999999},[]),true);
 assert.equal(router._reqMatchesFilters({BudgetMax:7500000},{budgetMax:4999999},[]),false);
 assert.equal(router._reqMatchesFilters({},{budgetMax:4999999},[]),false);
});
