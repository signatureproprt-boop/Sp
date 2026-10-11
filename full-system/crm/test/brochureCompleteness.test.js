'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReview, reviewPrompt, countPdfPages } = require('../src/services/brochureCompletenessService');
const candidate = { ConfigDetails: [{ Type: 'Apartment', CarpetAreaSqft: 2420 }] };
test('rejects the actual Livonia failure: terrace evidence exists but only regular flats were extracted', () => {
  const { validatePrivateTerraces } = require('../src/services/brochureCompletenessService');
  const data = {...candidate,SourceEvidence:['Page 22: Tower A Terrace Floor Plan, Private Terrace 1051.00 sq.ft. each']};
  assert.throws(() => validatePrivateTerraces(data), /1051 sqft is missing/);
  data.ConfigDetails = [{Type:'Terrace Flat',TerraceAreaSqft:1051}];
  assert.doesNotThrow(() => validatePrivateTerraces(data));
  data.SourceEvidence = ['Page 24: Private Terrace 1079.00 sq.ft. and 1361.00 sq.ft.'];
  data.ConfigDetails = [{Type:'Terrace Flat',TerraceAreaSqft:1079}];
  assert.throws(() => validatePrivateTerraces(data), /1361 sqft is missing/);
});
const good = () => ({ Complete: true, Pages: [{Page:1,Kind:'floor plan',HasConfigurations:true},{Page:2,Kind:'terrace plan',HasConfigurations:true}], ConfigChecks:[{Index:0,Supported:true}], Findings:[] });
test('requires exactly every PDF page, not an asserted complete flag', () => {
  const review = good(); review.Pages.pop(); assert.throws(() => validateReview(review,candidate,2), /pages were not reviewed/);
  review.Pages.push({...review.Pages[0]}); assert.throws(() => validateReview(review,candidate,2), /invalid page coverage/);
});
test('Livonia private terrace omission prevents success even when regular apartment is supported', () => {
  const review = good(); review.Findings.push({Page:2,Issue:'Tower A private terraces 1051 sqft omitted'});
  assert.throws(() => validateReview(review,candidate,2), /private terraces 1051/);
  assert.match(reviewPrompt(candidate,2), /PRIVATE TERRACE/);
});
test('unchecked or unsupported configurations cannot pass', () => {
  const review = good(); review.ConfigChecks[0].Supported = false; assert.throws(() => validateReview(review,candidate,2), /unsupported/);
  review.ConfigChecks = []; assert.throws(() => validateReview(review,candidate,2), /every configuration/);
});
test('floor plan pages cannot pass with no extracted configurations', () => assert.throws(() => validateReview({...good(),ConfigChecks:[]},{ConfigDetails:[]},2), /layouts missing/));
test('complete checks are labelled automated, not human verification', () => assert.equal(validateReview(good(),candidate,2).Status,'automated_checks_passed'));
test('malformed review fails closed', () => assert.throws(() => validateReview({Complete:true},candidate,2), /incomplete/));
if (process.env.BROCHURE_REVIEW_PDF) test('counts actual source pages independently', async () => {
  const bytes = await require('node:fs/promises').readFile(process.env.BROCHURE_REVIEW_PDF);
  assert.equal(await countPdfPages(bytes),35);
});
