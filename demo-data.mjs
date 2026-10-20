import { calculateFinancialSummary } from './api/finance-summary.mjs';

// Demo and personal workspaces use the same financial arithmetic.
export function demoSummary(dataset,industry,end,basis=null){
  const rows=dataset.rows.map(row=>({
    sold_on:row.date,source_id:row.id,item:row.item,status:row.status,
    amount_kopecks:Math.round(row.amount*100),quantity_milli:row.quantity_milli??null,
    financial_basis:row.financial_basis||'unverified'
  }));
  const counts={};for(const row of rows)counts[row.financial_basis]=(counts[row.financial_basis]||0)+1;
  return calculateFinancialSummary(rows,counts,end,basis,industry);
}

export function withDemoBooks(rows){
  return rows.flatMap((row,i)=>{
    const quantity_milli=row.quantity_milli||1000;
    const done={...row,quantity_milli,financial_basis:'recognized_revenue'};
    // Cash is a separate synthetic stream: partial payments and advances do
    // not imply an outstanding customer debt or an additional completed sale.
    const paid={...row,id:'P-'+row.id,amount:Math.round(row.amount*(i%11===0?0.6:i%17===0?1.2:1)),quantity_milli,financial_basis:'cash_receipts'};
    return [done,paid];
  });
}
