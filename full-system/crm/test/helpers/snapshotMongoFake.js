'use strict';

// Minimal expressions used by the persistence queue tests. Full Mongo syntax
// and compare-and-set behavior are checked against Mongo in the integration suite.
function expression(value, snapshot, row) {
  if (typeof value === 'string') {
    if (value.startsWith('$$row.')) return row[value.slice(6)];
    if (value === '$$row') return row;
    if (value.startsWith('$')) return value.slice(1).split('.').reduce((obj, key) => obj?.[key], snapshot);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if ('$literal' in value) return structuredClone(value.$literal);
  if ('$ifNull' in value) return expression(value.$ifNull[0], snapshot, row) ?? value.$ifNull[1];
  if ('$in' in value) return expression(value.$in[1], snapshot, row).includes(expression(value.$in[0], snapshot, row));
  if ('$not' in value) return !expression(value.$not[0], snapshot, row);
  if ('$eq' in value) return expression(value.$eq[0], snapshot, row) === expression(value.$eq[1], snapshot, row);
  if ('$filter' in value) return expression(value.$filter.input, snapshot, row).filter(item => expression(value.$filter.cond, snapshot, item));
  if ('$map' in value) return expression(value.$map.input, snapshot, row).map(item => expression(value.$map.in, snapshot, item));
  if ('$switch' in value) {
    const branch = value.$switch.branches.find(item => expression(item.case, snapshot, row));
    return expression(branch ? branch.then : value.$switch.default, snapshot, row);
  }
  if ('$concatArrays' in value) return value.$concatArrays.flatMap(item => expression(item, snapshot, row));
  throw new Error('Unhandled fake Mongo expression');
}

function applyUpdate(snapshot, pipeline) {
  const next = structuredClone(snapshot);
  for (const stage of pipeline) {
    for (const [path, value] of Object.entries(stage.$set || {})) {
      const parts = path.split('.'), key = parts.pop();
      const parent = parts.reduce((obj, part) => obj[part] ||= {}, next);
      parent[key] = expression(value, snapshot);
    }
    for (const path of stage.$unset || []) {
      const parts = path.split('.'), key = parts.pop();
      delete parts.reduce((obj, part) => obj[part], next)[key];
    }
  }
  return next;
}

module.exports = { applyUpdate };
