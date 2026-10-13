'use strict';
const { google } = require('googleapis');
function withDeadline(work, message, timeoutMs = 25000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
function secretName(env = process.env) {
  const id = env.SIG_REALTY_GOOGLE_REFRESH_SECRET || 'sig-realty-google-refresh-token';
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Drive secret configuration');
  return id;
}
async function secretRequest(action, token, env = process.env) {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const project = await auth.getProjectId();
  const client = await auth.getClient();
  const base = 'https://secretmanager.googleapis.com/v1/projects/' + encodeURIComponent(project) + '/secrets/' + secretName(env);
  try {
    const result = await client.request({
      url: action === 'read' ? base + '/versions/latest:access' : base + ':addVersion',
      method: action === 'read' ? 'GET' : 'POST', timeout: 30000,
      ...(action === 'read' ? {} : { data: { payload: { data: Buffer.from(token).toString('base64') } } })
    });
    if (action === 'read') {
      const value = Buffer.from(result.data?.payload?.data || '', 'base64').toString('utf8').trim();
      if (!value) throw new Error('Missing token');
      return value;
    }
    return result.data.name;
  } catch (_) {
    throw new Error(action === 'read' ? 'Drive token could not be read from Secret Manager' : 'Drive reconnect needs Secret Manager version-write permission on the configured token secret');
  }
}
async function refreshManagedDriveToken(env = process.env) {
  return withDeadline(() => refreshManagedDriveTokenWithinDeadline(env), 'Google Drive token refresh timed out. Check Cloud Run connectivity to Google APIs.');
}
async function refreshManagedDriveTokenWithinDeadline(env = process.env) {
  const token = await secretRequest('read', null, env);
  const auth = new google.auth.OAuth2(env.SIG_REALTY_GOOGLE_CLIENT_ID, env.SIG_REALTY_GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: token });
  try {
    const result = await auth.getAccessToken();
    if (!result.token) throw new Error('No access token');
    return { access_token: result.token, expiry_date: auth.credentials.expiry_date || Date.now() + 3500000 };
  } catch (_) { throw new Error('Google Drive authorization failed. Reconnect Google Drive in CRM Admin.'); }
}
async function saveDriveReconnect(payload, env = process.env) {
  if (!payload?.refresh_token) throw new Error('Google did not return a new Drive connection. Retry reconnect and approve offline access.');
  if (!String(payload.scope || '').split(/\s+/).includes(DRIVE_SCOPE)) throw new Error('Google Drive permission was not approved');
  const folder = String(env.BUILDER_PROJECTS_DRIVE_FOLDER_ID || '').trim();
  if (!folder) throw new Error('Builder Projects Drive folder is not configured');
  const auth = new google.auth.OAuth2(env.SIG_REALTY_GOOGLE_CLIENT_ID, env.SIG_REALTY_GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: payload.refresh_token });
  try {
    await google.drive({ version: 'v3', auth }).files.get({ fileId: folder, fields: 'id', supportsAllDrives: true }, { timeout: 30000 });
  } catch (_) { throw new Error('Selected Google account cannot access the configured Builder Projects folder'); }
  await secretRequest('write', payload.refresh_token, env);
  env.SIG_REALTY_GOOGLE_REFRESH_TOKEN = payload.refresh_token;
  return { connected: true };
}
async function testDriveConnection(env = process.env) {
  try { return await withDeadline(() => testDriveConnectionWithinDeadline(env), 'Google Drive connection test timed out. Check Cloud Run connectivity to Google APIs.', 35000); }
  catch (error) { return { status: 'timeout', message: error.message }; }
}
async function testDriveConnectionWithinDeadline(env = process.env) {
  const configured = ['SIG_REALTY_GOOGLE_CLIENT_ID','SIG_REALTY_GOOGLE_CLIENT_SECRET','SIG_REALTY_GOOGLE_REFRESH_TOKEN'].every(k => String(env[k] || '').trim());
  if (!configured) return { status: 'not_configured', message: 'Google Drive connection is not configured' };
  try {
    const { createDriveAuth } = require('./googleDriveClient');
    const auth = createDriveAuth(env);
    const folder = String(env.BUILDER_PROJECTS_DRIVE_FOLDER_ID || '').trim();
    if (!folder) return { status: 'not_configured', message: 'Builder Projects Drive folder is not configured' };
    await google.drive({ version: 'v3', auth }).files.get({ fileId: folder, fields: 'id', supportsAllDrives: true }, { timeout: 30000 });
    return { status: 'connected', message: 'Google Drive connected. Builder Projects folder is accessible.' };
  } catch (error) {
    const safeMessages = [
      'Drive token could not be read from Secret Manager',
      'Google Drive authorization failed. Reconnect Google Drive in CRM Admin.',
      'Google Drive token refresh timed out. Check Cloud Run connectivity to Google APIs.'
    ];
    return { status: 'reconnect_required', message: safeMessages.includes(error.message) ? error.message : 'Google Drive folder could not be accessed. Check the configured folder and account permission.' };
  }
}
module.exports = { DRIVE_SCOPE, secretName, refreshManagedDriveToken, saveDriveReconnect, testDriveConnection };
