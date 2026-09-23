const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('clients workspace browser script parses as JavaScript', () => {
  const file = path.join(__dirname, '..', 'client-workspace-hub.js');
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['--check', file], { encoding: 'utf8', stdio: 'pipe' }),
    'clients workspace script must parse'
  );
});
