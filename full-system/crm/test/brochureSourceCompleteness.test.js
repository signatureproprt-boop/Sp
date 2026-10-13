'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateReview,REVIEW_VERSION,reviewPrompt}=require('../src/services/brochureCompletenessService');
const data={ProjectName:'THE ULTIMA',RERANumber:null,ConfigDetails:[{Type:'Apartment',BHK:3,CarpetAreaSqft:null,SuperBuiltUpAreaSqft:null},{Type:'Apartment',BHK:4,CarpetAreaSqft:null,SuperBuiltUpAreaSqft:null}]};
const review=()=>({Complete:false,Pages:[{Page:1,Kind:'floor plan',HasConfigurations:true},{Page:2,Kind:'contact',HasConfigurations:false}],ConfigChecks:[{Index:0,Supported:true},{Index:1,Supported:true}],Findings:[
 {Page:2,Kind:'not_stated',Field:'RERANumber',ConfigIndex:null,Issue:'Printed RERA label is empty'},
 {Page:1,Kind:'not_stated',Field:'CarpetAreaSqft',ConfigIndex:0,Issue:'Only room dimensions; no printed total'},
 {Page:1,Kind:'not_stated',Field:'SuperBuiltUpAreaSqft',ConfigIndex:1,Issue:'No printed saleable total'}
]});
test('actual Ultima not-printed values pass source checks with explicit warnings',()=>{
 const r=validateReview(review(),data,2);assert.equal(r.Version,REVIEW_VERSION);assert.equal(r.Warnings.length,3);assert.equal(r.Status,'automated_checks_passed');
 assert.equal(data.ConfigDetails[0].CarpetAreaSqft,null);
 assert.match(reviewPrompt(data,2),/An empty printed RERA label is not_stated/);
});
test('not-stated findings cannot approve invented values or wrong configuration targets',()=>{
 assert.throws(()=>validateReview(review(),{...data,RERANumber:'invented'},2),/unsupported extracted value/);
 const r=review();r.Findings[1].ConfigIndex=99;assert.throws(()=>validateReview(r,data,2),/exact configuration index/);
 r.Findings[1].ConfigIndex=0;r.Findings[1].Field='Unknown';assert.throws(()=>validateReview(r,data,2),/allowed field/);
});
test('unreadable facts and missed printed totals still block even with not-stated warnings',()=>{
 const r=review();r.Findings.push({Page:1,Kind:'unreadable',Issue:'Printed terrace number cannot be read'});
 assert.throws(()=>validateReview(r,data,2),/Printed terrace/);
 r.Findings.pop();r.Findings.push({Page:1,Kind:'omission',Issue:'Printed carpet 995 sqft was omitted'});
 assert.throws(()=>validateReview(r,data,2),/995 sqft/);
});
test('not-stated findings never replace full page coverage or configuration support',()=>{
 const r=review();r.Pages.pop();assert.throws(()=>validateReview(r,data,2),/pages were not reviewed/);
 const s=review();s.ConfigChecks[1].Supported=false;assert.throws(()=>validateReview(s,data,2),/unsupported/);
});
