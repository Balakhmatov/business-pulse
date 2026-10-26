import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisSchema, validateAIAnalysis } from './ai-evidence.mjs';

const facts={
  revenue_change:'Поступления снизились на 28,3%.',
  product_top_1:'Пицца Пепперони — 72 340 ₽.',
  weekday_weak:'Средний дневной оборот по вторникам ниже.'
};
function item(overrides={}) {
  return {
    title:'Снижение поступлений',
    explanation:'За последний период поступления заметно снизились.',
    recommendation:'Проверить динамику числа чеков и протестировать новое предложение.',
    evidence_ids:['revenue_change'],
    ...overrides
  };
}
test('OpenAI structured outputs allow only actual evidence keys',()=>{
  const shape=analysisSchema(facts);
  assert.deepEqual(shape.properties.issues.items.properties.evidence_ids.items.enum,Object.keys(facts));
});
test('an invented key does not invalidate independently supported conclusions',()=>{
  const result=validateAIAnalysis({
    summary:'Снижение выручки требует внимания.',
    issues:[
      item({evidence_ids:['wrong','revenue_change']}),
      item({title:'Выдуманный сигнал',evidence_ids:['invented']})
    ],
    positives:[item({
      title:'Сильная позиция меню',
      explanation:'Пицца популярна у покупателей.',
      recommendation:'Протестировать новое комбо с этой позицией.',
      evidence_ids:['product_top_1']
    })]
  },facts);
  assert.equal(result.analysis.issues.length,1);
  assert.equal(result.analysis.positives.length,1);
  assert.equal(result.analysis.issues[0].evidence[0],facts.revenue_change);
  assert.equal(result.diagnostics.unknownRefs,2);
  assert.equal(result.diagnostics.discarded,1);
});
test('unsupported-only output is rejected rather than published',()=>{
  assert.throws(()=>validateAIAnalysis({
    summary:'',issues:[item({evidence_ids:['unknown']})],positives:[]
  },facts),/no verifiable insights/);
});
test('unverified numeric statements are skipped while valid items survive',()=>{
  const result=validateAIAnalysis({
    summary:'Необоснованные 99 процентов',
    issues:[
      item({explanation:'Падение на 99 процентов',evidence_ids:['revenue_change']}),
      item({evidence_ids:['revenue_change']})
    ],positives:[]
  },facts);
  assert.equal(result.analysis.issues.length,1);
  assert.doesNotMatch(result.analysis.summary,/99/);
});
