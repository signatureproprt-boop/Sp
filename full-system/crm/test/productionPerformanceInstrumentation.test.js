'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

assert.ok(source.includes("function startApiPerformanceTrace(req, res, endpoint)"), 'performance trace helper missing');
assert.ok(source.includes("SIG_REALTY_PERF_LOG"), 'performance log feature flag missing');
assert.ok(source.includes("startApiPerformanceTrace(req, res, 'inventory.list')"), 'inventory performance instrumentation missing');
assert.ok(source.includes("startApiPerformanceTrace(req, res, 'builder-projects.list')"), 'builder project performance instrumentation missing');
assert.ok(source.includes("payloadBytes"), 'response payload measurement missing');
assert.ok(source.includes("authorizationMs"), 'authorization timing measurement missing');

console.log('production performance instrumentation: PASS');
