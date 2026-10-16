'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewPrompt, validateReview } = require('../src/services/brochureCompletenessService');

const data = { ProjectName: 'Kronis', ConfigDetails: [{ Tower: 'I/J', Type: 'Apartment', BHK: 4 }],
  SourceEvidence: ['Page 11: I/J has 4 bedrooms'], Overview: '4 BHK homes' };
const check = { Index: 0, Supported: true, Page: 1, BedroomCount: 4, BedroomCountSource: 'Four labelled rooms in one apartment' };
function review() { return { Complete: true, Pages: [
  { Page: 1, Kind: 'floor plan', HasConfigurations: true },
  { Page: 2, Kind: 'terrace plan', HasConfigurations: true }
], ConfigChecks: [{ ...check }], Findings: [] }; }

test('bedroom audit does not see the extracted answer or generated supporting claims', () => {
  const candidate = JSON.parse(reviewPrompt(data, 11).split('Candidate: ')[1]);
  assert.equal(candidate.ConfigDetails[0].BHK, null);
  assert.equal(candidate.SourceEvidence, undefined);
  assert.doesNotMatch(candidate.Overview, /4\s*BHK/i);
  assert.equal(data.ConfigDetails[0].BHK, 4);
  assert.equal(data.SourceEvidence.length, 1);
});

test('a checked apartment cannot hide a later unrepresented terrace-plan page', () => {
  assert.throws(() => validateReview(review(), data, 2), e =>
    e.code === 'BROCHURE_REVIEW_FINDINGS' && /page 2/.test(e.message));
});

test('known identical layouts can cite multiple original source pages', () => {
  const r = review(); r.ConfigChecks[0].Pages = [1, 2];
  assert.equal(validateReview(r, data, 2).Status, 'automated_checks_passed');
});

test('unknown BHK still needs a floor-plan source page', () => {
  const r = review(); delete r.ConfigChecks[0].Page;
  assert.throws(() => validateReview(r, {ConfigDetails:[{Type:'Terrace Flat'}]}, 2), /page-bound/);
});

test('a cover page cannot support a floor-plan configuration', () => {
  const r = review(); r.Pages[0].HasConfigurations = false;
  assert.throws(() => validateReview(r, data, 2), /source page/);
});

test('a printed kids pool missing from the candidate cannot pass an asserted complete review', () => {
  const r = {Complete:true,Pages:[{Page:1,Kind:'amenities',HasConfigurations:false}],ConfigChecks:[],Findings:[],
    AmenityInventory:[{Page:1,Label:'Swimming pool',CandidateIndex:0},{Page:1,Label:'Kids pool',CandidateIndex:null}]};
  assert.throws(() => validateReview(r, {Amenities:['Swimming pool'],ConfigDetails:[]}, 1), e =>
    e.code === 'BROCHURE_REVIEW_FINDINGS' && /Kids pool/.test(e.message));
  r.AmenityInventory[1].CandidateIndex=0;
  assert.throws(() => validateReview(r, {Amenities:['Swimming pool'],ConfigDetails:[]}, 1), /separate printed pool/);
  r.AmenityInventory[1].CandidateIndex=1;
  assert.equal(validateReview(r, {Amenities:['Swimming pool','Children swimming pool'],ConfigDetails:[]}, 1).Status,'automated_checks_passed');
});

test('every extracted amenity requires printed page evidence, with aliases matched by index', () => {
  const r = {Complete:true,Pages:[{Page:1,Kind:'amenities',HasConfigurations:false}],ConfigChecks:[],Findings:[],
    AmenityInventory:[{Page:1,Label:'GYM AREA',CandidateIndex:0}]};
  assert.equal(validateReview(r,{Amenities:['Gym'],ConfigDetails:[]},1).Status,'automated_checks_passed');
  assert.throws(() => validateReview(r,{Amenities:['Gym','Cinema'],ConfigDetails:[]},1), /Cinema/);
});

test('numeric areas require the correct printed total, configuration and unit', () => {
  const candidate={ConfigDetails:[{Type:'Apartment',CarpetAreaSqft:1076.39}]};
  const r={Complete:true,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true}],Findings:[],ConfigChecks:[{Index:0,Supported:true,Page:1}]};
  assert.throws(()=>validateReview(r,candidate,1),/lacks printed total area evidence/);
  r.AreaChecks=[{ConfigIndex:0,Field:'CarpetAreaSqft',Page:1,PrintedValue:100,PrintedUnit:'sqm',Label:'R.C.A.'}];
  assert.equal(validateReview(r,candidate,1).AreaChecks[0].PrintedUnit,'sqm');
  r.AreaChecks[0].Label='BEDROOM dimensions';
  assert.throws(()=>validateReview(r,candidate,1),/unsupported printed area/);
  r.AreaChecks[0].Label='Carpet area';r.AreaChecks[0].PrintedUnit='sqft';
  assert.throws(()=>validateReview(r,candidate,1),/printed area conflicts/);
});

test('ordinary built-up and a common terrace cannot masquerade as saleable or private area', () => {
  for (const [Field,Label] of [['SuperBuiltUpAreaSqft','Built-up area'],['TerraceAreaSqft','Common private terrace']]) {
    const candidate={ConfigDetails:[{Type:'Terrace Flat',[Field]:500}]};
    const r={Complete:true,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true}],Findings:[],ConfigChecks:[{Index:0,Supported:true,Page:1}],
      AreaChecks:[{ConfigIndex:0,Field,Page:1,PrintedValue:500,PrintedUnit:'sqft',Label}]};
    assert.throws(()=>validateReview(r,candidate,1),/unsupported printed area/);
  }
});

test('a separate printed area schedule can support an explicitly linked floor plan', () => {
  const candidate={ConfigDetails:[{Type:'Apartment',CarpetAreaSqft:995}]};
  const r={Complete:true,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true},{Page:2,Kind:'area schedule',HasConfigurations:false}],
    Findings:[],ConfigChecks:[{Index:0,Supported:true,Page:1,Pages:[1,2]}],
    AreaChecks:[{ConfigIndex:0,Field:'CarpetAreaSqft',Page:2,PrintedValue:995,PrintedUnit:'sqft',Label:'Carpet area'}]};
  assert.equal(validateReview(r,candidate,2).Status,'automated_checks_passed');
  r.ConfigChecks[0].Pages=[1];
  assert.throws(()=>validateReview(r,candidate,2),/another layout source page/);
});
