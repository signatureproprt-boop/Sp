const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('client workspace inline browser script parses as JavaScript', () => {
  const htmlPath = path.join(__dirname, '..', 'client-workspace.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= 0 && end > start, 'client workspace script block not found');
  const source = html.slice(start + '<script>'.length, end);
  const tmp = path.join(os.tmpdir(), 'signature-client-workspace.js');
  fs.writeFileSync(tmp, source, 'utf8');
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['--check', tmp], { encoding: 'utf8', stdio: 'pipe' }),
    'client workspace inline script must parse'
  );
});
