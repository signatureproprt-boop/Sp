'use strict';

// Repair legacy BuilderProjects that predate tenant scoping. Dry-run by default.
// Apply requires an exact expected count, a single active tenant, and a local backup.
const { MongoClient, EJSON } = require('mongodb');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOCK = 'db-snapshot-write';
const SNAP = 'singleton';
const apply = process.env.TENANT_REPAIR_APPLY === 'true';

function plan(snapshot) {
  const payload = snapshot?.payload;
  if (!payload || !Array.isArray(payload.BuilderProjects)) throw new Error('BuilderProjects snapshot missing');
  const users = (payload.Users || []).filter(u => String(u.Status || '').toUpperCase() === 'ACTIVE');
  const tenants = new Set(users.map(u => [
    String(u.CompanyID || u.CompanyId || '').trim(),
    String(u.BrokerageID || u.BrokerageId || '').trim()
  ].join('/')));
  if (tenants.size !== 1) throw new Error('Expected exactly one active tenant');
  const [companyId, brokerageId] = [...tenants][0].split('/');
  if (!companyId || !brokerageId) throw new Error('Active tenant IDs missing');
  const projects = payload.BuilderProjects;
  const unscoped = projects.filter(p => !p.CompanyID && !p.BrokerageID);
  const partial = projects.filter(p => Boolean(p.CompanyID) !== Boolean(p.BrokerageID));
  const foreign = projects.filter(p => p.CompanyID && p.BrokerageID &&
    (p.CompanyID !== companyId || p.BrokerageID !== brokerageId));
  if (partial.length || foreign.length) throw new Error('Mixed or partial tenant data; manual review needed');
  const ids = new Set(projects.map(p => p.ProjectID));
  if (ids.size !== projects.length) throw new Error('Duplicate ProjectID detected');
  return { companyId, brokerageId, total: projects.length, unscoped: unscoped.length };
}

async function main() {
  if (!process.env.MONGO_URL) throw new Error('MONGO_URL required');
  const client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_DB || 'signature_properties');
    const coll = db.collection('db_snapshot');
    const before = await coll.findOne({ _id: SNAP });
    const preview = plan(before);
    if (!apply) {
      console.log('TENANT_REPAIR=' + JSON.stringify({ dryRun: true, writes: 0, ...preview }));
      return;
    }
    const expected = Number(process.env.TENANT_REPAIR_EXPECTED_COUNT);
    if (!Number.isInteger(expected) || expected <= 0 || preview.unscoped !== expected) {
      throw new Error('Expected count does not match; refusing write');
    }
    const locks = db.collection('distributed_locks');
    const owner = require('node:crypto').randomBytes(16).toString('hex');
    const now = new Date();
    const claim = await locks.findOneAndUpdate(
      { _id: LOCK, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + 120000), updatedAt: now },
        $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: 'after' });
    const lock = claim?.value || claim;
    if (lock?.owner !== owner) throw new Error('Snapshot lock busy; retry later');
    try {
      const current = await coll.findOne({ _id: SNAP });
      const check = plan(current);
      if (check.unscoped !== expected || check.companyId !== preview.companyId ||
          check.brokerageId !== preview.brokerageId) throw new Error('Snapshot changed; retry dry run');
      const backupDir = path.join(os.homedir(), '.signature-crm-backups');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backup = path.join(backupDir, 'builder-tenant-backup-' + Date.now() + '.ejson');
      fs.writeFileSync(backup, EJSON.stringify(current), { mode: 0o600, flag: 'wx' });
      const payload = { ...current.payload, BuilderProjects: current.payload.BuilderProjects.map(p =>
        !p.CompanyID && !p.BrokerageID
          ? { ...p, CompanyID: check.companyId, BrokerageID: check.brokerageId }
          : p
      ) };
      const result = await coll.replaceOne(
        { _id: SNAP, updatedAt: current.updatedAt },
        { ...current, payload, updatedAt: new Date() });
      if (result.matchedCount !== 1) throw new Error('Snapshot changed during repair; backup retained');
      const verified = plan(await coll.findOne({ _id: SNAP }));
      if (verified.unscoped !== 0) throw new Error('Post-write verification failed; backup retained');
      console.log('TENANT_REPAIR=' + JSON.stringify({
        dryRun: false, repaired: expected, total: verified.total, backup
      }));
    } finally {
      await locks.deleteOne({ _id: LOCK, owner });
    }
  } finally { await client.close(); }
}
if (require.main === module) main().catch(e => {
  console.error('TENANT_REPAIR_FAILED=' + String(e.message || e).replace(
    String(process.env.MONGO_URL || ''), '[redacted]'));
  process.exitCode = 1;
});
module.exports = { plan };
