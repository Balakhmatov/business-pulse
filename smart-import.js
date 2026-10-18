/* Business Pulse: deterministic import detection. No file data leaves the browser. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BP_SmartImport=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const KEYS=['date','id','item','amount','status'];
  const WORDS={
    date:[/\bdate\b|\btime\b|^day$/i,/дата|день|время|создан|закрыт|проведен|проведён|день операц|период/i],
    id:[/\breceipt\b|\border.?id\b|\btransaction.?id\b|\bdocument.?id\b|\bvisit.?id\b/i,/номер.{0,12}(чека|визита|заказа|документа|продаж)|\bчек\b|чека|визит|заказ|идентификатор|код реализац|номер операц|номер документа|регистратор|документ основание/i],
    item:[/\bproduct\b|\bitem\b|\bservice\b|\bdescription\b|\bname\b/i,/номенклатур|товар|услуг|наименован|позици|предмет|описан|продукт/i],
    amount:[/\bamount\b|\brevenue\b|\bturnover\b|\btotal\b|\bpaid\b|\bsum\b/i,/выручк|оплачен|оплат[аеыу]|сумм|оборот|стоимост|стоимость|к оплате|получено|сумма расч[её]та|итого рублей|сумма реализации/i],
    status:[/\bstatus\b|\btype\b|\boperation\b|\bmovement\b/i,/статус|возврат|вид движен|вид операц|тип операц|назначени|признак расч[её]та/i]
  };
  const badAmount=/\b(quantity|count|qty|discount|percent|vat|tax)\b|колич|кол-во|шт\b|ндс|налог|скидк|процент|себестоим|маржин|цена.{0,15}(за штуку|единиц)/i;
  const badId=/товар|услуг|артикул|склад|поставщик|сотрудник|менеджер|клиент|пациент|инвентар/i;
  const summary=/\b(summary|subtotal|grouped|aggregat|overall)\b|сводн|агрегир|группиров|по дням|по неделям|по месяцам|по филиалам|по подразделениям|по врачам|динамика выручки/i;
  const total=/^(итого|всего|общая сумма|общий итог|total|subtotal)(?:\b|\s|:|$)/i;
  function norm(x){return String(x??'').replace(/\s+/g,' ').trim();}
  function blank(row){return row.every(x=>!norm(x));}
  function numberLike(x){
    const s=norm(x).replace(/[\s\u00a0\u202f₽]/g,'');
    if(!s||!/^[-+]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?$/.test(s))return false;
    if(/^0\d{2,}$/.test(s))return false; // potential receipt number with leading zeroes
    return Number.isFinite(Number(s.replace(',','.').replace(/\.(?=\d{3}(?:\.|,|$))/g,'')));
  }
  function dateLike(x){
    if(x instanceof Date)return !isNaN(x.getTime());
    const s=norm(x);
    if(!s)return false;
    const m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/) || s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T].*)?$/);
    if(!m)return false;
    const [y,mo,d]=m[1].length===4?[+m[1],+m[2],+m[3]]:[+m[3],+m[2],+m[1]];
    return y>=2000&&y<=2100&&mo>=1&&mo<=12&&d>=1&&d<=new Date(Date.UTC(y,mo,0)).getUTCDate();
  }
  function statusLike(x){return /^(оплата|оплачено|продажа|реализация|возврат|refund|sale|paid|return|сторно|отмена|cancel|приход|расход)$/i.test(norm(x));}
  function fieldHeader(x,key){
    const s=norm(x).toLowerCase();
    if(!s)return 0;
    let score=WORDS[key].some(r=>r.test(s))?7:0;
    if(key==='amount'&&badAmount.test(s))score=0;
    if(key==='amount'&&/^(цена|price|тариф)$/.test(s))score=1;
    if(key==='id'&&badId.test(s))score=0;
    if(key==='item'&&/код.{0,12}(товар|услуг)|артикул|sku/i.test(s))score=0;
    if(key==='date'&&/дата.{0,15}(рождени|поставк|регистрац|доставк)/i.test(s))score=1;
    if(key==='amount'&&/фактически оплачено|оплачено|сумма оплат|сумма платеж|поступило|paid|payment/i.test(s))score+=4;
    if(key==='amount'&&/выручк|revenue/i.test(s))score+=3;
    if(key==='amount'&&/\bитого\b|сумма к оплате/i.test(s))score+=1;
    return score;
  }
  function profiles(head,rows){
    const sample=rows.filter(r=>!blank(r)).slice(0,40);
    return head.map((label,i)=>{
      const v=sample.map(row=>norm(row[i])).filter(Boolean);
      const n=v.length||1;
      const dates=v.filter(dateLike).length/n;
      const nums=v.filter(numberLike).length/n;
      const statuses=v.filter(statusLike).length/n;
      const unique=new Set(v).size/n;
      const words=v.filter(x=>!dateLike(x)&&!numberLike(x)&&/[a-zа-я]/i.test(x)).length/n;
      const zeroids=v.filter(x=>/^0\d+$/.test(x)).length/n;
      return {label,dates,nums,statuses,unique,words,zeroids,filled:v.length/(sample.length||1)};
    });
  }
  function score(p,key){
    const h=fieldHeader(p.label,key);
    if(key==='date')return h*3+p.dates*14-p.nums*2;
    if(key==='amount'){
      if(badAmount.test(p.label)||/^(цена|price|тариф)$/i.test(norm(p.label)))return -20;
      return h*3+p.nums*10+(p.nums>.8&&p.zeroids===0?2:0)-p.dates*12-p.statuses*12;
    }
    if(key==='id')return h*3+(p.filled>.8&&p.unique>.65?6:0)+(p.zeroids>.2?6:0)-p.dates*13-p.statuses*8-(/код.{0,8}(товар|услуг)|артикул/i.test(p.label)?15:0);
    if(key==='item')return h*3+p.words*8+(p.unique>.3?2:0)-p.dates*12-p.statuses*8;
    if(key==='status')return h*3+p.statuses*12-p.dates*7;
    return 0;
  }
  function guess(head,rows){
    const ps=profiles(head,rows), candidates=[];
    for(const key of KEYS){
      ps.forEach((p,index)=>candidates.push({key,index,points:score(p,key)}));
    }
    candidates.sort((a,b)=>b.points-a.points);
    const mapping={date:-1,id:-1,item:-1,amount:-1,status:-1};
    const confidence={},claimed=new Set(),ambiguities=[];
    for(const x of candidates){
      if(mapping[x.key]>=0||claimed.has(x.index))continue;
      const cutoff=x.key==='date'||x.key==='amount'?9:x.key==='id'?10:x.key==='item'?8:11;
      if(x.points<cutoff)continue;
      mapping[x.key]=x.index;claimed.add(x.index);
      confidence[x.key]=x.points>=22?'высокая':x.points>=16?'средняя':'требует проверки';
    }
    // Equal plausible date/receipt/payment columns require a human selection.
    // The first equally-named numeric column must never silently become revenue.
    for(const key of ['date','id','amount']){
      const selected=mapping[key];
      if(selected<0)continue;
      const values=ps.map((p,index)=>({index,points:score(p,key)}))
        .sort((a,b)=>b.points-a.points);
      const best=values.find(v=>v.index===selected);
      const alternate=values.find(v=>v.index!==selected);
      if(best&&alternate&&alternate.points>=10&&best.points-alternate.points<4){
        mapping[key]=-1;
        confidence[key]='неоднозначно';
        ambiguities.push(key==='date'?'Несколько столбцов похожи на дату операции.':
          key==='id'?'Несколько столбцов похожи на номер чека или документа.':
          'Несколько столбцов похожи на сумму выручки. Укажите правильный вручную.');
      }
    }
    return {mapping,confidence,profiles:ps,ambiguities};
  }
  function headerCandidate(matrix,i){
    const h=matrix[i]||[],prev=matrix.slice(Math.max(0,i-4),i);
    const vals=h.map(norm),filled=vals.filter(Boolean),width=filled.length;
    if(width<2||width>300||filled.some(x=>x.length>120))return null;
    if(filled.some(x=>total.test(x)))return null;
    const after=matrix.slice(i+1,Math.min(i+22,matrix.length)).filter(r=>r.filter(x=>norm(x)).length>=2);
    if(!after.length)return null;
    const words=vals.reduce((n,x)=>n+(WORDS.date.some(r=>r.test(x))||WORDS.id.some(r=>r.test(x))||WORDS.item.some(r=>r.test(x))||WORDS.amount.some(r=>r.test(x))||WORDS.status.some(r=>r.test(x))?1:0),0);
    const labels=filled.filter(x=>/[a-zа-я]/i.test(x)&&!dateLike(x)&&!numberLike(x)).length;
    const aligned=after.slice(0,8).reduce((sum,r)=>sum+(r.filter(x=>norm(x)).length>=Math.max(2,Math.min(3,width))?1:0),0);
    const data=after.slice(0,8).some(r=>r.some(dateLike))?3:0;
    const g=guess(vals,after);
    const m=g.mapping;
    let result=words*4+labels*1.2+aligned*1.1+data;
    if(m.date>=0)result+=8;
    if(m.amount>=0)result+=7;
    if(m.id>=0)result+=3;
    if(m.date<0&&m.amount<0)result-=15;
    if(summary.test(filled.join(' ')))result-=9;
    if(prev.some(r=>r.some(x=>summary.test(norm(x)))))result+=1;
    return {i,score:result};
  }
  function detect(matrix,name){
    if(!Array.isArray(matrix)||matrix.length<2)throw Error('В файле нет строк с данными.');
    if(matrix.length>150001)throw Error('Слишком большой файл (больше 150 000 строк).');
    const raw=matrix.map(row=>Array.isArray(row)?row.map(norm):[norm(row)]);
    const width=Math.max(...raw.slice(0,100).map(row=>row.length));
    if(width>300)throw Error('Слишком много столбцов (больше 300).');
    const candidates=[];
    for(let i=0;i<Math.min(60,raw.length-1);i++){
      const c=headerCandidate(raw,i);
      if(c)candidates.push(c);
    }
    candidates.sort((a,b)=>b.score-a.score||a.i-b.i);
    if(!candidates.length||candidates[0].score<8)throw Error('Не удалось найти строку заголовков. Выберите таблицу с датой, операцией и суммой.');
    const header=candidates[0].i,head=raw[header],cols=Math.max(head.length,...raw.slice(header,Math.min(header+50,raw.length)).map(x=>x.length));
    if(cols>300)throw Error('В таблице больше 300 столбцов.');
    const padded=Array.from({length:cols},(_,i)=>head[i]||'');
    const tail=raw.slice(header+1);
    let excluded=0,footer=0;
    const rows=[];
    for(const row of tail){
      if(blank(row)){excluded++;continue;}
      const first=norm(row[0]), second=norm(row[1]);
      if(total.test(first)||(!first&&total.test(second))){footer++;continue;}
      if(padded.filter((x,i)=>x&&x===row[i]).length>=Math.min(3,padded.filter(Boolean).length)&&row.some(x=>fieldHeader(x,'date')>=7)){excluded++;continue;}
      rows.push(Array.from({length:cols},(_,i)=>row[i]||''));
    }
    if(!rows.length)throw Error('Под заголовками не найдены операции.');
    const result=guess(padded,rows);
    const preamble=raw.slice(0,header).flat().join(' ');
    const names=padded.join(' ');
    const id=result.mapping.id,amount=result.mapping.amount,date=result.mapping.date;
    const explicitSummary=summary.test(preamble)||summary.test(name||'')||summary.test(names);
    const summaryColumns=/количеств|средний чек|средн|процент|доля выручки|показател|группиров|всего за период/i.test(names);
    // A daily/monthly totals table with no receipt ID is not a transaction export.
    const aggregate=(explicitSummary||summaryColumns)&&id<0&&amount>=0;
    const warnings=[];
    if(aggregate)warnings.push('Похоже на сводный отчёт. Его нельзя объединять с отдельными продажами: возникнет двойной учёт.');
    warnings.push(...result.ambiguities);
    if(id<0)warnings.push('Не найден надёжный ID чека/визита. В личной компании потребуется выбрать этот столбец вручную.');
    if(date<0||amount<0)warnings.push('Дата или сумма определены неоднозначно — проверьте выбор столбцов.');
    if(footer)warnings.push('Пропущены итоговые строки: '+footer+'.');
    return {
      name:name||'',head:padded,rows,headerRow:header+1,excludedRows:excluded+footer,
      mappingGuess:result.mapping,confidence:result.confidence,
      reportType:aggregate?'aggregate':'operations',warnings,
      hasManyColumns:cols>12
    };
  }
  // Financial semantics are heuristics over labels, not evidence about actual
  // money movement. Never declare accounting profit or recognized revenue here.
  function financialSemantics(head,mapping){
    const amountIndex=Number.isInteger(mapping?.amount)?mapping.amount:-1;
    const amount=norm(amountIndex>=0?head[amountIndex]:'').toLowerCase();
    const normalized=head.map(x=>norm(x).toLowerCase());
    const cues={
      cash:/факт.{0,25}(поступ|оплат)|фактически оплач|поступлен.{0,15}ден|получен.{0,15}ден|сумма.{0,10}оплат|оплачено|денежн.{0,10}поступ|paid amount|amount paid|received payment|cash received|эквайринг/i,
      accrual:/начислен|выставлен|счет к оплате|счёт к оплате|сумма к оплате|стоимость по прайсу|по прайсу|billed|invoiced|accrual|invoice amount/i,
      debt:/задолж|дебитор|сумма долга|остаток долга|неоплачен|receivable|outstanding balance|remaining debt/i,
      advance:/аванс|предоплат|депозит|задаток|prepay|pre.payment|advance payment|deposit/i,
      partial:/частичн.{0,20}опла[тч]|опла[тч].{0,20}частич|неполн.{0,20}опла[тч]|partial payment|installment/i,
      refund:/возврат|refund|сторно|reversal|chargeback/i,
      tax:/ндс|сумма налог|налоговая сумма|сумма vat|vat amount|tax amount/i,
      price:/цена за|тариф|unit price|price per|за единиц|скидка|discount|количест|quantity/i
    };
    let basis='unknown',severity='none';
    const notes=[],flags=[];
    const flag=(code,note,kind='warning')=>{
      if(flags.includes(code))return;
      flags.push(code);notes.push(note);
      if(kind==='blocked')severity='blocked';
      else if(severity!=='blocked')severity='warning';
    };
    if(amount){
      if(cues.advance.test(amount)){
        basis='advance';
        flag('advance_amount','Выбранная сумма обозначает аванс или предоплату: это не автоматически признанная выручка. Выберите детализацию фактических оплат.', 'blocked');
      }else if(cues.debt.test(amount)){
        basis='debt';
        flag('debt_amount','Выбранный столбец отражает задолженность, а не поступление денег.', 'blocked');
      }else if(cues.tax.test(amount)){
        basis='tax';
        flag('tax_amount','Выбран налог или НДС, а не денежная сумма продажи.', 'blocked');
      }else if(cues.price.test(amount)){
        basis='unit_price';
        flag('unit_price_amount','Выбрана цена, скидка или количество, а не сумма операции.', 'blocked');
      }else if(cues.accrual.test(amount)&&!cues.cash.test(amount)){
        basis='accrual';
        flag('accrual_amount','Выбрана начисленная или выставленная сумма, а не подтверждённая оплата. Не добавляем её к денежным поступлениям.', 'blocked');
      }else if(cues.cash.test(amount)){
        basis='cash_receipts';
      }else if(/выручк|revenue|продаж|sales/i.test(amount)){
        basis='reported_revenue';
      }
    }
    if(normalized.some((x,i)=>i!==amountIndex&&cues.advance.test(x))){
      flag('advance_present','Выгрузка содержит поле аванса/предоплаты. Проверьте, исключены ли авансы и повторный зачёт из выбранной суммы.');
    }
    if(normalized.some((x,i)=>i!==amountIndex&&cues.debt.test(x))){
      flag('debt_present','Выгрузка содержит задолженность. Не приравнивайте начисленную сумму к полученным деньгам.');
    }
    if(normalized.some(x=>cues.partial.test(x))){
      flag('partial_present','Есть признаки частичной оплаты или рассрочки: проверьте, что каждая сумма означает отдельное поступление.');
    }
    if(normalized.some(x=>cues.refund.test(x))){
      flag('refund_present','Выгрузка содержит возвраты/сторно: проверьте их статусы и знаки сумм, чтобы не удвоить выручку.');
    }
    if(normalized.some(x=>cues.tax.test(x))){
      flag('tax_present','Есть столбцы НДС/налогов: определите, включает ли денежный показатель налог, прежде чем сравнивать отчёты.');
    }
    return {basis,severity,flags,notes,requiresConfirmation:severity==='warning',blocksImport:severity==='blocked'};
  }
  return {detect,guess,dateLike,numberLike,financialSemantics};
});
