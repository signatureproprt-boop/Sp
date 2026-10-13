'use strict';
const { google } = require('googleapis');
const PROJECT = 'signature-509218', REGION = 'asia-south1', SERVICE = 'signature-realty-crm';
function reasonFor(error) {
  const reasons = (error?.response?.data?.error?.details || []).map(d => d.reason).concat((error?.response?.data?.error?.errors || []).map(d => d.reason));
  const text = String(error?.message || '');
  if (reasons.some(r => ['SERVICE_DISABLED','accessNotConfigured'].includes(r))) return 'API_DISABLED';
  if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(text)) return 'OAUTH_SCOPE';
  if (/space quota|Writes are blocked|over your.*quota/i.test(text)) return 'DATABASE_QUOTA';
  if (/timed out|timeout|ETIMEDOUT/i.test(text)) return 'TIMEOUT';
  if ([401,403].includes(Number(error?.response?.status || error?.code))) return 'PERMISSION_DENIED';
  return 'UNAVAILABLE';
}
function summarizeEntry(entry) {
  const text = String(entry.textPayload || '');
  let detail = {}; try { detail = JSON.parse(text.slice(text.indexOf('{'))); } catch (_) {}
  const component = text.startsWith('[mongoStore]') ? 'Mongo save' : text.startsWith('[crm-sheet-report]') ? 'Management Sheet' : text.startsWith('[perf]') ? 'API timing' : 'CRM';
  let event = 'Diagnostic event';
  if (/write succeeded/.test(text)) event = 'Save confirmed';
  else if (/write.*failed|write exhausted/.test(text)) event = 'Save failed';
  else if (/lock.*busy|lock.*contention/.test(text)) event = 'Waiting for save lock';
  else if (component === 'Management Sheet') event = detail.ok ? 'Sheet synced' : 'Sheet sync failed';
  else if (component === 'API timing') event = 'Request completed';
  const rawReason = reasonFor({message:text});
  const allowed = ['API_DISABLED','OAUTH_SCOPE','DATABASE_QUOTA','TIMEOUT','PERMISSION_DENIED','CRM_SNAPSHOT','GOOGLE_ACCESS','GOOGLE_AUTH_CONFIG','WORKBOOK_SCHEMA','REPORT_LIMIT','UNKNOWN'];
  const reason = allowed.includes(detail.reason) ? detail.reason : rawReason === 'UNAVAILABLE' ? null : rawReason;
  return { timestamp: entry.timestamp || null, component, event, reason,
    stage: ['CRM_SNAPSHOT','GOOGLE_AUTH','WORKBOOK_METADATA','WORKBOOK_READ','WORKBOOK_WRITE','LOCK'].includes(detail.stage) ? detail.stage : null,
    totalMs: Number.isFinite(detail.totalMs) ? detail.totalMs : null,
    statusCode: Number.isFinite(detail.statusCode) ? detail.statusCode : null,
    revision: String(entry.resource?.labels?.revision_name || '').replace(/[^a-zA-Z0-9-]/g,'').slice(0,100) };
}
function safeMongo(stats) {
  return { initialized: !!stats.initialized, pendingWrites: Number(stats.pendingWrites || 0),
    successes: Number(stats.successes || 0), failures: Number(stats.failures || 0),
    snapshotBytes: Number(stats.cacheSize || 0), lastWriteAt: stats.lastWriteAt || null,
    lastFailure: stats.lastError ? reasonFor({message:stats.lastError}) : null };
}
function createCloudDiagnostics({env=process.env, request, now=()=>Date.now()}={}) {
  let cached = null, cachedAt = 0, running = null;
  async function load() {
    if (cached && now()-cachedAt < 30000) return cached;
    if (running) return running;
    running = (async()=>{
      if (!request && !env.K_SERVICE) return {state:'NOT_CONFIGURED',service:{state:'NOT_CONFIGURED'},logs:{state:'NOT_CONFIGURED',entries:[]}};
      const call = request || (async options => {
        const auth = new google.auth.GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
        const client = await auth.getClient(); return client.request({...options,timeout:15000,retry:false});
      });
      const boundedCall = options => {
        let timer;
        return Promise.race([Promise.resolve().then(()=>call(options)),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Cloud diagnostic timeout')),20000);
        })]).finally(()=>clearTimeout(timer));
      };
      const settled = await Promise.allSettled([
        boundedCall({method:'GET',url:`https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`,params:{fields:'name,uri,latestReadyRevision,latestCreatedRevision,terminalCondition,template.serviceAccount,template.containers.resources'}}),
        boundedCall({method:'POST',url:'https://logging.googleapis.com/v2/entries:list',data:{resourceNames:[`projects/${PROJECT}`],filter:`resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}" AND timestamp >= "${new Date(now()-3600000).toISOString()}" AND (textPayload:"[mongoStore]" OR textPayload:"[crm-sheet-report]" OR textPayload:"[perf]")`,orderBy:'timestamp desc',pageSize:25}})
      ]);
      const service = settled[0].status==='fulfilled' ? (()=>{const s=settled[0].value.data || {};return {state:'CONNECTED',ready:s.terminalCondition?.state==='CONDITION_SUCCEEDED',revision:String(s.latestReadyRevision || '').split('/').pop(),serviceAccount:s.template?.serviceAccount || null,cpuIdle:s.template?.containers?.[0]?.resources?.cpuIdle ?? null};})() : {state:reasonFor(settled[0].reason),permission:'run.services.get'};
      const logs = settled[1].status==='fulfilled' ? {state:'CONNECTED',entries:(settled[1].value.data?.entries || []).map(summarizeEntry)} : {state:reasonFor(settled[1].reason),permission:'logging.logEntries.list',entries:[]};
      return {state:service.state==='CONNECTED' && logs.state==='CONNECTED' ? 'CONNECTED':'PARTIAL',service,logs,checkedAt:new Date(now()).toISOString()};
    })();
    try {cached=await running;cachedAt=now();return cached;} finally {running=null;}
  }
  return {load};
}
module.exports={createCloudDiagnostics,reasonFor,summarizeEntry,safeMongo,PROJECT,REGION,SERVICE};
