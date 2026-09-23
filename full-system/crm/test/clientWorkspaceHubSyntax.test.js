const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('clients workspace browser script parses as JavaScript', () => {
  const file = path.join(__dirname, '..', 'client-workspace-hub.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.length > 1000, 'clients workspace script is unexpectedly small');
  assert.doesNotThrow(() => new Function(source), 'clients workspace script must parse');
});
