const { MatchingEngine } = require('../services/matchingEngine');

class MatchingController {
  constructor(repository = null) {
    this.matchingEngine = new MatchingEngine({}, repository);
  }

  async matchTransaction(ctx = {}) {
    const transactionId = ctx?.params?.transactionId || ctx?.transactionId || ctx?.body?.transactionId || ctx?.body?.TransactionID || null;
    if (!transactionId) return { data: [], ok: false, error: 'transactionId required' };
    const matches = await this.matchingEngine.getMatchesForTransaction(transactionId);
    return { data: matches, ok: true };
  }

  async matchRequirement(ctx = {}) {
    const requirementId = ctx?.params?.requirementId || ctx?.requirementId || ctx?.body?.requirementId || null;
    if (!requirementId) return { data: [], ok: false, error: 'requirementId required' };
    const matches = await this.matchingEngine.getMatchesForRequirement(requirementId);
    return { data: matches, ok: true, compatibilityMode: true };
  }
}

module.exports = { MatchingController };
