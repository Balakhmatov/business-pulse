import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInPeriodFacts } from './ai-inperiod.mjs';

test('In-period analysis is defined',()=>assert.equal(typeof buildInPeriodFacts,'function'));

const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function fixture(){
  const to='2026-10-26',from=shift(to,-89),rows=[];
  for(let i=0;i<90;i++){
    const date=shift(from,i),part=Math.floor(i/30);
    for(const [item,prices] of [['Консультация',[10000,13000,20000]],['Анализы',[20000,15000,8000]]]){
      rows.push({sold_on:date,source_id:'hidden-'+date,item,amount_kopecks:prices[part],status:'sale'});
    }
  }
  return {rows,report:{period:{from,to,days:90,previous_from:shift(from,-90),previous_to:shift(from,-1)},
    coverage:{comparable:false},change_percent:null,operation_identity:{estimated:false}}};
}
test('90-day data has meaningful comparisons within its three equal windows',()=>{
  const {rows,report}=fixture();
  const facts=buildInPeriodFacts(report,rows);
  assert.ok(facts.selected_window_1&&facts.selected_window_2&&facts.selected_window_3);
  assert.match(facts.within_period_latest_change,/Динамика ВНУТРИ выбранного периода/);
  assert.match(facts.within_period_item_growth_1,/Консультация/);
  assert.match(facts.within_period_item_decline_1,/Анализы/);
  assert.match(facts.selected_window_1,/2026-07-29 — 2026-08-27/);
  assert.match(facts.selected_window_3,/2026-09-27 — 2026-10-26/);
  assert.doesNotMatch(JSON.stringify(facts),/hidden-/);
});
test('Incomplete final window is not reported as proven loss',()=>{
  const {rows,report}=fixture();
  const limited=rows.filter(r=>r.sold_on<'2026-10-01'||r.sold_on>='2026-10-17');
  const facts=buildInPeriodFacts(report,limited);
  assert.equal(facts.within_period_latest_change,undefined);
  assert.equal(facts.selected_window_3,undefined);
});
