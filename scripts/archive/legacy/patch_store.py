import re

def replace_block(pattern, replacement, text):
    return re.sub(pattern, replacement, text, flags=re.DOTALL)

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

# 1. addCustomer
add_customer_old = """    try {
      await supabase.from('customers').insert([{
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        tax_id: customer.taxId || null
      }]);
    } catch (error) {
      console.error('Error adding customer to Supabase:', error);
    }"""
add_customer_new = """    get().addSyncTask({
      action: 'INSERT',
      table: 'customers',
      data: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        tax_id: customer.taxId || null
      }
    });"""
content = content.replace(add_customer_old, add_customer_new)

# 2. openSession
open_session_old = """    try {
      await supabase.from('cash_sessions').insert([{
        id: session.id,
        branch_id: session.branchId,
        opened_at: session.openedAt,
        opening_balance: session.openingBalance,
        expected_balance: session.expectedBalance || null,
        status: session.status,
        user_id: session.userId
      }]);
    } catch (error) {
      console.error('Error adding session to Supabase:', error);
    }"""
open_session_new = """    get().addSyncTask({
      action: 'INSERT',
      table: 'cash_sessions',
      data: {
        id: session.id,
        branch_id: session.branchId,
        opened_at: session.openedAt,
        opening_balance: session.openingBalance,
        expected_balance: session.expectedBalance || null,
        status: session.status,
        user_id: session.userId
      }
    });"""
content = content.replace(open_session_old, open_session_new)

# 3. closeSession
close_session_old = """    try {
      await supabase.from('cash_sessions').update({
        closed_at: new Date().toISOString(),
        status: 'closed',
      }).eq('id', sessionId);
    } catch (error) {
      console.error('Error updating session in Supabase:', error);
    }"""
close_session_new = """    get().addSyncTask({
      action: 'UPDATE',
      table: 'cash_sessions',
      data: {
        id: sessionId, // Special case: we will need to handle how UPDATE tasks know what to update. Let's just pass id in data.
        closed_at: new Date().toISOString(),
        status: 'closed'
      }
    });"""
content = content.replace(close_session_old, close_session_new)

# 4. addCashMovement
add_cash_movement_old = """    try {
      await supabase.from('cash_movements').insert([{
        id: movement.id,
        session_id: sessionId,
        type: movement.type,
        amount: movement.amount,
        currency_code: movement.currencyCode,
        description: movement.description,
        date: movement.date
      }]);
    } catch (error) {
      console.error('Error adding cash movement to Supabase:', error);
    }"""
add_cash_movement_new = """    get().addSyncTask({
      action: 'INSERT',
      table: 'cash_movements',
      data: {
        id: movement.id,
        session_id: sessionId,
        type: movement.type,
        amount: movement.amount,
        currency_code: movement.currencyCode,
        description: movement.description,
        date: movement.date
      }
    });"""
content = content.replace(add_cash_movement_old, add_cash_movement_new)

with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
