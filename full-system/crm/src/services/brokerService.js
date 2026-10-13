const { JsonRepository } = require('../data/repository');

class BrokerService {
  constructor(repository = null) { this.repository = repository || new JsonRepository(); }
  async listBrokers() {
    return [
      { BrokerID: 'BRO-001', BrokerName: 'Astra Realty Co.', BrokerType: 'Broker', Company: 'Astra Realty', Status: 'Active' },
      { BrokerID: 'BRO-002', BrokerName: 'Urban Crest Brokers', BrokerType: 'Broker', Company: 'Urban Crest', Status: 'Active' }
    ];
  }

  async shareTransaction(transactionId, brokerId) {
    const transaction = this.repository.find('Transactions', 'TransactionID', transactionId);
    if (!transaction) {
      throw new Error('Transaction not found');
    }

    const submission = {
      BrokerSubmissionID: `SUB-${Date.now()}`,
      LeadID: transaction.LeadID,
      TransactionID: transaction.TransactionID,
      BrokerID: brokerId,
      Status: 'Draft',
      RejectReason: null,
      Version: 1,
      SubmittedAt: new Date().toISOString()
    };

    return submission;
  }

  async shareRequirement(requirementId, brokerId) {
    const db = this.repository.read();
    const legacy = (db.Requirements || []).find((row) => row.RequirementID === requirementId);
    const transactionId = legacy?.TransactionID || null;
    if (!transactionId) throw new Error('Transaction not found for legacy requirement');
    return this.shareTransaction(transactionId, brokerId);
  }

  async approveSubmission(submissionId) {
    return { BrokerSubmissionID: submissionId, Status: 'Approved' };
  }
}

module.exports = { BrokerService };
