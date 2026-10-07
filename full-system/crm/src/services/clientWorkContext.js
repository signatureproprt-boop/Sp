'use strict';

// Requirements can exist before a deal. Resolve the owner without creating
// a transaction or putting a RequirementID into the TransactionID column.
function workKey(row = {}) { return row.RequirementID || row.TransactionID || null; }
function resolveClientWork(repo, id) {
  return repo.find('Requirements', 'RequirementID', id)
    || repo.find('Transactions', 'TransactionID', id);
}
function workLinks(record) {
  return { RequirementID: record.RequirementID || null,
    TransactionID: record.RequirementID ? (record.TransactionID || null) : record.TransactionID };
}
module.exports = { workKey, resolveClientWork, workLinks };
