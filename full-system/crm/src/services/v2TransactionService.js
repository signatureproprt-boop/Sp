/**
 * PHASE 6 — V2 Transaction Service
 *
 * Transactions are DURABLE — all writes go through repository (JSON file).
 * No in-memory-only storage.
 *
 * Transaction belongs to exactly one Lead.
 * TransactionID and LeadID are immutable after creation.
 */

'use strict';

const { IdEngine }     = require('../data/idEngine');
const { EntityConfig, WorkflowConfig } = require('../data/v2Config');

const TRANSACTION_TYPES   = EntityConfig.Transaction.types;
const TRANSACTION_STATUSES = EntityConfig.Transaction.statuses;
const PIPELINE_STAGES     = EntityConfig.Transaction.pipelineStages;

class V2TransactionService {
  constructor(repository) {
    if (!repository) throw new Error('V2TransactionService requires a repository');
    this.repository = repository;
    this.idEngine   = new IdEngine(repository);
  }

  // ── Create Transaction ─────────────────────────────────────────────────────

  createTransaction(leadId, payload, actor = {}) {
    // Validate lead exists
    const lead = this.repository.readLead(leadId);
    if (!lead) return { ok: false, error: `Lead not found: ${leadId}` };

    const txnType = payload.TransactionType || payload.transactionType || payload.Type || payload.type || null;
    if (!txnType || !TRANSACTION_TYPES.includes(txnType)) {
      return { ok: false, error: `Invalid TransactionType. Must be one of: ${TRANSACTION_TYPES.join(', ')}` };
    }

    const status = payload.TransactionStatus || payload.transactionStatus || payload.Status || payload.status || 'Open';
    if (!TRANSACTION_STATUSES.includes(status)) {
      return { ok: false, error: `Invalid TransactionStatus. Must be one of: ${TRANSACTION_STATUSES.join(', ')}` };
    }

    const stage = payload.PipelineStage || payload.pipelineStage || 'New';
    if (!PIPELINE_STAGES.includes(stage)) {
      return { ok: false, error: `Invalid PipelineStage. Must be one of: ${PIPELINE_STAGES.join(', ')}` };
    }

    const now   = new Date().toISOString();
    const txnId = this.idEngine.nextTransactionId();

    // Persist every dynamic form answer at creation time as well as on later edits.
    // This keeps BHK, furnishing, possession, frontage, amenities, etc. from
    // being lost when a Transaction is created directly from Client Workspace.
    const reservedPayloadKeys = new Set([
      'TransactionID','LeadID','CompanyID','companyId','BrokerageID','brokerageId',
      'TransactionType','transactionType','Type','type','TransactionStatus','transactionStatus',
      'Status','status','PipelineStage','pipelineStage','Notes','notes','Category','category',
      'SubCategory','subCategory','Fields','FieldPriorities','BudgetMin','budgetMin','BudgetMax',
      'budgetMax','Location1','location1','Location2','location2','Location3','location3',
      'TransactionScore','LegacyID','CreatedAt','CreatedBy','UpdatedAt','UpdatedBy','Version','_v2'
    ]);
    const dynamicFields = { ...(payload.Fields && typeof payload.Fields === 'object' ? payload.Fields : {}) };
    const dynamicFlat = {};
    for (const [key, value] of Object.entries(payload || {})) {
      if (reservedPayloadKeys.has(key)) continue;
      dynamicFlat[key] = value;
      dynamicFields[key] = value === null || value === ''
        ? { state: 'UNKNOWN', value: null, priority: payload.FieldPriorities?.[key] || dynamicFields[key]?.priority || null }
        : { state: 'KNOWN', value, priority: payload.FieldPriorities?.[key] || dynamicFields[key]?.priority || null };
    }

    const transaction = {
      TransactionID:     txnId,
      LeadID:            leadId,
      TransactionType:   txnType,
      Type:              txnType, // backward compat
      TransactionStatus: status,
      Status:            status,  // backward compat
      PipelineStage:     stage,
      Notes:             payload.Notes || payload.notes || '',
      // Transaction is the single business object. Property-need criteria live here.
      Category:          payload.Category || payload.category || null,
      SubCategory:       payload.SubCategory || payload.subCategory || null,
      Fields:            dynamicFields,
      ...dynamicFlat,
      BudgetMin:         payload.BudgetMin ?? payload.budgetMin ?? null,
      BudgetMax:         payload.BudgetMax ?? payload.budgetMax ?? null,
      Location1:         payload.Location1 || payload.location1 || null,
      Location2:         payload.Location2 || payload.location2 || null,
      Location3:         payload.Location3 || payload.location3 || null,
      TransactionScore:  payload.TransactionScore ?? null,
      CompanyID:         lead.CompanyID || payload.CompanyID || payload.companyId || actor.companyId || actor.companyID || null,
      BrokerageID:       lead.BrokerageID || payload.BrokerageID || payload.brokerageId || actor.brokerageId || actor.brokerageID || null,
      CreatedBy:         actor.userId || 'system',
      CreatedAt:         now,
      UpdatedBy:         actor.userId || 'system',
      UpdatedAt:         now,
      Version:           1,
      LegacyID:          payload.LegacyID || null,
      _v2:               true
    };

    const db = this.repository.read();
    db.Transactions = db.Transactions || [];
    db.Transactions.push(transaction);
    this.repository.write(db);

    this.repository.addTimelineEntry(leadId, 'Transaction', txnId, 'TRANSACTION_CREATED', `Transaction created (${txnType})`, { TransactionType: txnType, TransactionStatus: status });

    return { ok: true, data: transaction };
  }

  // ── Update Transaction ─────────────────────────────────────────────────────

  updateTransaction(transactionId, payload, actor = {}) {
    const db = this.repository.read();
    db.Transactions = db.Transactions || [];
    const idx = db.Transactions.findIndex((t) => t.TransactionID === transactionId);
    if (idx === -1) return { ok: false, error: 'Transaction not found' };

    const existing = db.Transactions[idx];

    // Guard immutables
    if (payload.TransactionID && payload.TransactionID !== transactionId) {
      return { ok: false, error: 'TransactionID is immutable' };
    }
    if (payload.LeadID && payload.LeadID !== existing.LeadID) {
      return { ok: false, error: 'LeadID is immutable on a Transaction' };
    }

    const now = new Date().toISOString();

    // Status transition
    let status = existing.TransactionStatus || existing.Status || 'Open';
    const nextStatus = payload.TransactionStatus || payload.transactionStatus || payload.Status || payload.status;
    if (nextStatus && nextStatus !== status) {
      const allowed = WorkflowConfig.transactionStatus.transitions[status] || [];
      if (!allowed.includes(nextStatus)) {
        return { ok: false, error: `Transaction status transition from '${status}' to '${nextStatus}' is not allowed` };
      }
      status = nextStatus;
    }

    // Pipeline stage — free movement, no enforced ordering
    let stage = existing.PipelineStage || 'New';
    const nextStage = payload.PipelineStage || payload.pipelineStage;
    if (nextStage) {
      if (!PIPELINE_STAGES.includes(nextStage)) {
        return { ok: false, error: `Invalid PipelineStage: ${nextStage}` };
      }
      stage = nextStage;
    }

    const updated = {
      ...existing,
      TransactionStatus: status,
      Status:            status,
      PipelineStage:     stage,
      Notes:             payload.Notes !== undefined ? payload.Notes : (payload.notes !== undefined ? payload.notes : existing.Notes),
      AssignedAgentID:   payload.AssignedAgentID || payload.assignedAgentId || existing.AssignedAgentID,
      Category:          payload.Category !== undefined ? payload.Category : existing.Category,
      SubCategory:       payload.SubCategory !== undefined ? payload.SubCategory : existing.SubCategory,
      Fields:            payload.Fields !== undefined ? payload.Fields : existing.Fields,
      BudgetMin:         payload.BudgetMin !== undefined ? payload.BudgetMin : existing.BudgetMin,
      BudgetMax:         payload.BudgetMax !== undefined ? payload.BudgetMax : existing.BudgetMax,
      Location1:         payload.Location1 !== undefined ? payload.Location1 : existing.Location1,
      Location2:         payload.Location2 !== undefined ? payload.Location2 : existing.Location2,
      Location3:         payload.Location3 !== undefined ? payload.Location3 : existing.Location3,
      TransactionScore:  payload.TransactionScore !== undefined ? payload.TransactionScore : existing.TransactionScore,
      UpdatedBy:         actor.userId || 'system',
      UpdatedAt:         now,
      Version:           (existing.Version || 1) + 1
    };

    db.Transactions[idx] = updated;
    this.repository.write(db);

    this.repository.addTimelineEntry(existing.LeadID, 'Transaction', transactionId, 'TRANSACTION_UPDATED', 'Transaction updated', { TransactionStatus: status, PipelineStage: stage });

    return { ok: true, data: updated };
  }

  // Store dynamic transaction/property criteria directly on Transaction.
  updateTransactionDetails(transactionId, payload = {}, actor = {}) {
    const db = this.repository.read();
    const idx = (db.Transactions || []).findIndex((t) => t.TransactionID === transactionId);
    if (idx === -1) return { ok: false, error: 'Transaction not found' };
    const existing = db.Transactions[idx];
    const reserved = new Set(['TransactionID','LeadID','CompanyID','BrokerageID','CreatedAt','CreatedBy','Version','_v2']);
    const next = { ...existing };
    const fields = { ...(existing.Fields || {}) };
    for (const [key, value] of Object.entries(payload || {})) {
      if (reserved.has(key)) continue;
      if (key === 'FieldPriorities') continue;
      if (['TransactionType','transactionType','Type','type'].includes(key)) continue;
      next[key] = value;
      if (!['Category','SubCategory','TransactionStatus','Status','PipelineStage','Notes','RequirementStatus'].includes(key)) {
        fields[key] = value === null || value === ''
          ? { state: 'UNKNOWN', value: null, priority: payload.FieldPriorities?.[key] || fields[key]?.priority || null }
          : { state: 'KNOWN', value, priority: payload.FieldPriorities?.[key] || fields[key]?.priority || null };
      }
    }
    next.Fields = fields;
    next.UpdatedBy = actor.userId || 'system';
    next.UpdatedAt = new Date().toISOString();
    next.Version = Number(existing.Version || 1) + 1;
    db.Transactions[idx] = next;
    this.repository.write(db);
    this.repository.addTimelineEntry(existing.LeadID, 'Transaction', transactionId, 'TRANSACTION_DETAILS_UPDATED', 'Transaction details updated', { Category: next.Category, SubCategory: next.SubCategory });
    return { ok: true, data: next };
  }

  // ── Read Helpers ───────────────────────────────────────────────────────────

  getTransaction(transactionId) {
    const db = this.repository.read();
    const row = (db.Transactions || []).find((t) => t.TransactionID === transactionId);
    if (!row) return { ok: false, error: 'Transaction not found' };
    return { ok: true, data: row };
  }

  listTransactionsByLead(leadId) {
    const db   = this.repository.read();
    const rows = (db.Transactions || []).filter((t) => t.LeadID === leadId);
    return rows.sort((a, b) => new Date(b.UpdatedAt || b.CreatedAt).getTime() - new Date(a.UpdatedAt || a.CreatedAt).getTime());
  }

  listAllTransactions(filters = {}) {
    const db  = this.repository.read();
    let rows  = db.Transactions || [];
    if (filters.LeadID)            rows = rows.filter((t) => t.LeadID === filters.LeadID);
    if (filters.TransactionType)   rows = rows.filter((t) => (t.TransactionType || t.Type) === filters.TransactionType);
    if (filters.TransactionStatus) rows = rows.filter((t) => (t.TransactionStatus || t.Status) === filters.TransactionStatus);
    if (filters.PipelineStage)     rows = rows.filter((t) => t.PipelineStage === filters.PipelineStage);
    return rows.sort((a, b) => new Date(b.UpdatedAt || b.CreatedAt).getTime() - new Date(a.UpdatedAt || a.CreatedAt).getTime());
  }
}

module.exports = { V2TransactionService };
