'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const PDF_LIMIT = 50 * 1024 * 1024;
async function preparePdfForAi(buffer, options = {}) {
  const maxBytes = options.maxBytes || PDF_LIMIT;
  if (!Buffer.isBuffer(buffer) || !buffer.length || !buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('Uploaded brochure is not a PDF');
  if (buffer.length <= maxBytes) return { buffer, optimized: false, sourceBytes: buffer.length };
  if (buffer.length > 300 * 1024 * 1024) throw new Error('Stored PDF exceeds preparation limit (300 MB)');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brochure-ai-'));
  try {
    const input = path.join(dir,'source.pdf'), output = path.join(dir,'ai-copy.pdf');
    await fs.writeFile(input,buffer,{mode:0o600});
    let prepared;
    for (const resolution of [300,240]) {
      await (options.run || run)('gs', ['-q','-dSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dCompatibilityLevel=1.7',
        '-dPDFSETTINGS=/prepress','-dDownsampleColorImages=true','-dColorImageDownsampleThreshold=1.0','-dColorImageResolution='+resolution,
        '-dDownsampleGrayImages=true','-dGrayImageDownsampleThreshold=1.0','-dGrayImageResolution='+resolution,
        '-dDownsampleMonoImages=true','-dMonoImageResolution=600','-dCompressFonts=true','-dSubsetFonts=true',
        '-sOutputFile='+output,input], { timeout:120000, maxBuffer:1024*1024 });
      prepared = await fs.readFile(output);
      if (!prepared.length || !prepared.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('Prepared PDF is unreadable');
      if (prepared.length <= maxBytes) return { buffer:prepared, optimized:true, sourceBytes:buffer.length, resolution };
    }
    throw new Error('Review required: full PDF remains above the AI limit after optimization ('+Math.round(prepared.length/1024/1024)+' MB)');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PDF preparation tool unavailable');
    if (error.killed) throw new Error('Large PDF preparation timed out; original brochure retained');
    throw error;
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
// Normalize multi-page brochures into bounded visual pages. Never truncate pages.
async function renderPdfForAi(buffer, pageCount, options = {}) {
  if (pageCount < 2 || pageCount > 30) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brochure-vision-'));
  try {
    const input = path.join(dir, 'source.pdf');
    await fs.writeFile(input, buffer, { mode: 0o600 });
    await (options.run || run)('pdftoppm', ['-jpeg', '-scale-to', '2400', '-jpegopt', 'quality=90', input, path.join(dir, 'page')],
      { timeout: 40000, maxBuffer: 1024 * 1024, signal: options.signal });
    const files = (await fs.readdir(dir)).filter(name => /^page-\d+\.jpg$/.test(name))
      .sort((a,b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (files.length !== pageCount) throw new Error('PDF page rendering incomplete; original retained');
    let totalBytes = 0;
    const pages = [];
    for (let index = 0; index < files.length; index++) {
      if (Number(files[index].match(/\d+/)[0]) !== index + 1) throw new Error('PDF page sequence incomplete');
      const bytes = await fs.readFile(path.join(dir, files[index]));
      totalBytes += bytes.length;
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || totalBytes > PDF_LIMIT) throw new Error('Rendered PDF exceeds safe image limit');
      pages.push({ data: bytes.toString('base64'), text: '' });
    }
    return pages;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
module.exports = { preparePdfForAi, renderPdfForAi, PDF_LIMIT };
