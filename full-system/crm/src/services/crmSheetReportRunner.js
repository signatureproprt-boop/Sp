'use strict';

function createReportRunner({ mongoStore, env = process.env, serviceFactory, lockName = 'crm-sheet-report', now = () => Date.now() }) {
  let running = null;
  let last = { state: 'NOT_RUN' };
  const configured = () => Boolean(String(env.CRM_REPORT_SHEET_ID || '').trim());
  async function run() {
    if (!configured()) return { ok: false, state: 'DISABLED' };
    if (running) return running;
    running = (async () => {
      if (!mongoStore.isInitialized()) return { ok: false, state: 'MONGO_UNAVAILABLE' };
      let stage = 'LOCK';
      const progress = value => { stage = value; last = { state: 'RUNNING', stage }; };
      try {
        const lock = await mongoStore.withDistributedLock(lockName, async () => {
          progress('CRM_SNAPSHOT');
          const began = now();
          // Read persisted authoritative data AFTER acquiring the cross-instance
          // lock, not a potentially stale instance-local repository cache.
          const snapshot = await mongoStore.getDb().collection('db_snapshot').findOne({ _id: 'singleton' }, {
            projection: { payload: 1, updatedAt: 1 }, maxTimeMS: 10000
          });
          if (!snapshot?.payload || !Array.isArray(snapshot.payload.Leads)) throw new Error('CRM snapshot unavailable');
          if (now() - began > 150000) throw new Error('Snapshot read timed out');
          let service;
          if (serviceFactory) service = serviceFactory();
          else {
            progress('GOOGLE_AUTH');
            const { google } = require('googleapis');
            const { createDriveAuth } = require('./googleDriveClient');
            const { CrmSheetReportService } = require('./crmSheetReportService');
            service = new CrmSheetReportService({
              sheets: google.sheets({ version: 'v4', auth: createDriveAuth(env) }),
              spreadsheetId: env.CRM_REPORT_SHEET_ID, sourceSheetId: env.GOOGLE_SHEET_ID, onStage: progress
            });
          }
          const result = await service.sync(snapshot.payload, snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : 'Unknown');
          last = { ...result, state: result.complete ? 'SYNCED' : 'NEEDS_REVIEW', finishedAt: new Date(now()).toISOString() };
          return last;
        }, { leaseMs: 10 * 60 * 1000 });
        return lock.acquired ? lock.result : { ok: false, state: 'BUSY' };
      } catch (error) {
        // Keep API credentials, upstream payloads and client data out of logs.
        const code = Number(error?.response?.status || error?.code);
        const text = String(error?.message || '');
        let reason = 'UNKNOWN';
        let message = 'Report sync failed. Check reporting workbook access, headers and CRM data.';
        if (/^Unexpected headers in [\w ]+; no data written$/.test(text) || /^Missing report tab: [\w ]+$/.test(text)) { reason = 'WORKBOOK_SCHEMA'; message = text; }
        else if (/safe scan size|safe length|atomic batch budget|Duplicate or empty report record ID/.test(text)) { reason = 'REPORT_LIMIT'; message = 'Report data exceeds safe reporting limits; no report written.'; }
        else if (/snapshot unavailable|Snapshot read timed out|Mongo store is not initialized/i.test(text)) { reason = 'CRM_SNAPSHOT'; message = 'Saved CRM snapshot unavailable or delayed; report was not generated.'; }
        else if (/timed out|timeout|ETIMEDOUT/i.test(text)) { reason = 'TIMEOUT'; message = 'Report timed out at '+stage+'; check saved state before retrying.'; }
        else if (/Incomplete Google OAuth configuration/.test(text)) { reason = 'GOOGLE_AUTH_CONFIG'; message = 'CRM Google authorization is incomplete.'; }
        else if ([401,403,404].includes(code)) { reason = 'GOOGLE_ACCESS'; message = 'CRM Google account cannot access the reporting workbook (Google '+code+').' ; }
        last = { ok: false, state: 'ERROR', code: Number.isFinite(code) ? code : null,
          reason, stage, message,
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
