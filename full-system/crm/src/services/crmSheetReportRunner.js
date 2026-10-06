'use strict';

function createReportRunner({ mongoStore, env = process.env, serviceFactory, now = () => Date.now() }) {
  let running = null;
  let last = { state: 'NOT_RUN' };
  const configured = () => Boolean(String(env.CRM_REPORT_SHEET_ID || '').trim());
  async function run() {
    if (!configured()) return { ok: false, state: 'DISABLED' };
    if (running) return running;
    running = (async () => {
      if (!mongoStore.isInitialized()) return { ok: false, state: 'MONGO_UNAVAILABLE' };
      try {
        const lock = await mongoStore.withDistributedLock('crm-sheet-report', async () => {
          const began = now();
          // Read persisted authoritative data AFTER acquiring the cross-instance
          // lock, not a potentially stale instance-local repository cache.
          const snapshot = await mongoStore.getDb().collection('db_snapshot').findOne({ _id: 'singleton' }, {
            projection: { payload: 1, updatedAt: 1 }, maxTimeMS: 10000
          });
          if (!snapshot?.payload || !Array.isArray(snapshot.payload.Leads)) throw new Error('CRM snapshot unavailable');
          if (now() - began > 30000) throw new Error('Snapshot read timed out');
          let service;
          if (serviceFactory) service = serviceFactory();
          else {
            const { google } = require('googleapis');
            const { createDriveAuth } = require('./googleDriveClient');
            const { CrmSheetReportService } = require('./crmSheetReportService');
            service = new CrmSheetReportService({
              sheets: google.sheets({ version: 'v4', auth: createDriveAuth(env) }),
              spreadsheetId: env.CRM_REPORT_SHEET_ID, sourceSheetId: env.GOOGLE_SHEET_ID
            });
          }
          const result = await service.sync(snapshot.payload, snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : 'Unknown');
          last = { ...result, state: result.complete ? 'SYNCED' : 'NEEDS_REVIEW', finishedAt: new Date(now()).toISOString() };
          return last;
        }, { leaseMs: 5 * 60 * 1000 });
        return lock.acquired ? lock.result : { ok: false, state: 'BUSY' };
      } catch (error) {
        // Keep API credentials, upstream payloads and client data out of logs.
        const code = Number(error?.response?.status || error?.code);
        last = { ok: false, state: 'ERROR', code: Number.isFinite(code) ? code : null,
          message: 'Report sync failed. Check reporting workbook access, headers and CRM data.',
          finishedAt: new Date(now()).toISOString() };
        console.error('[crm-sheet-report]', JSON.stringify(last));
        return last;
      }
    })();
    try { return await running; } finally { running = null; }
  }
  return { run, status: () => ({ configured: configured(), spreadsheetId: env.CRM_REPORT_SHEET_ID || null, ...last }) };
}

module.exports = { createReportRunner };
