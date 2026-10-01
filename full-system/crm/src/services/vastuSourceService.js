'use strict';

const crypto = require('node:crypto');
const MAX_SOURCE_BYTES = 18 * 1024 * 1024;

function detectType(buffer) {
  if (buffer.subarray(0,5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}

class VastuSourceService {
  constructor(repo, storage) { this.repo = repo; this.storage = storage || require('./objectStorageService'); }

  async upload(payload, actor) {
    const raw = String(payload.dataBase64 || '');
    if (!raw || raw.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 100) throw new Error('PDF or plan image exceeds 18 MB');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) throw new Error('Invalid source encoding');
    const buffer = Buffer.from(raw,'base64');
    if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) throw new Error('PDF or plan image exceeds 18 MB');
    const contentType = detectType(buffer);
    if (!contentType) throw new Error('Only PDF, PNG, JPEG or WebP is accepted');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = this.repo.list('VastuSources').find((row) => row.Sha256 === hash &&
      row.CompanyID === (actor.companyId || null) && row.BrokerageID === (actor.brokerageId || null) &&
      row.ProjectID === (payload.projectId || null) && row.PropertyID === (payload.propertyId || null));
    if (existing) return { SourceID:existing.SourceID,Sha256:hash,Filename:existing.Filename,ContentType:existing.ContentType,ByteSize:existing.ByteSize };
    const id = this.repo.createId('VSRC');
    const path = `vastu-sources/${id}`;
    const name = String(payload.filename || 'floor-plan').replace(/[\\/\x00-\x1f]/g,'').slice(0,150);
    await this.storage.putObject(path,buffer,contentType,name);
    const row = {
      SourceID:id,StoragePath:path,Sha256:hash,Filename:name,ContentType:contentType,ByteSize:buffer.length,
      ProjectID:payload.projectId || null,PropertyID:payload.propertyId || null,
      CompanyID:actor.companyId || null,BrokerageID:actor.brokerageId || null,
      UploadedBy:actor.userId,UploadedAt:new Date().toISOString()
    };
    this.repo.create('VastuSources',row);
    return { SourceID:id,Sha256:hash,Filename:name,ContentType:contentType,ByteSize:buffer.length };
  }

  get(id, actor) {
    const row = this.repo.find('VastuSources','SourceID',id);
    return row && row.CompanyID === (actor.companyId || null) && row.BrokerageID === (actor.brokerageId || null) ? row : null;
  }
}

module.exports = { VastuSourceService,detectType,MAX_SOURCE_BYTES };
