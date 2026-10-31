// Conservative, deterministic classification of money columns on the server.
// Never infer "paid and fulfilled" from industry alone. Ambiguous money stays
// in an unverified ledger until the source contains decisive evidence.
export function inferImportedBasis(headers,amountIndex) {
  if(!Array.isArray(headers)||headers.length<1||headers.length>80||
     headers.some(h=>typeof h!=='string'||h.length>180)||
     !Number.isInteger(amountIndex)||amountIndex<0||amountIndex>=headers.length)
    return {basis:'unverified',reason:'Не удалось надёжно определить назначение денежного столбца.'};
  const text=headers[amountIndex].toLocaleLowerCase('ru').replace(/\s+/g,' ').trim();
  const all=headers.join(' ').toLocaleLowerCase('ru');
  const completedServices=headers.some(h=>/^дата\s+оказания(?:\s+услуг[и]?)?$/i.test(h.trim())) &&
    headers.some(h=>/^(?:наименование\s+)?услуг[аи]$/i.test(h.trim()));
  if(/ндс|налог|цена за|тариф|количест|себестоим|скидк|остаток|долг|задолж|дебитор|к оплате|выставлен|начислен|прайс|unit price|quantity|outstanding/i.test(text))
    return {basis:'unverified',reason:'Этот столбец может отражать начисление, долг, цену единицы или налог.'};
  if(/аванс|предоплат|депозит|задаток/i.test(text))
    return {basis:'cash_receipts',reason:'Столбец прямо обозначает полученные авансы.'};
  const paid=/сумма.{0,20}оплат|сумма.{0,12}поступ|оплачено|получен.{0,15}ден|фактически.{0,15}оплач|по факту оплат|поступлен.{0,15}ден|эквайринг|кассов.{0,15}поступ|paid amount|amount paid|cash received|payment received/i.test(text);
  const earned=/стоимость.{0,25}(оказан|выполн|реализован|продан)|сумма.{0,25}(оказан|выполн|реализован|продан)|выручка от оказан|выполнен.{0,15}работ|оказан.{0,15}услуг|продано.{0,15}на сумму|recognized revenue|fulfilled sale/i.test(text);
  const ambiguity=/аванс|предоплат|задолж|дебитор|частичн.{0,12}оплат|отложен.{0,15}оплат|сч[её]т к оплате/i.test(all);
  if(paid&&!earned) return {basis:'cash_receipts',reason:'В названии столбца указаны фактически полученные деньги.'};
  if((earned||(completedServices&&/^(?:стоимость|сумма)(?:\s+(?:услуг|услуги|строки))?$/i.test(text)))&&!paid&&!ambiguity)return {basis:'recognized_revenue',reason:'Заголовки отчёта указывают на выполненные продажи или оказанные услуги.'};
  return {basis:'unverified',reason:'По структуре выгрузки нельзя уверенно отличить оплаты от оказанных услуг или продаж.'};
}
