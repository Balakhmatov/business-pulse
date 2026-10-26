import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createImportMapper,headerSignature,validateMapping } from './import-mapping.mjs';

const headers=['Дата закрытия','Код реализации','Номенклатура','Оплачено','Вид движения'];
const selected={date:0,id:1,item:2,amount:3,status:4};
const profile=(head=headers)=>head.map((h,i)=>({
  dates:i===0?1:0,nums:i===3?1:0,statuses:i===4?1:0,
  unique:i===1?1:0.5,words:i===2?1:0,zeroids:0,filled:1
}));
function fixture(opts={}){
  const db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON;"+
    "CREATE TABLE companies(id TEXT PRIMARY KEY);"+
    "INSERT INTO companies VALUES('a'),('b');");
  const service=createImportMapper({db,apiKey:'',...opts});
  return {db,service,close:()=>db.close()};
}
test('Template signature is insensitive to spacing and case, sensitive to column order',()=>{
  assert.equal(headerSignature(headers),headerSignature(headers.map(x=>'  '+x.toUpperCase()+'   ')));
  assert.notEqual(headerSignature(headers),headerSignature([...headers].reverse()));
});
test('Only a valid, non-overlapping manual mapping can become a saved template',t=>{
  const f=fixture();t.after(f.close);
  assert.throws(()=>validateMapping(headers,{...selected,amount:1}),/двум разным/);
  assert.equal(validateMapping(headers,{...selected,id:-1}).id,-1);
  assert.throws(()=>validateMapping(headers,{...selected,date:-1}),/обязательны/);
  assert.throws(()=>validateMapping(headers,{...selected,amount:headers.length}),/номер столбца/);
  const saved=f.service.confirm({id:'a'},{head:headers,mapping:selected});
  assert.equal(saved.saved,true);
});
test('Confirmed template belongs only to its company, never leaks across accounts',async t=>{
  const f=fixture();t.after(f.close);
  f.service.confirm({id:'a'},{head:headers,mapping:selected});
  const original=await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:false});
  assert.equal(original.source,'template');
  assert.deepEqual(original.mapping,selected);
  const other=await f.service.resolve({id:'b'},{head:headers,profiles:profile(),needs_ai:false});
  assert.equal(other.source,'heuristic');
  assert.equal(other.mapping,null);
  const newFormat=await f.service.resolve({id:'a'},{head:[...headers].reverse(),profiles:profile(),needs_ai:false});
  assert.equal(newFormat.source,'heuristic');
  assert.equal(newFormat.mapping,null);
});
test('Template confirmation updates corrected user mapping without adding new template',async t=>{
  const f=fixture();t.after(f.close);
  f.service.confirm({id:'a'},{head:headers,mapping:selected});
  const corrected={...selected,item:-1};
  f.service.confirm({id:'a'},{head:headers,mapping:corrected});
  assert.deepEqual((await f.service.resolve({id:'a'},{head:headers,needs_ai:false})).mapping,corrected);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_mapping_templates WHERE company_id=?').get('a').n,1);
});
test('AI only receives column names and coarse type ratios, without operation data',async t=>{
  const expected={report_type:'operations',mapping:selected,financial:{basis:'cash_receipts',confidence:'high',risk_flags:[]}};
  let calls=0,posted;
  const fetchFn=async(_url,opts)=>{
    calls++;
    assert.equal(opts.method,'POST');
    posted=JSON.parse(opts.body);
    return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(expected)}]}]})};
  };
  const f=fixture({apiKey:'test-only',fetchFn});t.after(f.close);
  const input={head:headers,profiles:profile(),needs_ai:true};
  const result=await f.service.resolve({id:'a'},input);
  assert.equal(result.source,'ai');
  assert.deepEqual(result.mapping,selected);
  assert.deepEqual(result.financial,{basis:'cash_receipts',confidence:'high',risk_flags:[]});
  assert.equal(calls,1);
  assert.equal(posted.store,false);
  assert.equal(posted.text.format.type,'json_schema');
  assert.deepEqual(JSON.parse(posted.input).columns.map(c=>c.index),[0,1,2,3,4]);
  assert.ok(!posted.input.includes('Пациент Петров'));
  assert.ok(!posted.input.includes('500000'));
  assert.ok(!posted.input.includes('receipt-'));
  const awaiting=await f.service.resolve({id:'a'},{head:[...headers,'Код'],profiles:profile([...headers,'Код']),needs_ai:true});
  assert.equal(awaiting.source,'heuristic');
  assert.equal(awaiting.reason,'limit');
  assert.equal(calls,1);
  // A second company is independent; no cross-company request throttling.
  const other=await f.service.resolve({id:'b'},input);
  assert.equal(other.source,'ai');
  assert.equal(calls,2);
});
test('Malformed or uncertain AI outputs cannot silently select financial columns',async t=>{
  const fetchFn=async()=>({ok:true,json:async()=>({
    status:'completed',
    output:[{type:'message',content:[{type:'output_text',
      text:JSON.stringify({report_type:'operations',mapping:{date:0,id:1,item:2,amount:0,status:4},financial:{basis:'cash_receipts',confidence:'high',risk_flags:[]}})}]}]
  })});
  const f=fixture({apiKey:'test-only',fetchFn});t.after(f.close);
  const result=await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  assert.equal(result.source,'heuristic');
  assert.equal(result.mapping,null);
});
test('Unavailable or unknown-report AI gracefully falls back to manual selection',async t=>{
  const f=fixture({apiKey:'test-only',fetchFn:async()=>({ok:false,status:503})});t.after(f.close);
  const result=await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  assert.equal(result.source,'heuristic');
  assert.equal(result.mapping,null);
});
test('Template store is bounded by company, at most 30 signatures',t=>{
  const f=fixture({now:(()=>{let time=0;return()=>++time;})()});t.after(f.close);
  for(let i=0;i<34;i++){
    const h=[...headers,'Extra-'+i];
    f.service.confirm({id:'a'},{head:h,mapping:selected});
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM import_mapping_templates WHERE company_id=?').get('a').n,30);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM import_mapping_templates WHERE company_id=?').get('b').n,0);
});

test('Financial semantic classification and risk flags are returned with a valid AI suggestion',async t=>{
  const financial={basis:'cash_receipts',confidence:'high',risk_flags:['partial_payments','refunds']};
  const fetchFn=async(_url,opts)=>{
    const payload=JSON.parse(opts.body);
    assert.ok(payload.instructions.includes('АВАНС'));
    assert.ok(payload.instructions.includes('КАССОВОЕ ПОСТУПЛЕНИЕ'));
    assert.ok(payload.instructions.includes('частичные платежи'));
    assert.equal(payload.store,false);
    return {ok:true,json:async()=>({status:'completed',output:[{
      type:'message',content:[{type:'output_text',text:JSON.stringify({
        report_type:'operations',mapping:selected,financial
      })}]
    }]})};
  };
  const f=fixture({apiKey:'test-only',fetchFn});t.after(f.close);
  const result=await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  assert.equal(result.source,'ai');
  assert.deepEqual(result.financial,financial);
});
test('The AI cannot launder accrued amounts into cash receipts',async t=>{
  const hdr=['Дата закрытия','Код реализации','Номенклатура','Начислено по прайсу','Вид движения'];
  const paymentProfile=profile();
  const fetchFn=async()=>({ok:true,json:async()=>({status:'completed',output:[{
    type:'message',content:[{type:'output_text',text:JSON.stringify({
      report_type:'operations',mapping:selected,
      financial:{basis:'cash_receipts',confidence:'high',risk_flags:[]}
    })}]
  }]})});
  const f=fixture({apiKey:'test-only',fetchFn});t.after(f.close);
  const result=await f.service.resolve({id:'a'},{head:hdr,profiles:paymentProfile,needs_ai:true});
  assert.equal(result.source,'heuristic');
  assert.equal(result.mapping,null);
});
test('Model returning unknown report type or malformed financial risk must not auto-map',async t=>{
  const fetchFn=async()=>({ok:true,json:async()=>({status:'completed',output:[{
    type:'message',content:[{type:'output_text',text:JSON.stringify({
      report_type:'unknown',mapping:selected,
      financial:{basis:'unknown',confidence:'low',risk_flags:['unvalidated_tag']}
    })}]
  }]})});
  const f=fixture({apiKey:'test-only',fetchFn});t.after(f.close);
  const result=await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  assert.equal(result.source,'heuristic');
});

test('Confirmed financial caveats survive cached-template retrieval for the same company',async t=>{
  const f=fixture();t.after(f.close);
  const caveat={basis:'mixed',confidence:'medium',risk_flags:['prepayments','partial_payments','double_counting']};
  f.service.confirm({id:'a'},{head:headers,mapping:selected,financial:caveat});
  const remembered=await f.service.resolve({id:'a'},{head:headers,needs_ai:false});
  assert.equal(remembered.source,'template');
  assert.deepEqual(remembered.mapping,selected);
  assert.deepEqual(remembered.financial,caveat);
  const other=await f.service.resolve({id:'b'},{head:headers,needs_ai:false});
  assert.equal(other.financial,undefined);
  assert.throws(()=>f.service.confirm({id:'a'},{
    head:headers,mapping:selected,
    financial:{basis:'cash_receipts',confidence:'high',risk_flags:['malicious_label']}
  }),/финансовая оценка/);
});
test('Old templates without financial metadata still load normally',async t=>{
  const f=fixture();t.after(f.close);
  f.service.confirm({id:'a'},{head:headers,mapping:selected});
  const restored=await f.service.resolve({id:'a'},{head:headers,needs_ai:false});
  assert.equal(restored.source,'template');
  assert.deepEqual(restored.mapping,selected);
  assert.equal(restored.financial,undefined);
});


test('An AI field proposal survives reopening the same Excel during cooldown, without becoming confirmed',async t=>{
  let calls=0;
  const response={report_type:'operations',mapping:selected,financial:{
    basis:'cash_receipts',confidence:'medium',risk_flags:['partial_payments']
  }};
  const fetchFn=async()=>{
    calls++;
    return {ok:true,json:async()=>({status:'completed',output:[
      {type:'message',content:[{type:'output_text',text:JSON.stringify(response)}]}
    ]})};
  };
  const f=fixture({apiKey:'test-only',fetchFn,now:()=>3000});t.after(f.close);
  const a={id:'a'},b={id:'b'},opts={head:headers,profiles:profile(),needs_ai:true};
  const initial=await f.service.resolve(a,opts);
  assert.equal(initial.source,'ai');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_mapping_templates').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_mapping_suggestions').get().n,1);
  const reopened=await f.service.resolve(a,opts);
  assert.equal(reopened.source,'suggestion');
  assert.deepEqual(reopened.mapping,selected);
  assert.deepEqual(reopened.financial,response.financial);
  assert.equal(calls,1,'Reopening must not incur a second OpenAI request');
  assert.equal((await f.service.resolve(b,{...opts,needs_ai:false})).source,'heuristic');
  f.service.confirm(a,{head:headers,mapping:selected,financial:response.financial});
  assert.equal((await f.service.resolve(a,opts)).source,'template');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_mapping_suggestions').get().n,0);
});

test('A saved draft remains available across mapper instances/server restart',async t=>{
  let calls=0;
  const f=fixture({
    apiKey:'test-only',
    fetchFn:async()=>{
      calls++;
      return {ok:true,json:async()=>({status:'completed',output:[{
        type:'message',content:[{type:'output_text',text:JSON.stringify({
          report_type:'operations',mapping:selected,
          financial:{basis:'cash_receipts',confidence:'high',risk_flags:[]}
        })}]
      }]})};
    }
  });t.after(f.close);
  await f.service.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  const fresh=createImportMapper({db:f.db,apiKey:'test-only',fetchFn:()=>{throw Error('Should never call AI')}});
  const again=await fresh.resolve({id:'a'},{head:headers,profiles:profile(),needs_ai:true});
  assert.equal(again.source,'suggestion');
  assert.deepEqual(again.mapping,selected);
  assert.equal(calls,1);
});

test('Failed AI analysis allows one explicit retry without spending on endless polling',async t=>{
  let calls=0;
  const f=fixture({
    apiKey:'test-only',
    fetchFn:async()=>{
      calls++;
      if(calls===1)throw Error('Temporary AI timeout');
      return {ok:true,json:async()=>({status:'completed',output:[{
        type:'message',content:[{type:'output_text',text:JSON.stringify({
          report_type:'operations',mapping:selected,
          financial:{basis:'cash_receipts',confidence:'medium',risk_flags:[]}
        })}]
      }]})};
    },
    now:()=>4000
  });t.after(f.close);
  const opts={head:headers,profiles:profile(),needs_ai:true},c={id:'a'};
  const failed=await f.service.resolve(c,opts);
  assert.equal(failed.source,'heuristic');
  assert.equal(failed.reason,'unavailable');
  assert.equal(failed.can_retry,true);
  const throttled=await f.service.resolve(c,opts);
  assert.equal(throttled.source,'heuristic');
  assert.equal(throttled.reason,'limit');
  assert.equal(throttled.can_retry,true);
  const retried=await f.service.resolve(c,{...opts,retry:true});
  assert.equal(retried.source,'ai');
  assert.equal(calls,2);
  const subsequent=await f.service.resolve(c,opts);
  assert.equal(subsequent.source,'suggestion');
  assert.equal(calls,2);
});

test('At most two AI attempts per company within a cooldown window',async t=>{
  let calls=0;
  const f=fixture({apiKey:'test-only',now:()=>5000,fetchFn:async()=>{calls++;throw Error('AI down')}});
  t.after(f.close);
  const opts={head:headers,profiles:profile(),needs_ai:true},c={id:'a'};
  await f.service.resolve(c,opts);
  await f.service.resolve(c,{...opts,retry:true});
  const third=await f.service.resolve(c,{...opts,retry:true});
  assert.equal(calls,2);
  assert.equal(third.reason,'limit');
  assert.equal(third.can_retry,false);
});

test('An optional item quantity column is company-scoped, remembered and never overlaps money',async t=>{
  const f=fixture();t.after(f.close);
  const cols=[...headers,'Количество'];
  const selectedWithQuantity={...selected,quantity:5};
  assert.deepEqual(validateMapping(cols,selectedWithQuantity),selectedWithQuantity);
  assert.throws(()=>validateMapping(cols,{...selectedWithQuantity,quantity:3}),/один столбец|Количество/);
  f.service.confirm({id:'a'},{head:cols,mapping:selectedWithQuantity});
  const saved=await f.service.resolve({id:'a'},{head:cols,needs_ai:false});
  assert.equal(saved.source,'template');
  assert.deepEqual(saved.mapping,selectedWithQuantity);
  const other=await f.service.resolve({id:'b'},{head:cols,needs_ai:false});
  assert.equal(other.mapping,null);
});
