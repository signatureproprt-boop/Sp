'use strict';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_AGENT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_ITEMS = 12;
const MAX_CONTEXT_ROWS = 25;

function compactRows(rows, fields) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_CONTEXT_ROWS).map((row) => {
    const result = {};
    for (const field of fields) {
      if (row?.[field] !== undefined && row?.[field] !== null && row[field] !== '') result[field] = row[field];
    }
    return result;
  });
}

function buildCrmContext(repository) {
  const db = repository?.read?.() || {};
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      leads: Array.isArray(db.Leads) ? db.Leads.length : 0,
      requirements: Array.isArray(db.Requirements) ? db.Requirements.length : 0,
      inventory: Array.isArray(db.Inventory) ? db.Inventory.length : 0,
      builderProjects: Array.isArray(db.BuilderProjects) ? db.BuilderProjects.length : 0,
      followUps: Array.isArray(db.FollowUps) ? db.FollowUps.length : 0
    },
    leads: compactRows(db.Leads, ['ClientStatus', 'LeadStatus', 'City', 'Source', 'UpdatedAt']),
    requirements: compactRows(db.Requirements, ['TransactionType', 'Category', 'BudgetMin', 'BudgetMax', 'Location1', 'Status']),
    builderProjects: compactRows(db.BuilderProjects, ['ProjectID', 'ProjectName', 'BuilderName', 'Location1', 'Category', 'ProjectStatus', 'PriceMin', 'PriceMax', 'PossessionDate']),
    followUpSummary: { total: Array.isArray(db.FollowUps) ? db.FollowUps.length : 0, open: Array.isArray(db.FollowUps) ? db.FollowUps.filter((row) => String(row?.Status || '').toUpperCase() !== 'DONE').length : 0 }
  };
}

function parseAgentResponse(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.message !== 'string') throw new Error('Invalid agent response');
    return {
      message: parsed.message,
      suggestedActions: Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions.slice(0, 5).map(String) : [],
      proposedAction: parsed.proposedAction && typeof parsed.proposedAction === 'object'
        ? {
            type: String(parsed.proposedAction.type || '').trim(),
            limit: Number(parsed.proposedAction.limit) || 1000
          }
        : null
    };
  } catch (_) {
    return { message: cleaned, suggestedActions: [] };
  }
}

async function askGeminiAgent({ repository, message, history = [], model = DEFAULT_MODEL }) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server');
  const prompt = String(message || '').trim();
  if (!prompt) throw new Error('message is required');
  if (prompt.length > MAX_MESSAGE_LENGTH) throw new Error(`message too long (max ${MAX_MESSAGE_LENGTH} characters)`);

  const safeHistory = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_ITEMS).map((item) => ({
    role: item?.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(item?.text || '').slice(0, MAX_MESSAGE_LENGTH) }]
  })).filter((item) => item.parts[0].text);
  const system = `You are Signature Realty OS CRM Manager for a Surat, Gujarat real-estate brokerage.\nUse only the supplied CRM context and do not invent records, prices, availability, or legal advice. Be concise and practical. Answer in the user's language (Hinglish/Hindi/English). You may propose one operation, but never claim it ran. Allowed proposedAction types are: run_karma_scrape, sync_google_sheet, create_backup. Return STRICT JSON ONLY: {"message":"...","suggestedActions":["..."],"proposedAction":{"type":"run_karma_scrape|sync_google_sheet|create_backup","limit":1000} or null}.\nCRM context:\n${JSON.stringify(buildCrmContext(repository))}`;
  const contents = [...safeHistory, { role: 'user', parts: [{ text: `${system}\n\nUser request:\n${prompt}` }] }];
  const response = await fetch(`${GEMINI_API_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no agent response');
  return parseAgentResponse(text);
}

module.exports = { askGeminiAgent, buildCrmContext, parseAgentResponse };