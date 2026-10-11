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
    await (options.run || run)('gs', ['-q','-dSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dCompatibilityLevel=1.7',
      '-dPDFSETTINGS=/prepress','-dDownsampleColorImages=true','-dColorImageDownsampleThreshold=1.0','-dColorImageResolution=300',
      '-dDownsampleGrayImages=true','-dGrayImageDownsampleThreshold=1.0','-dGrayImageResolution=300',
      '-dDownsampleMonoImages=true','-dMonoImageResolution=600','-dCompressFonts=true','-dSubsetFonts=true',
      '-sOutputFile='+output,input], { timeout:120000, maxBuffer:1024*1024 });
    const prepared = await fs.readFile(output);
    if (!prepared.length || !prepared.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('Prepared PDF is unreadable');
    if (prepared.length > maxBytes) throw new Error('Review required: full PDF remains above the AI limit after 300 DPI optimization ('+Math.round(prepared.length/1024/1024)+' MB)');
    return { buffer:prepared, optimized:true, sourceBytes:buffer.length };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PDF preparation tool unavailable');
    if (error.killed) throw new Error('Large PDF preparation timed out; original brochure retained');
    throw error;
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
module.exports = { preparePdfForAi, PDF_LIMIT };
