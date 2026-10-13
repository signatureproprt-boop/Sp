'use strict';

// Read-only tenant inventory for BuilderProjects in the Mongo snapshot.
// Prints aggregate counts only. Does not write to Mongo or expose project names.
const { MongoClient } = require('mongodb');

async function main() {
  const url = String(process.env.MONGO_URL || '').trim();
  const dbName = String(process.env.MONGO_DB || 'signature_properties').trim();
  if (!url) throw new Error('MONGO_URL is required');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const snapshot = await client.db(dbName).collection('db_snapshot').findOne(
      { _id: 'singleton' }, { projection: { 'payload.BuilderProjects': 1, 'payload.Users': 1, 'payload._BuilderProjectImports': 1 } }
    );
    if (!snapshot?.payload) throw new Error('Mongo snapshot not found');
    const projects = Array.isArray(snapshot.payload.BuilderProjects) ? snapshot.payload.BuilderProjects : [];
    const users = Array.isArray(snapshot.payload.Users) ? snapshot.payload.Users : [];
    const imports = Array.isArray(snapshot.payload._BuilderProjectImports) ? snapshot.payload._BuilderProjectImports : [];
    const tenantCounts = new Map();
    const ids = new Map();
    let unscoped = 0;
    let partialScope = 0;
    let withSourceIdentity = 0;
    let withDriveMedia = 0;
    for (const row of projects) {
      const company = String(row.CompanyID || '').trim();
      const brokerage = String(row.BrokerageID || '').trim();
      if (!company && !brokerage) unscoped++;
      else if (!company || !brokerage) partialScope++;
      const key = company && brokerage ? company + ' / ' + brokerage : '(missing scope)';
      tenantCounts.set(key, (tenantCounts.get(key) || 0) + 1);
      if (row.SourceProjectID || row.SourceUrl) withSourceIdentity++;
      if (['Photos', 'FloorPlans', 'Brochures', 'Videos'].some((field) =>
        Array.isArray(row[field]) && row[field].some((item) => item?.DriveFileID))) withDriveMedia++;
      if (row.ProjectID) ids.set(row.ProjectID, (ids.get(row.ProjectID) || 0) + 1);
    }
    const userTenantCounts = new Map();
    for (const user of users) {
      if (String(user.Status || '').toUpperCase() !== 'ACTIVE') continue;
      const key = String(user.CompanyID || user.CompanyId || '(missing)') + ' / ' +
        String(user.BrokerageID || user.BrokerageId || '(missing)');
      userTenantCounts.set(key, (userTenantCounts.get(key) || 0) + 1);
    }
    process.stdout.write(JSON.stringify({
      dryRun: true,
      writes: 0,
      totalProjects: projects.length,
      unscoped,
      partialScope,
      withSourceIdentity,
      withDriveMedia,
      duplicateProjectIdGroups: [...ids.values()].filter((count) => count > 1).length,
      importHistoryRows: imports.length,
      projectTenants: Object.fromEntries([...tenantCounts].sort()),
      activeUserTenants: Object.fromEntries([...userTenantCounts].sort())
    }, null, 2) + '\n');
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  // Never print Mongo URLs or credentials from nested driver errors.
  console.error('Tenant audit failed:', String(error?.name || 'Error'));
  process.exitCode = 1;
});
