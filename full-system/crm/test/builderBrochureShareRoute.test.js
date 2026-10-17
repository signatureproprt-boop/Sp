'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { __test } = require('../server');

function response() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

test('public brochure links reject unknown and expired tokens without exposing PDFs', async () => {
  const token = 'a'.repeat(64);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  let rows = [];
  __test.setRuntimeForTest({ repository: {
    find(collection, field, value) {
      assert.equal(collection, 'BuilderBrochureShares');
      assert.equal(field, 'TokenHash');
      return rows.find(row => row.TokenHash === value) || null;
    }
  } });
  const url = new URL(`https://example.com/api/v2/brochure-shares/${token}`);
  const req = { method: 'GET', headers: {} };
  const missing = response();
  await __test.handleApi(req, missing, url);
  assert.equal(missing.status, 404);
  rows = [{ TokenHash: hash, ProjectID: 'P1', ExpiresAt: '2000-01-01T00:00:00Z' }];
  const expired = response();
  await __test.handleApi(req, expired, url);
  assert.equal(expired.status, 404);
  rows = [{ TokenHash: hash, ProjectID: 'P1', ProjectSlug: 'vesu-heights', ExpiresAt: '2099-01-01T00:00:00Z' }];
  const wrongProject = response();
  await __test.handleApi(req, wrongProject,
    new URL(`https://signatureproperties.cloud.run/brochure/different-project/${token}`));
  assert.equal(wrongProject.status, 404);
});

test('recipient tracking requires a name, phone and explicit share channel', () => {
  const normalize = __test.normalizeBrochureRecipient;
  assert.deepEqual(normalize({ recipientName: '  Asha   Shah ', recipientPhone: '+91 98765 43210', channel: 'whatsapp_text' }),
    { name: 'Asha Shah', phone: '919876543210', channel: 'whatsapp_text' });
  assert.equal(normalize({ recipientName: 'Asha', recipientPhone: 'no phone', channel: 'whatsapp_text' }), null);
  assert.equal(normalize({ recipientName: '', recipientPhone: '9876543210', channel: 'pdf_share' }), null);
  assert.equal(normalize({ recipientName: 'Asha', recipientPhone: '9876543210', channel: 'unknown' }), null);
});

test('project share page uses token scope, hides internal data and respects selected layout', async () => {
  const token='b'.repeat(64),hash=crypto.createHash('sha256').update(token).digest('hex');
  const project={ProjectID:'P1',CompanyID:'C1',ProjectName:'<script>bad</script>',Notes:'PRIVATE NOTE',SalesPersonPhone:'PRIVATE PHONE',ConfigDetails:[{Type:'Apartment',BHK:2,CarpetAreaSqft:764},{Type:'Apartment',BHK:3,CarpetAreaSqft:1209}],Photos:[]};
  const share={TokenHash:hash,ProjectID:'P1',CompanyID:'C1',ExpiresAt:'2099-01-01T00:00:00Z',RecipientName:'PRIVATE CLIENT',SelectedConfiguration:project.ConfigDetails[0]};
  __test.setRuntimeForTest({repository:{find:collection=>collection==='BuilderBrochureShares'?share:project}});
  const url=new URL(`https://example.com/api/v2/brochure-shares/${token}?view=project`),res=response();
  await __test.handleApi({method:'GET',headers:{}},res,url);
  assert.equal(res.status,200);assert.match(res.headers['Content-Type'],/text\/html/);
  assert.match(res.body,/764 sqft/);assert.doesNotMatch(res.body,/1209 sqft|PRIVATE NOTE|PRIVATE PHONE|PRIVATE CLIENT|<script>bad/);
  assert.match(res.body,/&lt;script&gt;bad/);assert.equal(res.headers['Referrer-Policy'],'no-referrer');
  assert.equal(res.headers['X-Robots-Tag'],'noindex, nofollow');
  share.CompanyID='OTHER';const mismatch=response();await __test.handleApi({method:'GET',headers:{}},mismatch,url);assert.equal(mismatch.status,404);
});

test('shared project images cannot address another project asset',async()=>{
  const token='c'.repeat(64),share={ProjectID:'P1',ExpiresAt:'2099-01-01T00:00:00Z'};
  __test.setRuntimeForTest({repository:{find:collection=>collection==='BuilderBrochureShares'?share:{ProjectID:'P1',Photos:[{MediaID:'owned',verified:true,StoragePath:'stored'}]}}});
  const res=response();await __test.handleApi({method:'GET',headers:{}},res,new URL(`https://example.com/api/v2/brochure-shares/${token}?asset=image&id=foreign`));
  assert.equal(res.status,404);
});

test('shared plan cards filter BHK, use owned mapped images and retain missing area labels',()=>{
  const {renderProjectSharePage}=require('../src/services/projectSharePage');
  const p={ProjectName:'Test',Photos:[{MediaID:'owned',verified:true,StoragePath:'stored'}],ConfigDetails:[{Type:'Apartment',BHK:2,CarpetAreaSqft:764.24,PriceMin:7000000,FloorPlanMediaID:'owned'},{Type:'Apartment',BHK:3,CarpetAreaSqft:1209.43,PriceMin:11300000,FloorPlanMediaID:'foreign'}]};
  const html=renderProjectSharePage(p,{},'/brochure/test/token','3');
  assert.match(html,/1209.43 sqft/);assert.doesNotMatch(html,/764.24 sqft/);assert.match(html,/₹1,13,00,000/);assert.match(html,/Floor plan image not provided/);assert.doesNotMatch(html,/id=foreign/);
  assert.match(html,/Super built-up \/ Saleable/);assert.match(html,/Not provided/);
});
