import type { Transaction } from '../../types';

function salePayload(tx:Transaction,companyId:string,authUserId:string){
  return {
    p_sale_id:tx.id,p_company_id:companyId,p_warehouse_id:tx.branchId,p_cash_session_id:tx.sessionId||null,p_user_id:tx.userId||authUserId,
    p_total:Number(tx.total)||0,p_currency_code:null,p_notes:tx.notes||'',p_customer_id:tx.customerId||null,
    p_items:(tx.items||[]).map(item=>({id:item.id,product_id:typeof item.product==='string'?item.product:item.product?.id,quantity:Number(item.quantity)||0,price:Number(item.price)||0,total:Number(item.total)||((Number(item.price)||0)*(Number(item.quantity)||0)),variant_label:item.variantLabel||null,variant_id:null,serial_number:item.serialNumber||null,discount:0,tax:0})),
    p_payments:(tx.payments||[]).map((p:any)=>({id:crypto.randomUUID(),method:p.method||'cash',currency_code:p.currencyCode||null,amount:Number(p.amount)||0,exchange_rate:Number(p.exchangeRate)||1}))
  };
}
export { salePayload };
