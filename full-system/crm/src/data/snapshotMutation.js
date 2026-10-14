'use strict';

const { modelSchema } = require('./schema');
const ownIds = { ...Object.fromEntries(Object.entries(modelSchema.entityDefinitions).map(([name, fields]) => [name, fields[0]])), SourceSheetArtifacts: 'ArtifactID' };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const literal = value => ({ $literal: value });
const rowsById = (rows, key) => new Map(rows.map(row => [row[key], row]));

function uniqueRows(rows, key) {
  return Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && typeof row[key] === 'string' && row[key]) &&
    new Set(rows.map(row => row[key])).size === rows.length;
}

// Only the changed records cross the wire. Legacy/unkeyed data uses a
// collection-level patch, retaining the existing three-way merge semantics.
function planMutation(base, desired) {
  const plan = [];
  for (const name of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    if (equal(base[name], desired[name]) && own(base, name) === own(desired, name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid snapshot collection key');
    const key = ownIds[name];
    if (key && uniqueRows(base[name] || [], key) && uniqueRows(desired[name], key)) {
      const before = rowsById(base[name] || [], key), after = rowsById(desired[name], key);
      const ids = [...new Set([...before.keys(), ...after.keys()])].filter(id => !equal(before.get(id), after.get(id)));
      // Ordering-only changes require the full collection merge.
      if (ids.length) { plan.push({ name, key, ids, before, after }); continue; }
    }
    plan.push({ name });
  }
  return plan;
}

function mutationProjection(plan) {
  const projection = { updatedAt: 1, revision: 1 };
  for (const change of plan) {
    projection[`payload.${change.name}`] = change.key ? {
      $filter: { input: { $ifNull: [`$payload.${change.name}`, []] }, as: 'row',
        cond: { $in: [`$$row.${change.key}`, literal(change.ids)] } }
    } : 1;
  }
  if (plan.some(change => change.name === 'Leads')) {
    projection.leadIdentities = { $map: { input: { $ifNull: ['$payload.Leads', []] }, as: 'row', in: {
      LeadID: '$$row.LeadID', PrimaryMobile: '$$row.PrimaryMobile', Phone: '$$row.Phone',
      MergedIntoClientID: '$$row.MergedIntoClientID', ClientStatus: '$$row.ClientStatus'
    } } };
  }
  return projection;
}

function mergeRecords(change, remoteRows, merge) {
  if (!uniqueRows(remoteRows, change.key)) throw new Error('Ambiguous record IDs changed concurrently; reload before saving');
  const remote = rowsById(remoteRows, change.key), merged = [];
  for (const id of change.ids) {
    const before = change.before.get(id), desired = change.after.get(id), current = remote.get(id);
    if (!desired) {
      if (current && !equal(current, before)) merged.push(current);
    } else if (!before && current && !equal(desired, current)) {
      const error = new Error('Concurrent creation used the same business record ID; reload before retrying');
      error.code = 'CONCURRENT_CREATE_CONFLICT'; throw error;
    } else {
      merged.push(current && before ? merge(before, desired, current) : desired);
    }
  }
  return merged;
}

function prepareMutation(plan, base, desired, current, merge) {
  const remote = current?.payload || {}, merged = {}, set = {}, unset = [];
  for (const change of plan) {
    const path = `payload.${change.name}`;
    if (change.key) {
      const currentRows = remote[change.name] || [];
      const rows = mergeRecords(change, currentRows, merge);
      merged[change.name] = rows;
      const currentIds = new Set(currentRows.map(row => row[change.key]));
      const retainedIds = rows.filter(row => currentIds.has(row[change.key])).map(row => row[change.key]);
      const deletedIds = change.ids.filter(id => currentIds.has(id) && !retainedIds.includes(id));
      const retained = rows.filter(row => currentIds.has(row[change.key]));
      const added = rows.filter(row => !currentIds.has(row[change.key]));
      const input = { $filter: { input: { $ifNull: [`$${path}`, []] }, as: 'row',
        cond: { $not: [{ $in: [`$$row.${change.key}`, literal(deletedIds)] }] } } };
      const existing = retained.length ? { $map: { input, as: 'row', in: { $switch: {
        branches: retained.map(row => ({ case: { $eq: [`$$row.${change.key}`, literal(row[change.key])] }, then: literal(row) })),
        default: '$$row'
      } } } } : input;
      set[path] = { $concatArrays: [existing, literal(added)] };
    } else {
      const hasRemote = own(remote, change.name), hasDesired = own(desired, change.name);
      if (!hasDesired && (!hasRemote || equal(remote[change.name], base[change.name]))) unset.push(path);
      else if (!hasDesired) { merged[change.name] = remote[change.name]; set[path] = literal(remote[change.name]); }
      else {
        merged[change.name] = merge(base[change.name] ?? {}, desired[change.name], remote[change.name] ?? {});
        set[path] = literal(merged[change.name]);
      }
    }
  }
  return { merged, set, unset };
}

// A lock may expire while a process is paused. Revision matching still prevents
// a stale writer from replacing a newer save. Legacy snapshots use updatedAt.
function snapshotFilter(current) {
  if (!current) return { _id: 'singleton', revision: { $exists: false }, updatedAt: { $exists: false } };
  return { _id: 'singleton', ...(own(current, 'revision') ? { revision: current.revision } : {
    revision: { $exists: false }, updatedAt: own(current, 'updatedAt') ? current.updatedAt : { $exists: false }
  }) };
}

function mergeCache(plan, desired, cache, merged, merge) {
  const next = { ...cache };
  for (const change of plan) {
    if (change.key) {
      const desiredRows = [...change.after.values()].filter(row => change.ids.includes(row[change.key]));
      // Merge by this collection's own ID, never a repeated foreign client ID.
      const result = mergeRecords({ ...change, before: rowsById(desiredRows, change.key),
        after: rowsById((cache[change.name] || []).filter(row => change.ids.includes(row[change.key])), change.key) }, merged[change.name], merge);
      const byId = rowsById(result, change.key);
      next[change.name] = (cache[change.name] || []).filter(row => !change.ids.includes(row[change.key]) || byId.has(row[change.key]))
        .map(row => byId.get(row[change.key]) || row);
      const existing = new Set(next[change.name].map(row => row[change.key]));
      for (const row of result) if (!existing.has(row[change.key])) next[change.name].push(row);
    } else if (own(merged, change.name)) next[change.name] = merge(desired[change.name] ?? {}, cache[change.name] ?? {}, merged[change.name]);
    else if (equal(cache[change.name], desired[change.name])) delete next[change.name];
  }
  return next;
}

module.exports = { planMutation, mutationProjection, prepareMutation, snapshotFilter, mergeCache };
