Warning: truncated output (original token count: 64286)
Total output lines: 5915

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { version: appVersion } = require('../../package.json');
const mongoStore = require('./mongoStore');

let globalIdCounter = 0;
const ARRAY_COLLECTION_KEYS = [
  'Users',
  'Roles',
  'Leads',
  'Transactions',
  'Requirements',
  'RequirementHistory',
  'Activities',
  'Timeline',
  'FollowUps',
  'Inventory',
  'Media',
  'Matches',
  'Properties',
  'Shortlists',
  'ShortlistShares',
  'SiteVisits',
  'Negotiations',
  'NegotiationHistory',
  'Tokens',
  'Deals',
  'Payments',
  'Commission',
  'CommissionLedger',
  'Closings',
  'ClosingHistory',
  'Documents',
  'Owners',
  'Builders',
  'Projects',
  'Brokers',
  'BrokerShares',
  'BuilderBrochureShares',
  'BrokerSubmissions',
  'Permissions',
  'Audit',
  'Settings',
  'Masters',
  'PipelineConfig',
  'Notifications',
  'Backups',
  'ConfigurationHistory',
  'FormConfig',
  'FormRegistry',
  'Sessions',
  'AuthExchangeStates',
  'V2FieldConfig',
  'V2QuestionConfig',
  'V2FormRegistry',
  'V2DependencyConfig',
  'V2ScoringConfig',
  'PropertyInvestmentAnalyses',
  'VastuAnalyses',
  'VastuReportRecipients',
  'VastuSources'
];

class JsonRepository {
  constructor(dbFile = process.env.SIG_REALTY_DB_FILE || (() => {
    const args = process.argv || [];
    const isNodeTestRun = args.some((arg) => arg === '--test' || arg.includes('.test.js') || arg.includes('node:test'));
    if (isNodeTestRun) {
      const testDir = path.join(os.tmpdir(), 'sig-realty-test-db');
      fs.mkdirSync(testDir, { recursive: true });
      return path.join(testDir, `sig-realty-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    }
    return path.join(__dirname, '../../data/sig-realty-db.json');
  })()) {
    this.dbFile = dbFile;
    this._memoryDb = null;
    this.ensureDatabase();
  }

  createId(prefix) {
    const stamp = Date.now();
    const sequence = globalIdCounter++;
    return `${prefix}-${stamp}-${sequence}`;
  }

  ensureDatabase() {
    // Mongo mode with snapshot loaded — seed & return, no file work.
    if (mongoStore.isEnabled() && mongoStore.isInitialized()) {
      this.ensureStarterSeed();
      return;
    }
    // Mongo enabled but not yet initialized (pre-boot phase): keep an in-memory
    // shadow DB so startup seeding does not touch the JSON file before Mongo is ready.
    if (mongoStore.isEnabled()) {
      this._memoryDb = this._memoryDb || {};
      return;
    }
    const dir = path.dirname(this.dbFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.dbFile) || fs.statSync(this.dbFile).size === 0) {
      const initial = {
        Users: [],
        Roles: [],
        Leads: [],
        Transactions: [],
        Requirements: [],
        RequirementHistory: [],
        Activities: [],
        Timeline: [],
        FollowUps: [],
        Inventory: [],
        Media: [],
        Matches: [],
        Properties: [],
        Shortlists: [],
        SiteVisits: [],
        Negotiations: [],
        NegotiationHistory: [],
        Tokens: [],
        Deals: [],
        Payments: [],
        Commission: [],
        CommissionLedger: [],
        Closings: [],
        ClosingHistory: [],
        Documents: [],
        Owners: [],
        Builders: [],
        Projects: [],
        Brokers: [],
        BrokerShares: [],
        BrokerSubmissions: [],
        Permissions: [],
        Audit: [],
        Settings: [],
        Masters: [],
        PipelineConfig: [],
        Notifications: [],
        Backups: [],
        ConfigurationHistory: [],
        FormConfig: [],
        FormRegistry: [],
        Sessions: [],
        AuthExchangeStates: [],
        V2FieldConfig: [],
        V2QuestionConfig: [],
        V2FormRegistry: [],
        V2DependencyConfig: [],
        V2ScoringConfig: [],
        RequirementHistory: [],
        _V2Counters: { Lead: 0, Transaction: 0, Requirement: 0 }
      };

      fs.writeFileSync(this.dbFile, JSON.stringify(initial, null, 2));
    }

    this.ensureStarterSeed();
  }

  ensureStarterSeed() {
    const db = this.read();
    if (!Array.isArray(db.Users)) db.Users = [];

    let changed = false;
    let systemAdmin = db.Users.find((user) => user.UserID === 'USR-SYSTEM-ADMIN');
    if (!systemAdmin) {
      systemAdmin = {
        UserID: 'USR-SYSTEM-ADMIN',
        Name: 'System Administrator',
        Role: 'ADMIN',
        Status: 'Active',
        Permissions: ['*'],
        CompanyID: 'COMP-DEFAULT',
        BrokerageID: 'BRK-DEFAULT',
        CreatedAt: new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      };
      db.Users.push(systemAdmin);
      changed = true;
    }

    // One-time production bootstrap for the initial Google admin identity.
    // This only links an explicitly configured Google email to the existing
    // system admin; it never creates a second admin user.
    const bootstrapGoogleEmail = String(
      process.env.SIG_REALTY_BOOTSTRAP_ADMIN_GOOGLE_EMAIL || ''
    ).trim().toLowerCase();
    if (bootstrapGoogleEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapGoogleEmail)) {
      if (String(systemAdmin.GoogleEmail || '').trim().toLowerCase() !== bootstrapGoogleEmail) {
        systemAdmin.GoogleEmail = bootstrapGoogleEmail;
        systemAdmin.Status = 'Active';
        systemAdmin.Role = 'ADMIN';
        systemAdmin.Permissions = Array.isArray(systemAdmin.Permissions) && systemAdmin.Permissions.length
          ? systemAdmin.Permissions
          : ['*'];
        systemAdmin.UpdatedAt = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) this.write(db);
  }

  read() {
    if (mongoStore.isEnabled()) {
      if (mongoStore.isInitialized()) {
        return this.normalizeDbShape(mongoStore.read());
      }
      if (this._memoryDb) {
        return this.normalizeDbShape(JSON.parse(JSON.stringify(this._memoryDb)));
      }
      return this.normalizeDbShape({});
    }

    try {
      return this.normalizeDbShape(JSON.parse(fs.readFileSync(this.dbFile, 'utf8')));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
      this.ensureDatabase();
      return this.normalizeDbShape(JSON.parse(fs.readFileSync(this.dbFile, 'utf8')));
    }
  }

  normalizeDbShape(rawDb) {
    const db = rawDb && typeof rawDb === 'object' && !Array.isArray(rawDb) ? rawDb : {};
    for (const key of ARRAY_COLLECTION_KEYS) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    // Lossless compatibility migration: legacy Requirement data is absorbed
    // into Transactions and downstream records receive TransactionID.
    const requirements = db.Requirements || [];
    const transactions = db.Transactions || [];
    const txnById = new Map(transactions.map((row) => [row.TransactionID, row]));
    const reqToTxn = new Map();
    for (const req of requirements) {
      if (!req?.RequirementID || req.ClientOwned === true) continue;
      const transactionId = req.TransactionID || ('TXN-MIG-' + String(req.RequirementID).replace(/^REQ-?/i, ''));
      // Stable migration ID makes normalizeDbShape idempotent: repeated reads
      // must never create another transaction for the same legacy requirement.
      let txn = txnById.get(transactionId);
      if (!txn) {
        txn = {
          TransactionID: transactionId, LeadID: req.LeadID,
          TransactionType: req.TransactionType || req.Type || 'Purchase',
          Type: req.TransactionType || req.Type || 'Purchase',
          TransactionStatus: req.RequirementStatus || req.Status || 'Open',
          Status: req.RequirementStatus || req.Status || 'Open',
          PipelineStage: req.PipelineStage || 'New',
          CreatedAt: req.CreatedAt || new Date().toISOString(),
          UpdatedAt: req.UpdatedAt || req.CreatedAt || new Date().toISOString(),
          Version: Number(req.Version || req.VersionNumber || 1), _v2: true
        };
        transactions.push(txn); txnById.set(transactionId, txn);
      }
      reqToTxn.set(req.RequirementID, txn.TransactionID);
      const fields = { ...(txn.Fields || {}) };
      const reserved = new Set(['RequirementID','RequirementCode','LeadID','TransactionID','CreatedAt','CreatedBy','UpdatedAt','UpdatedBy','Version','VersionNumber']);
      for (const [key, value] of Object.entries(req)) {
        if (reserved.has(key) || value === undefined) continue;
        if (txn[key] === undefined || txn[key] === null || txn[key] === '') txn[key] = value;
        if (!['TransactionType','Type','RequirementStatus','Status','PipelineStage','Category','SubCategory'].includes(key)) {
          fields[key] = fields[key] || { state: value === null || value === '' ? 'UNKNOWN' : 'KNOWN', value: value === '' ? null : value };
        }
      }
      txn.Fields = fields;
      txn.LegacyRequirementID = txn.LegacyRequirementID || req.RequirementID;
      txn.LegacyRequirementIDs = [...new Set([
        ...(Array.isArray(txn.LegacyRequirementIDs) ? txn.LegacyRequirementIDs : []),
        ...(txn.LegacyRequirementID ? [txn.LegacyRequirementID] : []),
        req.RequirementID
      ].filter(Boolean))];
    }
    db.Transactions = transactions;
    for (const collection of ['Activities','FollowUps','Matches','Shortlists','SiteVisits','Negotiations','Tokens','Deals','Documents','BrokerShares','BrokerSubmissions','TransactionShares']) {
      for (const row of db[collection] || []) {
        if (!row || row.TransactionID || !row.RequirementID) continue;
        const transactionId = reqToTxn.get(row.RequirementID);
        if (transactionId) row.TransactionID = transactionId;
      }
    }

    if (!db._V2Counters || typeof db._V2Counters !== 'object' || Array.isArray(db._V2Counters)) {
      db._V2Counters = { Lead: 0, Transaction: 0, Requirement: 0 };
    } else {
      db._V2Counters.Lead = Number.isFinite(Number(db._V2Counters.Lead)) ? Number(db._V2Counters.Lead) : 0;
      db._V2Counters.Transaction = Number.isFinite(Number(db._V2Counters.Transaction)) ? Number(db._V2Counters.Transaction) : 0;
      db._V2Counters.Requirement = Number.isFinite(Number(db._V2Counters.Requirement)) ? Number(db._V2Counters.Requirement) : 0;
    }
    return db;
  }

  write(db) {
    if (mongoStore.isEnabled()) {
      if (mongoStore.isInitialized()) {
        const persistence = mongoStore.write(db);
        // The repository API is intentionally synchronous. Attach a rejection
        // handler here so a background Mongo durability failure cannot become
        // an unhandled rejection and terminate the CRM process.
        persistence.catch((error) => {
          console.error('[repository] Mongo background persistence failed:', error.message);
        });
        return;
      }
      this._memoryDb = JSON.parse(JSON.stringify(db));
      return;
    }
    const dir = path.dirname(this.dbFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Node.js is single-threaded and all callers perform a fully synchronous
    // read → modify → write cycle with no intermediate awaits, so these
    // synchronous fs operations cannot be interleaved by another request
    // within the same process. The atomic tmp-file rename guarantees that a
    // partially-written file is never visible to a concurrent reader.
    const tempFile = `${this.dbFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
    fs.renameSync(tempFile, this.dbFile);
  }

  async flush() {
    if (mongoStore.isEnabled() && mongoStore.isInitialized()) {
      return mongoStore.flush();
    }
    return { lastError: null };
  }

  nextId(prefix, collection) {
    const rows = this.read()[collection] || [];
    const max = rows.reduce((acc, item) => {
      const id = Number(String(item[`${collection.includes('Lead') ? 'Lead' : collection}`] || '0'));
      return acc;
    }, 0);

    const next = rows.length + 1;
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  list(collection) {
    if (mongoStore.isEnabled() && mongoStore.isInitialized() && typeof mongoStore.readCollection === 'function') {
      return mongoStore.readCollection(collection);
    }
    const rows = this.read()[collection];
    return Array.isArray(rows) ? rows : [];
  }

  create(collection, row) {
    const db = this.read();
    db[collection] = db[collection] || [];
    db[collection].push(row);
    this.write(db);
    return row;
  }

  update(collection, idField, id, changes) {
    const db = this.read();
    const rows = db[collection] || (db[collection] = []);
    const index = rows.findIndex((row) => row[idField] === id);
    if (index === -1) return null;

    const updated = { ...rows[index], ...changes };
    rows[index] = updated;
    db[collection] = rows;
    this.write(db);
    return updated;
  }

  find(collection, idField, id) {
    const rows = this.list(collection);
    return rows.find((row) => row[idField] === id) || null;
  }

  updateBy(collection, predicate, updater) {
    const db = this.read();
    const rows = Array.isArray(db[collection]) ? db[collection] : [];
    const updatedRows = rows.map((row) => {
      if (predicate(row)) {
        return updater(row);
      }
      return row;
    });

    db[collection] = updatedRows;
    this.write(db);
  }

  delete(collection, idField, id) {
    const db = this.read();
    const rows = db[collection] || (db[collection] = []);
    const filtered = rows.filter((row) => row[idField] !== id);
    db[collection] = filtered;
    this.write(db);
    return true;
  }

  normalizeSessionRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const sessionId = String(record.sessionId || record.SessionID || '').trim();
    if (!sessionId) return null;
    return {
      sessionId,
      userId: String(record.userId || record.UserID || '').trim(),
      role: String(record.role || record.Role || '').trim().toUpperCase(),
      companyId: String(record.companyId || record.CompanyID || '').trim(),
      brokerageId: String(record.brokerageId || record.BrokerageID || '').trim(),
      permissions: Array.isArray(record.permissions)
        ? record.permissions
        : Array.isArray(record.Permissions)
          ? record.Permissions
          : [],
      principalType: String(record.principalType || record.PrincipalType || '').trim(),
      issuedAt: String(record.issuedAt || record.IssuedAt || '').trim(),
      expiresAt: String(record.expiresAt || record.ExpiresAt || '').trim()
    };
  }

  serializeSessionRecord(session) {
    const normalized = this.normalizeSessionRecord(session);
    if (!normalized) return null;
    return {
      SessionID: normalized.sessionId,
      UserID: normalized.userId,
      Role: normalized.role,
      CompanyID: normalized.companyId,
      BrokerageID: normalized.brokerageId,
      Permissions: normalized.permissions,
      PrincipalType: normalized.principalType,
      IssuedAt: normalized.issuedAt,
      ExpiresAt: normalized.expiresAt
    };
  }

  listSessions(options = {}) {
    const includeExpired = options?.includeExpired === true;
    const now = Date.now();
    const db = this.read();
    const rows = Array.isArray(db.Sessions) ? db.Sessions : [];
    const retainedRows = [];
    const sessions = [];
    let removed = 0;
    for (const row of rows) {
      const normalized = this.normalizeSessionRecord(row);
      if (!normalized) {
        removed += 1;
        continue;
      }
      const expiresAt = normalized.expiresAt ? new Date(normalized.expiresAt).getTime() : null;
      const expired = Number.isFinite(expiresAt) && expiresAt <= now;
      if (!expired) {
        retainedRows.push(row);
      } else if (!includeExpired) {
        removed += 1;
      }
      if (includeExpired || !expired) {
        sessions.push(normalized);
      }
    }
    if (!includeExpired && removed > 0) {
      db.Sessions = retainedRows;
      this.write(db);
    }
    return sessions;
  }

  getSession(sessionId) {
    const sessionKey = String(sessionId || '').trim();
    if (!sessionKey) return null;
    const session = this.normalizeSessionRecord(this.find('Sessions', 'SessionID', sessionKey));
    if (!session) return null;
    const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : null;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.deleteSession(sessionKey);
      return null;
    }
    return session;
  }

  upsertSession(session) {
    const row = this.serializeSessionRecord(session);
    if (!row) {
      throw new Error('Valid session data is required');
    }
    const db = this.read();
    const rows = Array.isArray(db.Sessions) ? db.Sessions : [];
    const index = rows.findIndex((entry) => String(entry?.SessionID || '').trim() === row.SessionID);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    db.Sessions = rows;
    this.write(db);
    return this.normalizeSessionRecord(row);
  }

  normalizeAuthExchangeStateRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const stateId = String(record.stateId || record.state || record.StateID || '').trim();
    if (!stateId) return null;
    return {
      stateId,
      redirectUri: String(record.redirectUri || record.RedirectURI || '').trim(),
      nextPath: String(record.nextPath || record.NextPath || '').trim() || '/',
      browserFlowHash: String(record.browserFlowHash || record.BrowserFlowHash || '').trim(),
      authMode: String(record.authMode || record.AuthMode || '').trim(),
      issuedAt: String(record.issuedAt || record.IssuedAt || '').trim(),
      expiresAt: String(record.expiresAt || record.ExpiresAt || '').trim(),
      consumedAt: String(record.consumedAt || record.ConsumedAt || '').trim()
    };
  }

  serializeAuthExchangeStateRecord(record) {
    const normalized = this.normalizeAuthExchangeStateRecord(record);
    if (!normalized) return null;
    return {
      StateID: normalized.stateId,
      RedirectURI: normalized.redirectUri,
      NextPath: normalized.nextPath,
      BrowserFlowHash: normalized.browserFlowHash,
      AuthMode: normalized.authMode,
      IssuedAt: normalized.issuedAt,
      ExpiresAt: normalized.expiresAt,
      ConsumedAt: normalized.consumedAt || null
    };
  }

  getAuthExchangeState(stateId, options = {}) {
    const stateKey = String(stateId || '').trim();
    if (!stateKey) return null;
    const includeExpired = options.includeExpired === true;
    const record = this.normalizeAuthExchangeStateRecord(this.find('AuthExchangeStates', 'StateID', stateKey));
    if (!record) return null;
    const expiresAt = record.expiresAt ? new Date(record.expiresAt).getTime() : null;
    if (!includeExpired && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.deleteAuthExchangeState(stateKey);
      return null;
    }
    return record;
  }

  upsertAuthExchangeState(record) {
    const row = this.serializeAuthExchangeStateRecord(record);
    if (!row) {
      throw new Error('Valid auth exchange state data is required');
    }
    const db = this.read();
    const rows = Array.isArray(db.AuthExchangeStates) ? db.AuthExchangeStates : [];
    const index = rows.findIndex((entry) => String(entry?.StateID || '').trim() === row.StateID);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    db.AuthExchangeStates = rows;
    this.write(db);
    return this.normalizeAuthExchangeStateRecord(row);
  }

  deleteAuthExchangeState(stateId) {
    const stateKey = String(stateId || '').trim();
    if (!stateKey) return false;
    const db = this.read();
    const rows = Array.isArray(db.AuthExchangeStates) ? db.AuthExchangeStates : [];
    const filtered = rows.filter((row) => String(row?.StateID || '').trim() !== stateKey);
    const changed = filtered.length !== rows.length;
    if (changed) {
      db.AuthExchangeStates = filtered;
      this.write(db);
    }
    return changed;
  }

  markAuthExchangeStateConsumed(stateId, consumedAt = new Date().toISOString()) {
    const stateKey = String(stateId || '').trim();
    if (!stateKey) return null;
    const existing = this.getAuthExchangeState(stateKey, { includeExpired: true });
    if (!existing) return null;
    return this.upsertAuthExchangeState({
      ...existing,
      consumedAt: String(consumedAt || '').trim() || new Date().toISOString()
    });
  }

  consumeAuthExchangeState(stateId, consumedAt = new Date().toISOString()) {
    const stateKey = String(stateId || '').trim();
    if (!stateKey) return { ok: false, reason: 'missing' };
    const db = this.read();
    const rows = Array.isArray(db.AuthExchangeStates) ? db.AuthExchangeStates : [];
    const index = rows.findIndex((row) => String(row?.StateID || '').trim() === stateKey);
    if (index === -1) return { ok: false, reason: 'missing' };
    const existing = this.normalizeAuthExchangeStateRecord(rows[index]);
    if (!existing) return { ok: false, reason: 'missing' };
    const expiresAt = existing.expiresAt ? new Date(existing.expiresAt).getTime() : null;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      db.AuthExchangeStates = rows.filter((row) => String(row?.StateID || '').trim() !== stateKey);
      this.write(db);
      return { ok: false, reason: 'expired' };
    }
    if (existing.consumedAt) {
      return { ok: false, reason: 'replayed', record: existing };
    }
    const updated = {
      ...rows[index],
      ConsumedAt: String(consumedAt || '').trim() || new Date().toISOString()
    };
    rows[index] = updated;
    db.AuthExchangeStates = rows;
    this.write(db);
    return { ok: true, record: this.normalizeAuthExchangeStateRecord(updated) };
  }

  deleteExpiredAuthExchangeStates(now = Date.now()) {
    const cutoff = Number(now);
    const db = this.read();
    const rows = Array.isArray(db.AuthExchangeStates) ? db.AuthExchangeStates : [];
    const filtered = rows.filter((row) => {
      const expiresAt = row?.ExpiresAt ? new Date(row.ExpiresAt).getTime() : null;
      return !(Number.isFinite(expiresAt) && expiresAt <= cutoff);
    });
    const removed = rows.length - filtered.length;
    if (removed > 0) {
      db.AuthExchangeStates = filtered;
      this.write(db);
    }
    return removed;
  }

  deleteSession(sessionId) {
    const sessionKey = String(sessionId || '').trim();
    if (!sessionKey) return false;
    const db = this.read();
    const rows = Array.isArray(db.Sessions) ? db.Sessions : [];
    const filtered = rows.filter((row) => String(row?.SessionID || '').trim() !== sessionKey);
    const changed = filtered.length !== rows.length;
    if (changed) {
      db.Sessions = filtered;
      this.write(db);
    }
    return changed;
  }

  deleteExpiredSessions(now = Date.now()) {
    const cutoff = Number(now);
    const db = this.read();
    const rows = Array.isArray(db.Sessions) ? db.Sessions : [];
    const filtered = rows.filter((row) => {
      const expiresAt = row?.ExpiresAt ? new Date(row.ExpiresAt).getTime() : null;
      return !(Number.isFinite(expiresAt) && expiresAt <= cutoff);
    });
    const removed = rows.length - filtered.length;
    if (removed > 0) {
      db.Sessions = filtered;
      this.write(db);
    }
    return removed;
  }

  createLead(payload) {
    const db = this.read();
    db.Leads = db.Leads || [];
    const leadSource = payload.leadSource || payload.LeadSource || payload.source || payload.Source || 'Manual';
    const lead = {
      LeadID: payload.LeadID || this.createId('LEAD'),
      ClientName: payload.clientName || payload.ClientName,
      City: payload.city || payload.City,
      Phone: payload.phone || payload.Phone,
      Email: payload.email || payload.Email,
      LeadStatus: payload.leadStatus || payload.LeadStatus || 'New',
      LeadSource: leadSource,
      Source: leadSource,
      AssignedAgentID: payload.assignedAgentId || payload.AssignedAgentID || 'USR-0001',
      CompanyID: payload.CompanyID || payload.CompanyId || null,
      BrokerageID: payload.BrokerageID || payload.BrokerageId || null,
      CreatedBy: payload.CreatedBy || payload.createdBy || null,
      CreatedAt: payload.createdAt || new Date().toISOString(),
      UpdatedAt: payload.updatedAt || new Date().toISOString(),
      last_activity_at: payload.last_activity_at || new Date().toISOString(),
      ArchiveFlag: false
    };

    db.Leads.push(lead);
    this.write(db);
    this.addTimelineEntry(lead.LeadID, 'Lead', lead.LeadID, 'LEAD_CREATED', 'Lead created', lead);
    return lead;
  }

  listLeads() {
    return this.list('Leads');
  }

  readLead(leadId) {
    return this.find('Leads', 'LeadID', leadId);
  }

  updateLead(leadId, payload) {
    const db = this.read();
    db.Leads = db.Leads || [];
    const leadIndex = db.Leads.findIndex((lead) => lead.LeadID === leadId);
    if (leadIndex === -1) return null;

    const existing = db.Leads[leadIndex];
    const updates = { ...payload };
    const leadSource = updates.leadSource || updates.LeadSource || updates.source || updates.Source || existing.LeadSource || existing.Source || 'Manual';

    const normalized = {
      ClientName: updates.clientName || updates.ClientName || existing.ClientName,
      City: updates.city || updates.City || existing.City,
      Phone: updates.phone || updates.Phone || existing.Phone,
      Email: updates.email || updates.Email || existing.Email,
      LeadStatus: updates.leadStatus || updates.LeadStatus || existing.LeadStatus,
      LeadSource: leadSource,
      Source: leadSource,
      AssignedAgentID: updates.assignedAgentId || updates.AssignedAgentID || existing.AssignedAgentID,
      UpdatedAt: new Date().toISOString(),
      ArchiveFlag: updates.archiveFlag !== undefined ? updates.archiveFlag : existing.ArchiveFlag
    };

    db.Leads[leadIndex] = { ...existing, ...normalized };
    this.write(db);

    return db.Leads[leadIndex];
  }

  createRequirement(payload) {
    const db = this.read();
    db.Requirements = db.Requirements || [];
    const requirement = {
      RequirementID: payload.RequirementID || this.createId('REQ'),
      RequirementCode: payload.RequirementCode || this.createId('REQ'),
      LeadID: payload.LeadID || payload.leadId,
      TransactionID: payload.TransactionID || payload.transactionId || 'TXN-0001',
      TransactionType: payload.TransactionType || payload.transactionType || 'Purchase',
      Category: payload.Category || payload.category,
      SubCategory: payload.SubCategory || payload.subCategory,
      PropertyType: payload.PropertyType || payload.propertyType,
      BudgetMin: payload.BudgetMin || payload.budgetMin,
      BudgetMax: payload.BudgetMax || payload.budgetMax,
      Location1: payload.Location1 || payload.location1,
      Location2: payload.Location2 || payload.location2,
      Location3: payload.Location3 || payload.location3 || null,
      BHKMin: payload.BHKMin || payload.bhkMin || null,
      BHKMax: payload.BHKMax || payload.bhkMax || null,
      AreaMin: payload.AreaMin || payload.areaMin || null,
      AreaMax: payload.AreaMax || payload.areaMax || null,
      Possession: payload.Possession || payload.possession,
      Urgency: payload.Urgency || payload.urgency,
      SpecialNotes: payload.SpecialNotes || payload.specialNotes,
      Status: payload.Status || payload.status || 'Active',
      CompanyID: payload.CompanyID || payload.CompanyId || null,
      BrokerageID: payload.BrokerageID || payload.BrokerageId || null,
      CreatedBy: payload.CreatedBy || payload.createdBy || null,
      CreatedAt: payload.CreatedAt || payload.createdAt || new Date().toISOString(),
      UpdatedAt: payload.UpdatedAt || payload.updatedAt || new Date().toISOString(),
      VersionNumber: 1
    };

    db.Requirements.push(requirement);
    this.write(db);
    this.addTimelineEntry(requirement.LeadID, 'Requirement', requirement.RequirementID, 'REQUIREMENT_CREATED', 'Requirement created', requirement);

    return requirement;
  }

  listRequirementsByLead(leadId) {
    const db = this.read();
    return db.Requirements.filter((row) => row.LeadID === leadId);
  }

  readRequirement(requirementId) {
    const db = this.read();
    return db.Requirements.find((row) => row.RequirementID === requirementId) || null;
  }

  updateRequirement(requirementId, changes) {
    const db = this.read();
    db.Requirements = db.Requirements || [];
    db.RequirementHistory = db.RequirementHistory || [];
    db.Activities = db.Activities || [];
    db.Timeline = db.Timeline || [];
    const previous = db.Requirements.find((row) => row.RequirementID === requirementId);
    if (!previous) return null;

    const requirements = db.Requirements;
    const index = requirements.findIndex((row) => row.RequirementID === requirementId);
    const previousSnapshot = { ...previous };

    const updated = {
      ...previous,
      ...changes,
      UpdatedAt: new Date().toISOString()
    };
    if (changes.RequirementStatus !== undefined && changes.Status === undefined) {
      updated.Status = changes.RequirementStatus;
    }
    if (changes.Status !== undefined && changes.RequirementStatus === undefined) {
      updated.RequirementStatus = changes.Status;
    }
    const previousStatus = String(previous.RequirementStatus || previous.Status || '').trim();
    const nextStatus = String(updated.RequirementStatus || updated.Status || '').trim();

    requirements[index] = updated;

    const history = {
      RequirementHistoryID: this.createId('REQH'),
      RequirementID: requirementId,
      VersionNumber: Number(previous.VersionNumber || 1) + 1,
      ChangedBy: 'system',
      ChangedAt: new Date().toISOString(),
      ChangeSummary: 'Requirement updated',
      PreviousData: previousSnapshot,
      NewData: updated
    };

    db.RequirementHistory.push(history);

    if (nextStatus && previousStatus !== nextStatus) {
      this.appendRequirementStatusTransitionArtifacts(db, {
        requirement: updated,
        previousStatus,
        nextStatus,
        changedFields: [],
        occurredAt: updated.UpdatedAt,
        actorUserId: 'system'
      });
    }
    this.write(db);

    return { requirement: updated, history };
  }

  appendRequirementStatusTransitionArtifacts(db, {
    requirement,
    previousStatus,
    nextStatus,
    changedFields = [],
    occurredAt = new Date().toISOString(),
    actorUserId = 'system'
  }) {
    if (!requirement || !nextStatus || previousStatus === nextStatus) return;

    db.Activities = db.Activities || [];
    db.Timeline = db.Timeline || [];

    const requirementId = requirement.RequirementID || null;
    const fromStatus = previousStatus || null;
    const toStatus = nextStatus || null;
    const transitionKey = `${requirementId || ''}|${fromStatus || ''}|${toStatus || ''}|${occurredAt}`;

    let activityNote = `Requirement status changed: ${previousStatus || 'Unknown'} → ${nextStatus}`;
    let eventType = 'REQUIREMENT_STATUS_CHANGED';
    let eventTitle = `Requirement status changed to ${nextStatus}`;
    if (nextStatus === 'Lost') {
      activityNote = `Requirement marked Lost${requirement.LostReason ? `: ${requirement.LostReason}` : ''}${requirement.LostNotes ? ` — ${requirement.LostNotes}` : ''}`;
      eventType = 'REQUIREMENT_LOST';
      eventTitle = 'Requirement marked Lost';
    } else if (previousStatus === 'Lost') {
      activityNote = `Requirement reactivated to ${nextStatus}`;
      eventType = 'REQUIREMENT_REACTIVATED';
      eventTitle = 'Requirement reactivated';
    }

    const hasActivity = db.Activities.some((row) =>
      row &&
      row.RequirementID === requirementId &&
      row.ActivityType === 'Requirement' &&
      row._transitionKey === transitionKey
    );
    if (!hasActivity) {
      db.Activities.push({
        ActivityID: this.createId('ACT'),
        LeadID: requirement.LeadID || null,
        TransactionID: requirement.TransactionID || null,
        RequirementID: requirementId,
        ActivityType: 'Requirement',
        Notes: activityNote,
        CreatedAt: occurredAt,
        _transitionKey: transitionKey
      });
    }

    const hasTimeline = db.Timeline.some((row) =>
      row &&
      row.EntityType === 'Requirement' &&
      row.EntityID === requirementId &&
      row.EventType === eventType &&
      row?.Payload?._transitionKey === transitionKey
    );
    if (!hasTimeline) {
      db.Timeline.push({
        TimelineID: this.createId('TIM'),
        LeadID: requirement.LeadID || null,
        EntityType: 'Requirement',
        EntityID: requirementId,
        EventType: eventType,
        EventTitle: eventTitle,
        EventDate: occurredAt,
        Payload: {
          RequirementID: requirementId,
          fromStatus,
          toStatus,
          LostReason: requirement.LostReason || null,
          LostNotes: requirement.LostNotes || requirement.LostNote || null,
          changedFields,
          changedBy: actorUserId || 'system',
          _transitionKey: transitionKey
        }
      });
    }
  }

  appendLeadStatusTransitionArtifacts(db, {
    lead,
    previousStatus,
    nextStatus,
    occurredAt = new Date().toISOString(),
    actorUserId = 'system'
  }) {
    if (!lead || !nextStatus || previousStatus === nextStatus) return;

    db.Activities = db.Activities || [];
    db.Timeline = db.Timeline || [];

    const leadId = lead.LeadID || null;
    const transitionKey = `${leadId || ''}|${previousStatus || ''}|${nextStatus || ''}`;
    let eventType = 'LEAD_STATUS_CHANGED';
    let eventTitle = `Lead status changed to ${nextStatus}`;
    let activityNote = `Lead status changed: ${previousStatus || 'Unknown'} → ${nextStatus}`;

    if (nextStatus === 'Lost') {
      eventType = 'LEAD_LOST';
      eventTitle = 'Lead marked Lost';
      activityNote = `Lead marked Lost${lead.LostReason ? `: ${lead.LostReason}` : ''}${lead.LostNote ? ` — ${lead.LostNote}` : ''}`;
    } else if (previousStatus === 'Lost') {
      eventType = 'LEAD_REACTIVATED';
      eventTitle = 'Lead reactivated';
      activityNote = `Lead reactivated: Lost → ${nextStatus}`;
    } else if (nextStatus === 'Won') {
      eventType = 'LEAD_WON';
      eventTitle = 'Lead marked Won';
      activityNote = 'Lead marked Won';
    }

    const hasActivity = db.Activities.some((row) =>
      row &&
      row.LeadID === leadId &&
      row.ActivityType === 'Lead' &&
      row._transitionKey === transitionKey
    );
    if (!hasActivity) {
      db.Activities.push({
        ActivityID: this.createId('ACT'),
        LeadID: leadId,
        ActivityType: 'Lead',
        Notes: activityNote,
        CreatedAt: occurredAt,
        CreatedBy: actorUserId || 'system',
        _transitionKey: transitionKey
      });
    }

    const hasTimeline = db.Timeline.some((row) =>
      row &&
      row.EntityType === 'Lead' &&
      row.EntityID === leadId &&
      row.EventType === eventType &&
      row?.Payload?._transitionKey === transitionKey
    );
    if (!hasTimeline) {
      db.Timeline.push({
        TimelineID: this.createId('TIM'),
        LeadID: leadId,
        EntityType: 'Lead',
        EntityID: leadId,
        EventType: eventType,
        EventTitle: eventTitle,
        EventDate: occurredAt,
        Payload: {
          fromStatus: previousStatus || null,
          toStatus: nextStatus || null,
          LostReason: lead.LostReason || null,
          LostNote: lead.LostNote || null,
          changedBy: actorUserId || 'system',
          _transitionKey: transitionKey
        }
      });
    }
  }

  archiveRequirement(requirementId) {
    const db = this.read();
    db.Requirements = db.Requirements || [];
    const requirement = db.Requirements.find((row) => row.TransactionID === transactionId);
    if (!requirement) return null;

    requirement.Status = 'Cancelled';
    requirement.UpdatedAt = new Date().toISOString();
    this.write(db);
    return requirement;
  }

  duplicateRequirement(requirementId) {
    const db = this.read();
    db.Requirements = db.Requirements || [];
    const req = db.Requirements.find((row) => row.TransactionID === transactionId);
    if (!req) return null;

    const dup = {
      ...req,
      RequirementID: this.createId('REQ'),
      RequirementCode: `${req.RequirementCode}-COPY`,
      Status: 'Active',
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
      VersionNumber: 1
    };

    db.Requirements.push(dup);
    this.write(db);
    return dup;
  }

  createActivity(leadId, payload) {
    const db = this.read();
    db.Activities = db.Activities || [];
    db.Timeline = db.Timeline || [];
    const activity = {
      ActivityID: this.createId('ACT'),
      LeadID: leadId,
      TransactionID: payload.TransactionID || null,
      ActivityType: payload.activityType || payload.ActivityType || 'Note',
      Notes: payload.notes || payload.Notes || '',
      CreatedAt: new Date().toISOString()
    };

    db.Activities.push(activity);

    const lead = db.Leads.find((row) => row.LeadID === leadId);
    if (lead) {
      lead.last_activity_at = activity.CreatedAt;
      lead.UpdatedAt = activity.CreatedAt;
    }

    db.Timeline.push({
      TimelineID: this.createId('TIM'),
      LeadID: leadId,
      EntityType: 'Activity',
      EntityID: activity.ActivityID,
      EventType: activity.ActivityType,
      EventTitle: activity.ActivityType,
      EventDate: activity.CreatedAt,
      Payload: activity
    });

    this.write(db);
    return activity;
  }

  getLeadActivities(leadId) {
    const db = this.read();
    return db.Activities.filter((row) => row.LeadID === leadId);
  }

  requirementHistory(requirementId) {
    const db = this.read();
    return db.RequirementHistory.filter((row) => row.TransactionID === transactionId);
  }

  listMatches(transactionId = null) {
    const db = this.read();
    db.Matches = db.Matches || [];
    if (transactionId) {
      return db.Matches.filter((m) => m.TransactionID === transactionId).sort((a, b) => b.Score - a.Score);
    }
    return db.Matches.sort((a, b) => b.Score - a.Score);
  }

  getMatch(matchId) {
    const db = this.read();
    db.Matches = db.Matches || [];
    return db.Matches.find((m) => m.MatchID === matchId) || null;
  }

  createMatch(payload) {
    const db = this.read();
    db.Matches = db.Matches || [];
    const match = {
      MatchID: payload.MatchID || this.createId('MATCH'),
      TransactionID: payload.TransactionID || payload.transactionId,
      PropertyID: payload.PropertyID || payload.propertyId,
      LeadID: payload.LeadID || payload.leadId,
      Score: payload.Score || payload.score || 0,
      MatchLevel: payload.MatchLevel || payload.matchLevel || 'Weak',
      MatchedCriteria: payload.MatchedCriteria || payload.matchedCriteria || [],
      FailedCriteria: payload.FailedCriteria || payload.failedCriteria || [],
      UnknownCriteria: payload.UnknownCriteria || payload.unknownCriteria || [],
      ScoreBreakdown: payload.ScoreBreakdown || payload.scoreBreakdown || {},
      Explanation: payload.Explanation || payload.explanation || '',
      Status: payload.Status || payload.status || 'Active',
      AlgorithmVersion: payload.AlgorithmVersion || payload.algorithmVersion || 'matching-v1',
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString()
    };

    db.Matches.push(match);
    this.write(db);
    this.addTimelineEntry(match.LeadID, 'Match', match.MatchID, 'MATCH_FOUND', 'Match found', match);
    return match;
  }

  updateMatch(matchId, changes) {
    const db = this.read();
    db.Matches = db.Matches || [];
    const index = db.Matches.findIndex((m) => m.MatchID === matchId);
    if (index === -1) return null;

    const updated = { ...db.Matches[index], ...changes, UpdatedAt: new Date…44286 tokens truncated…onst next = {
      ...before,
      ...this.safeClone(changes),
      NotificationSettings: {
        ...before.NotificationSettings,
        ...(changes.NotificationSettings || {})
      },
      Security: {
        ...before.Security,
        ...(changes.Security || {})
      },
      Business: {
        ...before.Business,
        ...(changes.Business || {})
      }
    };
    next.ConfigurationVersion = Number(before.ConfigurationVersion || 1) + 1;
    const updated = {
      ...current,
      Value: next,
      Version: next.ConfigurationVersion,
      UpdatedAt: new Date().toISOString()
    };
    const index = db.Settings.findIndex((row) => row.Key === 'global');
    if (index === -1) {
      db.Settings.push(updated);
    } else {
      db.Settings[index] = updated;
    }

    db.ConfigurationHistory.push({
      ConfigurationHistoryID: this.createId('CONFH'),
      Scope: 'Settings',
      ScopeID: updated.SettingsID,
      Version: updated.Version,
      Before: before,
      After: next,
      CreatedAt: new Date().toISOString()
    });

    this.recordAudit(db, {
      action: 'SETTING_CHANGED',
      module: 'Settings',
      entityType: 'Settings',
      entityId: updated.SettingsID,
      before,
      after: next,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(next) };
  }

  getRoles() {
    const db = this.ensureAdminCollections(this.read());
    if (!db.Roles.length) {
      db.Roles = this.getDefaultRoles().map((role) => ({
        ...role,
        CreatedAt: new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      }));
      this.write(db);
    }
    return db.Roles;
  }

  getRole(roleName) {
    const normalized = String(roleName || '').trim().toUpperCase();
    return this.getRoles().find((row) => String(row.Name || '').trim().toUpperCase() === normalized) || null;
  }

  saveRole(payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const name = String(payload.Name || payload.name || '').trim().toUpperCase();
    if (!name) return { ok: false, error: 'Role name is required' };
    const permissions = Array.from(new Set((payload.Permissions || payload.permissions || []).map((item) => String(item).trim()).filter(Boolean)));
    const description = payload.Description || payload.description || '';
    const isSystemRole = Boolean(payload.SystemRole || payload.systemRole || false);

    const existing = db.Roles.find((row) => String(row.Name || '').trim().toUpperCase() === name);
    const before = existing ? this.safeClone(existing) : null;
    const next = {
      RoleID: existing?.RoleID || this.createId('ROLE'),
      Name: name,
      Description: description,
      Permissions: permissions.length ? permissions : (existing?.Permissions || []),
      Status: payload.Status || payload.status || existing?.Status || 'Active',
      SystemRole: existing?.SystemRole ?? isSystemRole,
      CreatedAt: existing?.CreatedAt || new Date().toISOString(),
      UpdatedAt: new Date().toISOString()
    };

    if (existing) {
      Object.assign(existing, next);
    } else {
      db.Roles.push(next);
    }

    this.recordAudit(db, {
      action: existing ? 'ROLE_CHANGED' : 'ROLE_CREATED',
      module: 'Roles',
      entityType: 'Role',
      entityId: next.RoleID,
      before,
      after: next,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(next) };
  }

  getPermissions() {
    const db = this.ensureAdminCollections(this.read());
    if (!db.Permissions.length) {
      db.Permissions = this.getPermissionCatalog().map((item) => ({ ...item, Active: true }));
      this.write(db);
    }
    return db.Permissions;
  }

  getUser(userId) {
    const db = this.ensureAdminCollections(this.read());
    const index = this.findUserIndexById(db.Users, userId);
    return index === -1 ? null : db.Users[index];
  }

  listUsers() {
    const db = this.ensureAdminCollections(this.read());
    return db.Users.slice().sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')));
  }

  createUser(payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const name = String(payload.Name || payload.name || '').trim();
    const email = String(payload.Email || payload.email || '').trim().toLowerCase();
    const googleEmail = String(payload.GoogleEmail || payload.googleEmail || '').trim().toLowerCase();
    const mobile = String(payload.Mobile || payload.mobile || '').trim();
    const role = String(payload.Role || payload.role || 'AGENT').trim().toUpperCase();
    const status = String(payload.Status || payload.status || 'Active').trim();
    const userId = this.normalizeStoredIdentifier(payload.UserID || payload.userId || payload.userID || '') || this.createId('USR');
    const companyId = this.normalizeStoredIdentifier(payload.CompanyID || payload.CompanyId || payload.companyId || payload.companyID || '');
    const brokerageId = this.normalizeStoredIdentifier(payload.BrokerageID || payload.BrokerageId || payload.brokerageId || payload.brokerageID || '');
    if (!name || !email) return { ok: false, error: 'Name and email are required' };
    if (db.Users.some((row) => String(row.Email || '').trim().toLowerCase() === email)) {
      return { ok: false, error: 'Email already exists' };
    }
    if (this.findUserIndexById(db.Users, userId) !== -1) {
      return { ok: false, error: 'UserID already exists' };
    }

    const user = {
      UserID: userId,
      Name: name,
      Mobile: mobile,
      Role: role,
      Email: email,
      GoogleEmail: googleEmail || undefined,
      Status: status,
      CompanyID: companyId || undefined,
      BrokerageID: brokerageId || undefined,
      Permissions: Array.from(new Set((payload.Permissions || payload.permissions || []).map((item) => String(item).trim()).filter(Boolean))),
      CreatedAt: payload.CreatedAt || new Date().toISOString(),
      UpdatedAt: payload.UpdatedAt || new Date().toISOString(),
      LastLoginAt: payload.LastLoginAt || null,
      DisabledAt: null,
      Notes: payload.Notes || payload.notes || ''
    };
    db.Users.push(this.normalizeUserRecord(user));

    this.recordAudit(db, {
      action: 'USER_CREATED',
      module: 'Users',
      entityType: 'User',
      entityId: user.UserID,
      before: null,
      after: user,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(user) };
  }

  updateUser(userId, payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const index = this.findUserIndexById(db.Users, userId);
    if (index === -1) return { ok: false, error: 'User not found' };
    const existing = db.Users[index];
    const before = this.safeClone(existing);
    const updated = this.normalizeUserRecord({
      ...existing,
      Name: payload.Name || payload.name || existing.Name,
      Mobile: payload.Mobile || payload.mobile || existing.Mobile,
      Email: (payload.Email || payload.email || existing.Email || '').trim().toLowerCase(),
      GoogleEmail: (payload.GoogleEmail || payload.googleEmail || existing.GoogleEmail || '').trim().toLowerCase() || undefined,
      Role: String(payload.Role || payload.role || existing.Role || 'AGENT').trim().toUpperCase(),
      Status: payload.Status || payload.status || existing.Status,
      CompanyID: payload.CompanyID ?? payload.CompanyId ?? payload.companyId ?? payload.companyID ?? existing.CompanyID ?? existing.CompanyId,
      BrokerageID: payload.BrokerageID ?? payload.BrokerageId ?? payload.brokerageId ?? payload.brokerageID ?? existing.BrokerageID ?? existing.BrokerageId,
      Permissions: payload.Permissions || payload.permissions ? Array.from(new Set((payload.Permissions || payload.permissions || []).map((item) => String(item).trim()).filter(Boolean))) : existing.Permissions || [],
      LastLoginAt: payload.LastLoginAt || payload.lastLoginAt || existing.LastLoginAt || null,
      UpdatedAt: new Date().toISOString(),
      Notes: payload.Notes || payload.notes || existing.Notes || ''
    });
    db.Users[index] = updated;

    this.recordAudit(db, {
      action: 'USER_UPDATED',
      module: 'Users',
      entityType: 'User',
      entityId: userId,
      before,
      after: updated,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(updated) };
  }

  updateUserStatus(userId, status, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const index = this.findUserIndexById(db.Users, userId);
    if (index === -1) return { ok: false, error: 'User not found' };
    const normalized = String(status || '').trim();
    if (!['Active', 'Inactive', 'Disabled', 'Invited'].includes(normalized)) {
      return { ok: false, error: 'Invalid user status' };
    }
    const existing = db.Users[index];
    const before = this.safeClone(existing);
    const updated = {
      ...existing,
      Status: normalized,
      DisabledAt: normalized === 'Inactive' || normalized === 'Disabled' ? new Date().toISOString() : null,
      UpdatedAt: new Date().toISOString()
    };
    db.Users[index] = updated;

    this.recordAudit(db, {
      action: normalized === 'Active' ? 'USER_ACTIVATED' : 'USER_DISABLED',
      module: 'Users',
      entityType: 'User',
      entityId: userId,
      before,
      after: updated,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(updated) };
  }

  updateUserRole(userId, role, actor = {}) {
    return this.updateUser(userId, { Role: role }, actor);
  }

  updateUserPermissions(userId, permissions = [], actor = {}) {
    return this.updateUser(userId, { Permissions: permissions }, actor);
  }

  getMasterCatalog() {
    return ['LeadSources', 'Categories', 'Subcategories', 'PropertyTypes', 'BHK', 'Furnishing', 'TransactionTypes', 'RequirementStatuses', 'LeadStatuses', 'PropertyStatuses', 'DealStatuses', 'NegotiationStatuses', 'TokenStatuses', 'CommissionStatuses', 'ClosingStatuses', 'Locations', 'Builders', 'Projects'];
  }

  listMasters(filters = {}) {
    const db = this.ensureAdminCollections(this.read());
    const type = filters.masterType || filters.type || null;
    const active = filters.active;
    return db.Masters.filter((row) => {
      if (type && row.MasterType !== type) return false;
      if (active !== undefined && active !== null) {
        const desired = String(active).toLowerCase() !== 'false';
        if (Boolean(row.Active) !== desired) return false;
      }
      return true;
    }).sort((a, b) => String(a.MasterType || '').localeCompare(String(b.MasterType || '')) || String(a.Label || a.Value || '').localeCompare(String(b.Label || b.Value || '')));
  }

  createMaster(payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const masterType = String(payload.MasterType || payload.masterType || '').trim();
    const value = String(payload.Value || payload.value || '').trim();
    if (!masterType || !value) return { ok: false, error: 'MasterType and Value are required' };
    const duplicate = db.Masters.find((row) => row.MasterType === masterType && String(row.Value || '').trim().toLowerCase() === value.toLowerCase());
    if (duplicate) return { ok: false, error: 'Master value already exists' };

    const master = {
      MasterID: payload.MasterID || this.createId('MST'),
      MasterType: masterType,
      Value: value,
      Label: payload.Label || payload.label || value,
      Active: payload.Active !== undefined ? Boolean(payload.Active) : true,
      UsedCount: Number(payload.UsedCount || payload.usedCount || 0),
      Metadata: payload.Metadata || payload.metadata || {},
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString()
    };
    db.Masters.push(master);

    this.recordAudit(db, {
      action: 'MASTER_UPDATED',
      module: 'Masters',
      entityType: 'Master',
      entityId: master.MasterID,
      before: null,
      after: master,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(master) };
  }

  updateMaster(masterId, payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const index = db.Masters.findIndex((row) => row.MasterID === masterId);
    if (index === -1) return { ok: false, error: 'Master not found' };
    const existing = db.Masters[index];
    const before = this.safeClone(existing);
    const updated = {
      ...existing,
      Label: payload.Label || payload.label || existing.Label,
      Value: payload.Value || payload.value || existing.Value,
      Metadata: payload.Metadata || payload.metadata || existing.Metadata || {},
      Active: payload.Active !== undefined ? Boolean(payload.Active) : existing.Active,
      UpdatedAt: new Date().toISOString()
    };
    db.Masters[index] = updated;

    this.recordAudit(db, {
      action: 'MASTER_UPDATED',
      module: 'Masters',
      entityType: 'Master',
      entityId: masterId,
      before,
      after: updated,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(updated) };
  }

  deactivateMaster(masterId, actor = {}) {
    return this.updateMaster(masterId, { Active: false }, actor);
  }

  getPipelineConfig() {
    const db = this.ensureAdminCollections(this.read());
    if (!db.PipelineConfig.length) {
      const defaults = this.getDefaultPipelineConfig();
      for (const [module, stages] of Object.entries(defaults)) {
        db.PipelineConfig.push({
          PipelineConfigID: this.createId('PLC'),
          Module: module,
          Stages: stages,
          Transitions: [],
          Version: 1,
          Active: true,
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString()
        });
      }
      this.write(db);
    }
    return db.PipelineConfig;
  }

  updatePipelineConfig(payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const updates = Array.isArray(payload.modules) ? payload.modules : (payload.modules ? [payload.modules] : []);
    const before = this.safeClone(db.PipelineConfig);
    if (updates.length === 0) {
      return { ok: false, error: 'modules required' };
    }

    const nextRows = [];
    for (const moduleConfig of updates) {
      const module = String(moduleConfig.Module || moduleConfig.module || '').trim();
      const stages = Array.isArray(moduleConfig.Stages || moduleConfig.stages) ? (moduleConfig.Stages || moduleConfig.stages).map((item) => String(item).trim()).filter(Boolean) : [];
      if (!module || stages.length === 0) {
        return { ok: false, error: 'Each module requires a name and at least one stage' };
      }
      if (new Set(stages.map((item) => item.toLowerCase())).size !== stages.length) {
        return { ok: false, error: 'Pipeline stages must be unique' };
      }
      nextRows.push({
        PipelineConfigID: moduleConfig.PipelineConfigID || this.createId('PLC'),
        Module: module,
        Stages: stages,
        Transitions: moduleConfig.Transitions || moduleConfig.transitions || [],
        Version: Number(moduleConfig.Version || moduleConfig.version || 1),
        Active: moduleConfig.Active !== undefined ? Boolean(moduleConfig.Active) : true,
        CreatedAt: moduleConfig.CreatedAt || new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      });
    }

    db.PipelineConfig = nextRows;
    this.recordAudit(db, {
      action: 'SETTING_CHANGED',
      module: 'Pipeline',
      entityType: 'PipelineConfig',
      entityId: 'pipeline',
      before,
      after: nextRows,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(nextRows) };
  }

  getNotificationSettings() {
    const settings = this.getSettings();
    return this.safeClone(settings.NotificationSettings || this.getDefaultNotificationSettings());
  }

  updateNotificationSettings(changes = {}, actor = {}) {
    const current = this.getSettings();
    const next = {
      ...current,
      NotificationSettings: {
        ...current.NotificationSettings,
        ...changes
      }
    };
    return this.updateSettings(next, actor);
  }

  getFormRegistrySnapshot() {
    const db = this.ensureAdminCollections(this.read());
    const defaults = this.getDefaultFormRegistrySnapshot();
    const snapshot = { ...defaults };

    for (const row of db.FormRegistry) {
      if (!row || !row.FormType) continue;
      if (row.Active === false) continue;
      snapshot[String(row.FormType).toLowerCase()] = {
        formName: row.FormName || row.formName || row.FormType,
        entityType: row.EntityType || row.entityType || 'Requirement',
        category: row.Category || row.category || row.FormType,
        metadataVersion: row.MetadataVersion || row.metadataVersion || row.Version || 1,
        fields: this.safeClone(row.Fields || row.fields || {})
      };
    }

    return snapshot;
  }

  getFormRegistryRecords() {
    const db = this.ensureAdminCollections(this.read());
    return db.FormRegistry;
  }

  saveFormConfig(formType, payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const normalizedFormType = String(formType || payload.FormType || payload.formType || '').trim().toLowerCase();
    if (!normalizedFormType) return { ok: false, error: 'FormType is required' };
    const fields = payload.Fields || payload.fields || {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return { ok: false, error: 'Fields must be an object map' };
    }

    const existing = db.FormRegistry.find((row) => String(row.FormType || '').trim().toLowerCase() === normalizedFormType && row.Active !== false) || null;
    const before = existing ? this.safeClone(existing) : null;
    const next = {
      FormRegistryID: existing?.FormRegistryID || this.createId('FRG'),
      FormType: normalizedFormType,
      FormName: payload.FormName || payload.formName || existing?.FormName || normalizedFormType,
      EntityType: payload.EntityType || payload.entityType || existing?.EntityType || 'Requirement',
      Category: payload.Category || payload.category || existing?.Category || normalizedFormType,
      MetadataVersion: Number(payload.MetadataVersion || payload.metadataVersion || existing?.MetadataVersion || 1),
      Active: payload.Active !== undefined ? Boolean(payload.Active) : true,
      Fields: this.safeClone(fields),
      UpdatedAt: new Date().toISOString()
    };

    const existingIndex = db.FormRegistry.findIndex((row) => String(row.FormType || '').trim().toLowerCase() === normalizedFormType && row.Active !== false);
    if (existingIndex === -1) {
      db.FormRegistry.push(next);
    } else {
      db.FormRegistry[existingIndex] = next;
    }

    db.FormConfig.push({
      FormConfigID: this.createId('FCFG'),
      FormType: normalizedFormType,
      Version: next.MetadataVersion,
      FormRegistryID: next.FormRegistryID,
      Active: next.Active,
      Fields: this.safeClone(next.Fields),
      UpdatedAt: next.UpdatedAt
    });

    this.recordAudit(db, {
      action: 'FORM_UPDATED',
      module: 'Forms',
      entityType: 'FormRegistry',
      entityId: next.FormRegistryID,
      before,
      after: next,
      actor,
      result: 'SUCCESS'
    });

    this.write(db);
    return { ok: true, data: this.safeClone(next) };
  }

  updateFormField(formType, fieldId, changes = {}, actor = {}) {
    const snapshot = this.getFormRegistrySnapshot();
    const normalizedFormType = String(formType || '').trim().toLowerCase();
    const form = snapshot[normalizedFormType];
    if (!form) return { ok: false, error: 'Form config not found' };
    const fields = this.safeClone(form.fields || {});
    const existing = fields[fieldId] || null;
    if (!existing) return { ok: false, error: 'Field not found' };
    if (existing.SystemField || existing.systemField) {
      return { ok: false, error: 'System fields cannot be modified' };
    }
    const updated = { ...existing, ...changes };
    fields[fieldId] = updated;
    return this.saveFormConfig(normalizedFormType, { FormName: form.formName, EntityType: form.entityType, Category: form.category, MetadataVersion: Number(form.metadataVersion || 1) + 1, Fields: fields }, actor);
  }

  deactivateFormField(formType, fieldId, actor = {}) {
    return this.updateFormField(formType, fieldId, { Active: false }, actor);
  }

  reorderFormFields(formType, orderedFieldIds = [], actor = {}) {
    const snapshot = this.getFormRegistrySnapshot();
    const normalizedFormType = String(formType || '').trim().toLowerCase();
    const form = snapshot[normalizedFormType];
    if (!form) return { ok: false, error: 'Form config not found' };
    const fields = this.safeClone(form.fields || {});
    const existingIds = Object.keys(fields);
    if (orderedFieldIds.length !== existingIds.length) {
      return { ok: false, error: 'Field order must include every field' };
    }
    const reordered = {};
    for (const fieldId of orderedFieldIds) {
      if (!fields[fieldId]) return { ok: false, error: `Unknown field ${fieldId}` };
      reordered[fieldId] = fields[fieldId];
    }
    return this.saveFormConfig(normalizedFormType, { FormName: form.formName, EntityType: form.entityType, Category: form.category, MetadataVersion: Number(form.metadataVersion || 1) + 1, Fields: reordered }, actor);
  }

  recordAudit(db, entry = {}) {
    db.Audit = db.Audit || [];
    const actor = entry.actor || {};
    const user = this.getUser(actor.userId) || null;
    const row = {
      AuditID: this.createId('AUD'),
      Timestamp: entry.timestamp || new Date().toISOString(),
      UserID: actor.userId || actor.userID || 'system',
      UserName: user?.Name || actor.userName || null,
      Action: entry.action || entry.Action || 'UNKNOWN',
      Module: entry.module || entry.Module || 'System',
      EntityType: entry.entityType || entry.EntityType || null,
      EntityID: entry.entityId || entry.EntityID || null,
      Before: this.safeClone(entry.before ?? entry.Before ?? null),
      After: this.safeClone(entry.after ?? entry.After ?? null),
      IP: entry.ip || entry.IP || null,
      Device: entry.device || entry.Device || null,
      Result: entry.result || entry.Result || 'SUCCESS'
    };
    db.Audit.push(row);
    return row;
  }

  listAudit(filters = {}) {
    const db = this.ensureAdminCollections(this.read());
    const from = filters.dateFrom || filters.fromDate || null;
    const to = filters.dateTo || filters.toDate || null;
    return db.Audit.filter((row) => {
      if (filters.userId && row.UserID !== filters.userId) return false;
      if (filters.module && String(row.Module || '').toLowerCase() !== String(filters.module).toLowerCase()) return false;
      if (filters.action && String(row.Action || '').toLowerCase() !== String(filters.action).toLowerCase()) return false;
      if (filters.entityType && String(row.EntityType || '').toLowerCase() !== String(filters.entityType).toLowerCase()) return false;
      if (from && String(row.Timestamp || '') < from) return false;
      if (to && String(row.Timestamp || '') > to) return false;
      return true;
    }).sort((a, b) => String(b.Timestamp || '').localeCompare(String(a.Timestamp || '')));
  }

  hasPermission(actor = {}, permission) {
    if (!permission) return true;
    const normalizedPermission = String(permission).trim().toUpperCase();
    const user = actor.userId ? this.getUser(actor.userId) : null;
    const roleName = String(user?.Role || actor.role || 'AGENT').trim().toUpperCase();
    if (roleName === 'ADMIN') return true;

    const role = this.getRole(roleName);
    const rolePermissions = new Set((role?.Permissions || []).map((item) => String(item).trim().toUpperCase()));
    const userPermissions = new Set((user?.Permissions || []).map((item) => String(item).trim().toUpperCase()));
    if (rolePermissions.has('*') || userPermissions.has('*')) return true;
    if (rolePermissions.has(normalizedPermission) || userPermissions.has(normalizedPermission)) return true;
    return false;
  }

  getAdminOverview() {
    const db = this.ensureAdminCollections(this.read());
    const settings = this.getSettings();
    const backups = db.Backups || [];
    const audit = db.Audit || [];
    const users = db.Users || [];
    const leads = db.Leads || [];
    const requirements = db.Requirements || [];
    const inventory = db.Inventory || [];
    const deals = db.Deals || [];
    const commissions = db.Commission || [];

    const countByRole = (role) => users.filter((user) => String(user.Role || '').toUpperCase() === role).length;
    const activeUsers = users.filter((user) => String(user.Status || '').toUpperCase() === 'ACTIVE').length;

    return {
      ok: true,
      data: {
        totalUsers: users.length,
        activeUsers,
        inactiveUsers: users.length - activeUsers,
        adminUsers: countByRole('ADMIN'),
        managerUsers: countByRole('MANAGER'),
        agentUsers: countByRole('AGENT'),
        totalLeads: leads.length,
        activeLeads: leads.filter((lead) => ['ACTIVE', 'VERIFIED', 'NEW'].includes(String(lead.LeadStatus || '').toUpperCase())).length,
        inventory: inventory.length,
        requirements: requirements.length,
        deals: deals.length,
        pendingCommission: commissions.filter((row) => String(row.Status || '').toUpperCase() !== 'RECEIVED').length,
        system: {
          databaseStatus: 'OK',
          lastBackup: backups.length ? backups[backups.length - 1].CreatedAt : null,
          auditEvents: audit.length,
          configurationVersion: settings.ConfigurationVersion || 1,
          applicationVersion: appVersion
        }
      }
    };
  }

  getHealth() {
    const db = this.ensureAdminCollections(this.read());
    const requiredCollections = ['Users', 'Roles', 'Leads', 'Requirements', 'Inventory', 'Matches', 'Shortlists', 'SiteVisits', 'Negotiations', 'Tokens', 'Deals', 'Commission', 'Closings', 'Audit', 'Settings', 'Masters', 'PipelineConfig', 'Backups', 'FormConfig', 'FormRegistry'];
    const missingCollections = requiredCollections.filter((name) => !Object.prototype.hasOwnProperty.call(db, name));
    const settings = this.getSettings();
    const warnings = [];
    if (!settings.Timezone) warnings.push('Timezone not configured');
    if (!settings.Currency) warnings.push('Currency not configured');

    const mongoStats = mongoStore.stats();
    const mongoWriteStatus = !mongoStats.enabled
      ? 'NOT_APPLICABLE'
      : !mongoStats.initialized
        ? 'UNAVAILABLE'
        : mongoStats.lastError
          ? 'FAILED'
          : Number(mongoStats.pendingWrites || 0) > 0
            ? 'PENDING'
          : Number(mongoStats.successes || 0) > 0
            ? 'HEALTHY'
            : 'UNKNOWN';
    const writable = mongoStats.enabled
      ? mongoWriteStatus === 'HEALTHY'
      : (() => {
        try {
          fs.accessSync(path.dirname(this.dbFile), fs.constants.W_OK);
          return true;
        } catch (_) {
          return false;
        }
      })();

    const checks = {
      databaseReadable: true,
      databaseWritable: writable,
      mongoWriteStatus,
      schemaValid: missingCollections.length === 0,
      requiredCollectionsPresent: missingCollections.length === 0,
      apiReachable: true,
      configurationValid: warnings.length === 0,
      authSubsystemAvailable: db.Users.length > 0 && db.Roles.length > 0,
      auditSubsystemAvailable: Array.isArray(db.Audit)
    };

    const problems = [
      ...missingCollections.map((item) => `Missing collection: ${item}`),
      ...warnings,
      ...(mongoWriteStatus === 'FAILED' ? ['Mongo snapshot writes are failing'] : []),
      ...(mongoWriteStatus === 'UNAVAILABLE' ? ['MongoDB is not initialized'] : []),
      ...(mongoWriteStatus === 'UNKNOWN' ? ['Mongo write readiness is not established yet'] : []),
      ...(mongoWriteStatus === 'PENDING' ? ['Mongo writes are awaiting durable confirmation'] : [])
    ];

    return {
      ok: true,
      data: {
        status: problems.length ? (missingCollections.length ? 'ERROR' : 'WARNING') : 'PASS',
        checks,
        issues: problems
      }
    };
  }

  buildMaintenanceIssues() {
    const db = this.ensureAdminCollections(this.read());
    const issues = [];
    const addIssue = (issueType, entity, id, severity, suggestedAction) => {
      issues.push({ issueType, entity, id, severity, suggestedAction });
    };

    const leadIds = new Set((db.Leads || []).map((row) => row.LeadID));
    const requirementIds = new Set((db.Requirements || []).map((row) => row.RequirementID));
    const propertyIds = new Set((db.Inventory || []).map((row) => row.PropertyID));
    const matchIds = new Set((db.Matches || []).map((row) => row.MatchID));
    const shortlistIds = new Set((db.Shortlists || []).map((row) => row.ShortlistID));
    const visitIds = new Set((db.SiteVisits || []).map((row) => row.VisitID));
    const negotiationIds = new Set((db.Negotiations || []).map((row) => row.NegotiationID));
    const tokenIds = new Set((db.Tokens || []).map((row) => row.TokenID));
    const dealIds = new Set((db.Deals || []).map((row) => row.DealID));
    const commissionIds = new Set((db.Commission || []).map((row) => row.CommissionID));

    for (const row of db.Requirements || []) {
      if (!leadIds.has(row.LeadID)) addIssue('ORPHAN_RECORD', 'Requirement', row.RequirementID, 'ERROR', 'Link requirement to an existing lead or archive it');
      if (!row.TransactionType) addIssue('MISSING_REQUIRED_FIELD', 'Requirement', row.RequirementID, 'WARNING', 'Populate transaction type');
    }
    for (const row of db.Inventory || []) {
      if (!row.PropertyID) addIssue('MISSING_REQUIRED_FIELD', 'Inventory', 'UNKNOWN', 'ERROR', 'Assign a property ID');
      if (!row.Status) addIssue('MISSING_REQUIRED_FIELD', 'Inventory', row.PropertyID, 'WARNING', 'Populate inventory status');
    }
    for (const row of db.Matches || []) {
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'Match', row.MatchID, 'ERROR', 'Link match to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'Match', row.MatchID, 'ERROR', 'Link match to an existing property');
    }
    for (const row of db.Shortlists || []) {
      if (!leadIds.has(row.LeadID)) addIssue('BROKEN_RELATIONSHIP', 'Shortlist', row.ShortlistID, 'ERROR', 'Link shortlist to an existing lead');
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'Shortlist', row.ShortlistID, 'ERROR', 'Link shortlist to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'Shortlist', row.ShortlistID, 'ERROR', 'Link shortlist to an existing property');
      if (row.MatchID && !matchIds.has(row.MatchID)) addIssue('BROKEN_RELATIONSHIP', 'Shortlist', row.ShortlistID, 'ERROR', 'Link shortlist to an existing match');
    }
    for (const row of db.SiteVisits || []) {
      if (!leadIds.has(row.LeadID)) addIssue('BROKEN_RELATIONSHIP', 'SiteVisit', row.VisitID, 'ERROR', 'Link site visit to an existing lead');
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'SiteVisit', row.VisitID, 'ERROR', 'Link site visit to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'SiteVisit', row.VisitID, 'ERROR', 'Link site visit to an existing property');
      if (row.MatchID && !matchIds.has(row.MatchID)) addIssue('BROKEN_RELATIONSHIP', 'SiteVisit', row.VisitID, 'ERROR', 'Link site visit to an existing match');
      if (row.ShortlistID && !shortlistIds.has(row.ShortlistID)) addIssue('BROKEN_RELATIONSHIP', 'SiteVisit', row.VisitID, 'ERROR', 'Link site visit to an existing shortlist');
    }
    for (const row of db.Negotiations || []) {
      if (!leadIds.has(row.LeadID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing lead');
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing property');
      if (row.MatchID && !matchIds.has(row.MatchID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing match');
      if (row.ShortlistID && !shortlistIds.has(row.ShortlistID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing shortlist');
      if (row.SiteVisitID && !visitIds.has(row.SiteVisitID)) addIssue('BROKEN_RELATIONSHIP', 'Negotiation', row.NegotiationID, 'ERROR', 'Link negotiation to an existing site visit');
    }
    for (const row of db.Tokens || []) {
      if (!negotiationIds.has(row.NegotiationID)) addIssue('BROKEN_RELATIONSHIP', 'Token', row.TokenID, 'ERROR', 'Link token to an existing negotiation');
      if (!leadIds.has(row.LeadID)) addIssue('BROKEN_RELATIONSHIP', 'Token', row.TokenID, 'ERROR', 'Link token to an existing lead');
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'Token', row.TokenID, 'ERROR', 'Link token to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'Token', row.TokenID, 'ERROR', 'Link token to an existing property');
    }
    for (const row of db.Deals || []) {
      if (!tokenIds.has(row.TokenID)) addIssue('BROKEN_RELATIONSHIP', 'Deal', row.DealID, 'ERROR', 'Link deal to an existing token');
      if (!leadIds.has(row.LeadID)) addIssue('BROKEN_RELATIONSHIP', 'Deal', row.DealID, 'ERROR', 'Link deal to an existing lead');
      if (!requirementIds.has(row.RequirementID)) addIssue('BROKEN_RELATIONSHIP', 'Deal', row.DealID, 'ERROR', 'Link deal to an existing requirement');
      if (!propertyIds.has(row.PropertyID)) addIssue('BROKEN_RELATIONSHIP', 'Deal', row.DealID, 'ERROR', 'Link deal to an existing property');
    }
    for (const row of db.Commission || []) {
      if (!dealIds.has(row.DealID)) addIssue('BROKEN_RELATIONSHIP', 'Commission', row.CommissionID, 'ERROR', 'Link commission to an existing deal');
    }
    for (const row of db.Closings || []) {
      if (!dealIds.has(row.DealID)) addIssue('BROKEN_RELATIONSHIP', 'Closing', row.ClosingID, 'ERROR', 'Link closing to an existing deal');
    }

    const userEmails = new Map();
    for (const user of db.Users || []) {
      if (!user.UserID) addIssue('MISSING_REQUIRED_FIELD', 'User', 'UNKNOWN', 'ERROR', 'Assign a user ID');
      if (!user.Name) addIssue('MISSING_REQUIRED_FIELD', 'User', user.UserID, 'WARNING', 'Populate user name');
      if (!user.Email) addIssue('MISSING_REQUIRED_FIELD', 'User', user.UserID, 'WARNING', 'Populate user email');
      const email = String(user.Email || '').trim().toLowerCase();
      if (email) {
        if (userEmails.has(email)) addIssue('DUPLICATE_RECORD', 'User', user.UserID, 'WARNING', 'Deduplicate user email addresses');
        userEmails.set(email, user.UserID);
      }
      if (!['ADMIN', 'MANAGER', 'AGENT'].includes(String(user.Role || '').toUpperCase())) addIssue('INVALID_STATUS', 'User', user.UserID, 'WARNING', 'Use a supported role');
      if (!['Active', 'Inactive', 'Disabled', 'Invited'].includes(String(user.Status || '').trim())) addIssue('INVALID_STATUS', 'User', user.UserID, 'WARNING', 'Use a supported user status');
    }

    return issues;
  }

  getMaintenanceReport() {
    const issues = this.buildMaintenanceIssues();
    return {
      ok: true,
      data: {
        totalIssues: issues.length,
        issues
      }
    };
  }

  createBackup(payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const snapshot = this.safeClone(db);
    const serialized = JSON.stringify(snapshot);
    const backup = {
      BackupID: payload.BackupID || this.createId('BKP'),
      CreatedAt: new Date().toISOString(),
      CreatedBy: payload.CreatedBy || payload.createdBy || actor.userId || 'system',
      Size: Buffer.byteLength(serialized, 'utf8'),
      Status: 'AVAILABLE',
      Checksum: crypto.createHash('sha256').update(serialized).digest('hex'),
      Label: payload.Label || payload.label || 'manual',
      Snapshot: snapshot
    };
    db.Backups.push(backup);
    this.recordAudit(db, {
      action: 'BACKUP_CREATED',
      module: 'Backup',
      entityType: 'Backup',
      entityId: backup.BackupID,
      before: null,
      after: { ...backup, Snapshot: undefined },
      actor,
      result: 'SUCCESS'
    });
    this.write(db);
    return { ok: true, data: { ...backup, Snapshot: undefined } };
  }

  listBackups() {
    const db = this.ensureAdminCollections(this.read());
    return db.Backups.map((row) => ({ ...row, Snapshot: undefined }));
  }

  getBackup(backupId) {
    const db = this.ensureAdminCollections(this.read());
    return db.Backups.find((row) => row.BackupID === backupId) || null;
  }

  validateSnapshot(snapshot) {
    const requiredCollections = ['Users', 'Roles', 'Leads', 'Requirements', 'Inventory', 'Matches', 'Shortlists', 'SiteVisits', 'Negotiations', 'Tokens', 'Deals', 'Commission', 'Closings', 'Audit', 'Settings', 'Masters', 'PipelineConfig', 'Backups', 'FormConfig', 'FormRegistry'];
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: 'Invalid backup payload' };
    for (const collection of requiredCollections) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, collection)) {
        return { ok: false, error: `Missing collection: ${collection}` };
      }
      if (!Array.isArray(snapshot[collection]) && collection !== 'Settings') {
        return { ok: false, error: `Invalid collection format: ${collection}` };
      }
    }
    return { ok: true };
  }

  restoreBackup(backupId, payload = {}, actor = {}) {
    const db = this.ensureAdminCollections(this.read());
    const backup = db.Backups.find((row) => row.BackupID === backupId);
    if (!backup) return { ok: false, error: 'Backup not found' };
    if (String(payload.confirm || payload.confirmation || '').trim().toUpperCase() !== 'RESTORE') {
      return { ok: false, error: 'Restore confirmation is required' };
    }

    const safety = this.createBackup({ Label: 'pre-restore safety' }, actor);
    if (!safety.ok) return safety;

    const validation = this.validateSnapshot(backup.Snapshot);
    if (!validation.ok) return validation;

    const restored = this.safeClone(backup.Snapshot);
    restored.Backups = db.Backups;
    restored.Settings = restored.Settings || [];
    restored.Roles = restored.Roles || [];
    restored.Users = restored.Users || [];
    restored.PipelineConfig = restored.PipelineConfig || [];
    restored.Notifications = restored.Notifications || [];
    restored.Masters = restored.Masters || [];
    restored.Audit = restored.Audit || [];
    restored.FormConfig = restored.FormConfig || [];
    restored.FormRegistry = restored.FormRegistry || [];

    this.write(restored);
    this.recordAudit(restored, {
      action: 'RESTORE_STARTED',
      module: 'Backup',
      entityType: 'Backup',
      entityId: backupId,
      before: null,
      after: { backupId },
      actor,
      result: 'SUCCESS'
    });
    this.write(restored);
    return { ok: true, data: { BackupID: backupId, Status: 'RESTORED' } };
  }

  getAdminSummaryCollections() {
    const db = this.ensureAdminCollections(this.read());
    return db;
  }
}

module.exports = { JsonRepository };
