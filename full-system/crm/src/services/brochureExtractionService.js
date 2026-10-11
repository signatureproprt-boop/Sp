'use strict';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BYTES = 15 * 1024 * 1024;

const EXTRACTION_PROMPT = `You are extracting structured data from a real-estate builder project brochure PDF for a Surat, Gujarat brokerage.
Read the document carefully and return STRICT JSON ONLY (no markdown fences, no explanation, no extra text) with exactly this shape:
{
  "ProjectName": string or null,
  "BuilderName": string or null,
  "Location1": string or null,
  "Address": string or null,
  "RERANumber": string or null,
  "SalesPersonName": string or null,
  "SalesPersonPhone": string or null,
  "Category": one of "Residential", "Commercial", "Industrial", "Land", or null,
  "ProjectStatus": one of "New Launch", "Under Construction", "Ready to Move", "Completed", or null,
  "TotalUnits": number or null,
  "ProjectArea": string with stated land area and unit or null,
  "TotalTowers": number or null,
  "TotalFloors": number of floors per tower or null,
  "FloorHeightFt": number or null,
  "Overview": concise factual summary of brochure details or null,
  "PriceMin": number or null,
  "PriceMax": number or null,
  "PossessionDate": string in YYYY-MM-DD format or null,
  "Amenities": array of strings, one distinct amenity per item,
  "Highlights": array of strings, one factual feature/specification per item,
  "ConfigDetails": array of objects like {"Tower": "A", "FlatType": "1", "Type": "Apartment", "BHK": 3, "CarpetAreaSqft": 995, "SuperBuiltUpAreaSqft": 1809, "ParkingAllotted": 2, "ServantRoom": true}, one entry per distinct flat, penthouse, or terrace flat configuration/size in the brochure. Use null for every unknown value
}
Inspect EVERY page, including site plans, floor plans, legends and location maps. Count distinctly labelled buildings/towers (e.g. A and B = 2). A typical plan labelled LVL. 1-14 supports TotalFloors 14. Only derive TotalUnits when all towers, residential floor counts and units per floor are explicit and uniform; otherwise use null. Never infer current construction status from an undated "coming soon" marketing phrase. Overview must contain only supported facts, not invented marketing copy. Read C.A. as CarpetAreaSqft and S.A. (saleable/super built-up area) as SuperBuiltUpAreaSqft. Do not add EXTRA or EQ./equivalent figures to either area. Create a separate configuration for EVERY tower and flat number/type shown, even if the sizes match another tower or flat. Preserve the tower label and flat number exactly. Never merge A/B tower rows. List ALL supported amenities and features point-wise, including lifts labelled on floor plans, buildings, floor ranges, units per floor, and printed specifications. Do not invent amenities from pictures or surrounding landmarks. Extract every explicitly listed amenity, but never count nearby landmarks as amenities. Prices must be plain numbers in INR (no commas, no "Cr"/"L" suffix; convert e.g. 1.2 Cr to 12000000). Area values are in sqft; convert only when the brochure states units clearly. ParkingAllotted means spaces allotted to that unit, not total project parking. Extract a sales phone only if explicitly printed as a sales contact. If a field is genuinely not present, use null (or an empty array for list fields). Do not invent or guess data that is not in the document.`;

function parseModelJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Could not parse AI response as JSON');
  }
}

async function extractBrochure(fileBase64, pageImages) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server');

  const encoded = String(fileBase64 || '').replace(/^data:[^;]+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(encoded, 'base64');
  } catch (_) {
    throw new Error('Bad base64 payload');
  }
  if (!buffer.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) throw new Error('PDF too large (max 15 MB)');

  let documentParts = [{ inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') } }];
  if (Array.isArray(pageImages) && pageImages.length) {
    if (pageImages.length > 30) throw new Error('Too many rendered PDF pages');
    let totalBytes = 0;
    documentParts = pageImages.flatMap((page, index) => {
      const bytes = Buffer.from(String(page.data || ''), 'base64');
      totalBytes += bytes.length;
      if (!bytes.length || bytes[0] !== 0xff || bytes[1] !== 0xd8 || totalBytes > MAX_BYTES) {
        throw new Error('Invalid rendered PDF pages');
      }
      return [{ text: `Page ${index + 1} text: ${String(page.text || '').slice(0, 20000)}` },
        { inline_data: { mime_type: 'image/jpeg', data: bytes.toString('base64') } }];
    });
  }

  const response = await fetch(`${GEMINI_API_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(90000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: EXTRACTION_PROMPT },
          ...documentParts
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        // Brochure transcription needs fast extraction rather than extended reasoning.
        ...(/^gemini-3(?:\.|-)/i.test(GEMINI_MODEL.replace(/^models\//, ''))
          ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
      }
    })
  }).catch((error) => {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('AI extraction timed out. Please retry with a smaller PDF.');
    }
    throw error;
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
  }
  const text = payload?.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no extraction result');
  return parseModelJson(text);
}

module.exports = { extractBrochure };
