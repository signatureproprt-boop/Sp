'use strict';

const { setTimeout: wait } = require('node:timers/promises');
const API = 'https://generativelanguage.googleapis.com';

async function uploadBrochure(buffer, apiKey, signal) {
  const headers = { 'x-goog-api-key': apiKey };
  async function checked(response) {
    if (response.ok) return response;
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message || `Brochure file service failed (${response.status})`);
    error.status = response.status;
    error.code = 'AI_FILE_UPLOAD_FAILED';
    throw error;
  }
  const start = await checked(await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST', signal,
    headers: { ...headers, 'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': 'application/pdf' },
    body: JSON.stringify({ file: { display_name: 'CRM brochure' } })
  }));
  const uploadUrl = new URL(start.headers.get('x-goog-upload-url') || 'invalid:');
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'generativelanguage.googleapis.com' || uploadUrl.port) {
    throw new Error('Brochure file service returned an invalid upload destination');
  }
  const finalized = await checked(await fetch(uploadUrl.href, { method: 'POST', signal,
    headers: { ...headers, 'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buffer }));
  let file = (await finalized.json()).file;
  if (!/^files\/[a-zA-Z0-9_-]+$/.test(file?.name || '')) throw new Error('Invalid uploaded brochure reference');
  const name = file.name;
  try {
    while (file.state === 'PROCESSING') {
      await wait(1000, undefined, { signal });
      file = await (await checked(await fetch(`${API}/v1beta/${name}`, { headers, signal }))).json();
    }
    if (file.state !== 'ACTIVE' || file.mimeType !== 'application/pdf' ||
        file.uri !== `${API}/v1beta/${name}`) throw new Error('Uploaded brochure is not ready for reading');
    return { part: { file_data: { mime_type: 'application/pdf', file_uri: file.uri } },
      async dispose() {
        // Cleanup must not conceal the original extraction error or block its response.
        await fetch(`${API}/v1beta/${name}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
      } };
  } catch (error) {
    await fetch(`${API}/v1beta/${name}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
    throw error;
  }
}

module.exports = { uploadBrochure };
