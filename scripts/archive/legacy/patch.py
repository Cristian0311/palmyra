from pathlib import Path
p=Path('/mnt/data/fase14/src/services/supabaseSync/mutations.ts')
s=p.read_text()
# helper: replace exact initial block for selected functions
maps={
'pushCategoryToSupabase':('category','category.id'),
'pushUserToSupabase':('user','user.id'),
'pushIDNSettlementPriceToSupabase':('idn_settlement_price','price.id'),
'pushWarrantyToSupabase':('warranty','warranty.id'),
'pushCurrencyToSupabase':('currency','currency.code'),
'pushReturnToSupabase':('return','returnItem.id'),
'pushTimeShiftToSupabase':('time_shift','shift.id'),
'pushQuoteToSupabase':('quote','quote.id'),
'pushBankTransactionToSupabase':('bank_transaction','tx.id'),
'pushBankCardToSupabase':('bank_card','card.id'),
'pushSupplierToSupabase':('supplier','supplier.id'),
'pushSupplierOrderToSupabase':('supplier_order','order.id'),
'pushInventoryAuditToSupabase':('inventory_audit','audit.id'),
'pushSalarySettlementToSupabase':('salary_settlement','settlement.id'),
}
import re
for fn,(typ,key) in maps.items():
    pat=re.compile(rf'(export async function {fn}\([^)]*\)\s*\{{\n)(  const supabase = getSupabase\(\);\n  if \(!supabase\) return;)',re.M)
    repl=rf'\1  if (typeof navigator !== \'undefined\' && !navigator.onLine) {{\n    enqueueOfflineItem(\'{typ}\', {key.split(".")[0]}, {key});\n    return;\n  }}\n  const supabase = getSupabase();\n  if (!supabase) {{\n    enqueueOfflineItem(\'{typ}\', {key.split(".")[0]}, {key});\n    return;\n  }}'
    ns,n=pat.subn(repl,s,count=1)
    if n!=1:
        print('NO MATCH',fn)
    s=ns
# For functions whose catch only warns, enqueue on error if not already
for fn,(typ,key) in maps.items():
    start=s.find(f'export async function {fn}')
    if start<0: continue
    end=s.find('\nexport async function ', start+10)
    if end<0: end=len(s)
    block=s[start:end]
    if 'enqueueOfflineItem' not in block.split('catch')[1] if 'catch' in block else False:
        # add to final catch only
        idx=block.rfind('} catch (e) {')
        if idx>=0:
            insert=block.find('\n',idx)+1
            obj=key.split('.')[0]
            block=block[:insert]+f"    enqueueOfflineItem('{typ}', {obj}, {key});\n"+block[insert:]
            s=s[:start]+block+s[end:]
p.write_text(s)

p=Path('/mnt/data/fase14/src/services/offlineSync.ts')
s=p.read_text()
s=s.replace("  | 'customer' | 'customer_delete' | 'return' | 'bank_transaction'\n  | 'branch' | 'product' | 'category' | 'receipt_config' | 'store_config' | 'catalog_config' | 'salary_settlement';", "  | 'customer' | 'customer_delete' | 'return' | 'bank_transaction'\n  | 'branch' | 'product' | 'category' | 'receipt_config' | 'store_config' | 'catalog_config' | 'salary_settlement'\n  | 'user' | 'currency' | 'idn_settlement_price' | 'warranty' | 'time_shift' | 'quote'\n  | 'bank_card' | 'supplier' | 'supplier_order' | 'inventory_audit';")
marker="    case 'transaction': {"
insert="""    case 'user': {
      const u = data;
      const email = u.email && String(u.email).trim() ? u.email : `${String(u.name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '')}_${String(u.id).slice(0, 6)}@system.local`;
      const { error } = await supabase.from('users').upsert({ id:u.id, name:u.name, email, password:u.password || null, role:u.role || 'employee', base_salary:u.baseSalary || 0, sales_goal:u.salesGoal || 0, branch_id:u.branchId || null, allowed_branches:u.allowedBranches || [], permissions:u.permissions || [], is_active:u.isActive !== false, is_independent:u.isIndependent === true, assigned_branch_id:u.assignedBranchId || u.branchId || null });
      if (error) throw error; return true;
    }
    case 'currency': { const c=data; const {error}=await supabase.from('currencies').upsert({code:c.code,name:c.name,symbol:c.symbol,rate_to_base:c.rateToBase,is_base:c.isBase},{onConflict:'code'}); if(error) throw error; return true; }
    case 'idn_settlement_price': { const d=data; const {error}=await supabase.from('idn_settlement_prices').upsert({id:d.id,user_id:d.userId,product_id:d.productId,settlement_price:d.settlementPrice}); if(error) throw error; return true; }
    case 'warranty': { const d=data; const {error}=await supabase.from('warranties').upsert({id:d.id,product_id:d.productId,product_name:d.productName,transaction_id:d.transactionId,customer_id:d.customerId,customer_name:d.customerName,purchase_date:d.purchaseDate,expiry_date:d.expiryDate,serial_number:d.serialNumber,status:d.status}); if(error) throw error; return true; }
    case 'time_shift': { const d=data; const {error}=await supabase.from('time_shifts').upsert({id:d.id,user_id:d.userId,clock_in:d.clockIn,clock_out:d.clockOut,notes:d.notes}); if(error) throw error; return true; }
    case 'quote': { const d=data; const {error}=await supabase.from('quotes').upsert({id:d.id,branch_id:d.branchId,user_id:d.userId,customer_id:d.customerId,date:d.date,subtotal:d.subtotal,tax:d.tax,total:d.total,items:d.items||[],status:d.status,notes:d.notes}); if(error) throw error; return true; }
    case 'bank_card': { const d=data; const {error}=await supabase.from('bank_cards').upsert({id:d.id,name:d.name||d.bankName||'Tarjeta Bancaria',bank:d.bank||d.bankName||'Banco',bank_name:d.bankName||d.bank||'Banco',card_holder:d.cardHolder||'Titular',account_number:d.accountNumber||d.lastFourDigits||d.lastFour||'',phone:d.phone||'',last_four_digits:d.lastFourDigits||d.lastFour||(d.accountNumber?String(d.accountNumber).slice(-4):'0000'),balance:d.balance||0,currency:d.currency||'CUP',color:d.color||'from-indigo-600 to-purple-800',is_active:d.isActive!==false}); if(error) throw error; return true; }
    case 'supplier': { const d=data; const {error}=await supabase.from('suppliers').upsert({id:d.id,name:d.name,phone:d.phone||'',address:d.address||'',email:d.email||'',rating:d.rating||5,type_of_merchandise:d.typeOfMerchandise||''}); if(error) throw error; return true; }
    case 'supplier_order': { const d=data; const {error}=await supabase.from('supplier_orders').upsert({id:d.id,supplier_id:d.supplierId,date:d.date,expected_delivery_date:d.expectedDeliveryDate,items:d.items||[],total:d.total,status:d.status,branch_id:d.branchId,transport_details:d.transportDetails,transport_cost:d.transportCost}); if(error) throw error; return true; }
    case 'inventory_audit': { const d=data; const {error}=await supabase.from('inventory_audits').upsert({id:d.id,date:d.date,branch_id:d.branchId,user_id:d.userId,status:d.status,items:d.items||[],notes:d.notes}); if(error) throw error; return true; }
"""
s=s.replace(marker,insert+marker)
p.write_text(s)
