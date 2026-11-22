'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { V2FormRegistry } = require('../src/data/v2Config');

test('residential form registry covers every property type for each transaction', () => {
  const types = ['Flat', 'Terrace Flat', 'Villa', 'Row House', 'Bungalow', 'Penthouse', 'Studio', 'Duplex', 'Builder Floor', 'Independent House', 'Residential Plot'];
  const transactions = ['Purchase', 'Sale', 'Rent', 'Rent Out', 'Lease', 'Lease Out'];
  for (const transaction of transactions) {
    for (const type of types) {
      assert.ok(V2FormRegistry[`${transaction}|Residential|${type}`], `${transaction} / ${type} form exists`);
    }
  }
});

test('residential requirements include buyer choices and named amenities', () => {
  const form = V2FormRegistry['Purchase|Residential|Flat'];
  assert.deepEqual(form.fields.propertyAge.options, [
    'New Project', 'Ready New', 'Resale up to 5 Years', 'Resale 5-10 Years',
    'Resale 10+ Years', 'Both New & Resale', 'Any'
  ]);
  assert.ok(form.fields.servantRoom);
  assert.ok(form.fields.amenities.options.includes('Swimming Pool'));
  assert.ok(form.fields.amenities.options.includes('24×7 Security'));
  assert.equal(form.fields.amenities.fieldType, 'MultiSelect');
});

test('residential sale form uses asking price and captures occupancy', () => {
  const form = V2FormRegistry['Sale|Residential|Bungalow'];
  assert.equal(form.fields.budgetMin.fieldLabel, 'Expected Asking Price Min (₹)');
  assert.equal(form.fields.budgetMax.fieldLabel, 'Expected Asking Price Max (₹)');
  assert.deepEqual(form.fields.ownerOccupancy.options, ['Owner Occupied', 'Tenant Occupied', 'Vacant']);
  assert.ok(form.fields.plotAreaMin);
  assert.ok(form.fields.servantRoom);
});

test('terrace and independent-home fields only appear for matching house types', () => {
  const terrace = V2FormRegistry['Purchase|Residential|Terrace Flat'].fields;
  const bungalow = V2FormRegistry['Purchase|Residential|Bungalow'].fields;
  const flat = V2FormRegistry['Purchase|Residential|Flat'].fields;
  assert.ok(terrace.terraceRequired);
  assert.ok(terrace.terraceArea);
  assert.ok(bungalow.privateGarden);
  assert.ok(bungalow.floorsCount);
  assert.equal(flat.terraceRequired, undefined);
  assert.equal(flat.privateGarden, undefined);
});

test('client form labels sale, rent, and lease prices by deal direction', () => {
  const html = fs.readFileSync(path.join(__dirname, '../client-workspace.html'), 'utf8');
  assert.match(html, /isSale = \/\^\(sale\|sell\)\$\/i\.test\(transaction\)/);
  assert.match(html, /Expected Asking Price/);
  assert.match(html, /Monthly Rent/);
  assert.match(html, /Lease Budget/);
});
