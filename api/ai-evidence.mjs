// A model output must never introduce unsupported evidence references.
// Dynamic enum constrains references at generation time; validation protects
// older model implementations and imperfect responses at runtime.
export function analysisSchema(facts) {
  const allowed = Object.keys(facts);
  if (!allowed.length) throw Error('No analysis evidence');
  const item = {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string' },
      explanation: { type: 'string' },
      recommendation: { type: 'string' },
      evidence_ids: { type: 'array', items: { type: 'string', enum: allowed } }
    },
    required: ['title', 'explanation', 'recommendation', 'evidence_ids']
  };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      issues: { type: 'array', items: item },
      positives: { type: 'array', items: item }
    },
    required: ['summary', 'issues', 'positives']
  };
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  // Model-written numbers cannot be independently checked against evidence.
  if (!text || text.length > limit || /[0-9]/.test(text)) return null;
  return text;
}

export function validateAIAnalysis(parsed, facts) {
  if (!parsed || !Array.isArray(parsed.issues) || !Array.isArray(parsed.positives))
    throw Error('Invalid AI shape');
  if (parsed.issues.length > 3 || parsed.positives.length > 2)
    throw Error('AI insight count out of range');
  const allowed = new Set(Object.keys(facts));
  let discarded = 0, unknownRefs = 0;
  function collect(items) {
    const accepted=[];
    for(const value of items) {
      const ids = Array.isArray(value?.evidence_ids) ? [...new Set(value.evidence_ids)] : [];
      const known=ids.filter(id => typeof id==='string' && allowed.has(id));
      unknownRefs += ids.length-known.length;
      const title=cleanText(value?.title,120);
      const explanation=cleanText(value?.explanation,500);
      const recommendation=cleanText(value?.recommendation,460);
      if (!known.length || known.length > 4 || !title || !explanation || !recommendation) {
        discarded++;
        continue;
      }
      accepted.push({title,explanation,recommendation,evidence: known.map(id => facts[id])});
    }
    return accepted;
  }
  const issues=collect(parsed.issues);
  const positives=collect(parsed.positives);
  // Better to display an explicit AI error than claim an unevidenced conclusion.
  if (issues.length+positives.length===0)
    throw Error('AI returned no verifiable insights');
  const summary=cleanText(parsed.summary,480);
  return {
    analysis: {summary:summary||'Основные изменения и рекомендации по загруженным данным.',issues,positives},
    diagnostics: {discarded,unknownRefs}
  };
}
