import re

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

old_block = """    try {
      // Parallelize all sync operations for speed and reliable saving
      const syncPromises = [];

      // 1. Transaction
      syncPromises.push(supabase.from('transactions').insert([{
        id: newTransaction.id,
        branch_id: newTransaction.branchId,
        user_id: newTransaction.userId,
        date: newTransaction.date,
        subtotal: newTransaction.subtotal,
        tax: newTransaction.tax,
        total: newTransaction.total,
        status: newTransaction.status,
        customer_id: newTransaction.customerId || null,
        ncf: newTransaction.ncf || null,
        ncf_type: newTransaction.ncfType || null,
        change_given: newTransaction.changeGiven || 0
      }]));

      // 2. Payments
      if (newTransaction.payments && newTransaction.payments.length > 0) {
        syncPromises.push(supabase.from('transaction_payments').insert(
          newTransaction.payments.map((p: any) => ({
            id: crypto.randomUUID(),
            transaction_id: newTransaction.id,
            currency_code: p.currencyCode,
            amount: p.amount,
            exchange_rate: p.exchangeRate,
            method: p.method,
            bank_card_id: p.bankCardId || null
          }))
        ));
      }

      // 3. Items
      if (newTransaction.items && newTransaction.items.length > 0) {
        syncPromises.push(supabase.from('transaction_items').insert(
          newTransaction.items.map((i: any) => ({
            id: crypto.randomUUID(),
            transaction_id: newTransaction.id,
            cart_item_id: i.id,
            product_id: i.product.id,
            quantity: i.quantity,
            price: i.product.price || 0,
            cost: i.product.costPrice || 0,
            tax: 0,
            serial_number: i.serialNumber || null,
            warranty_code: i.warrantyCode || null,
            selected_size: i.selectedSize || null,
            selected_color: i.selectedColor || null,
            variant_label: i.variantLabel || null
          }))
        ));
      }

      // 4. Inventory (Upsert)
      const modifiedInventory = updatedInventory.filter(ui => 
        transaction.items.some(ti => ti.product.id === ui.productId && (ti.variantLabel || '') === (ui.variantLabel || ''))
        || transaction.items.some(ti => ti.product.isKit && ti.product.kitComponents?.some(kc => kc.productId === ui.productId))
      );
      if (modifiedInventory.length > 0) {
        syncPromises.push(supabase.from('inventory_levels').upsert(
          modifiedInventory.map(i => ({
            id: crypto.randomUUID(),
            product_id: i.productId,
            branch_id: i.branchId,
            variant_label: i.variantLabel || null,
            quantity: i.quantity,
            min_quantity: i.minQuantity
          })), 
          { onConflict: 'product_id, branch_id, variant_label' }
        ));
      }

      // 5. Warranties
      if (newWarranties.length > 0) {
        syncPromises.push(supabase.from('warranties').insert(
          newWarranties.map(w => ({
            id: w.id,
            product_id: w.productId,
            product_name: w.productName,
            transaction_id: w.transactionId,
            customer_id: w.customerId || null,
            customer_name: w.customerName || null,
            purchase_date: w.purchaseDate,
            expiry_date: w.expiryDate,
            serial_number: w.serialNumber || null,
            status: w.status
          }))
        ));
      }

      const results = await Promise.all(syncPromises);
      const errors = results.filter(r => r.error);
      if (errors.length > 0) {
        console.error('Some transaction sync components failed:', errors.map(e => e.error));
      }
    } catch (error) {
      console.error('Error syncing transaction to Supabase:', error);
    }"""

new_block = """    // Queue all changes instead of direct Supabase calls
    // 1. Transaction
    get().addSyncTask({
      action: 'INSERT',
      table: 'transactions',
      data: [{
        id: newTransaction.id,
        branch_id: newTransaction.branchId,
        user_id: newTransaction.userId,
        date: newTransaction.date,
        subtotal: newTransaction.subtotal,
        tax: newTransaction.tax,
        total: newTransaction.total,
        status: newTransaction.status,
        customer_id: newTransaction.customerId || null,
        ncf: newTransaction.ncf || null,
        ncf_type: newTransaction.ncfType || null,
        change_given: newTransaction.changeGiven || 0
      }]
    });

    // 2. Payments
    if (newTransaction.payments && newTransaction.payments.length > 0) {
      get().addSyncTask({
        action: 'INSERT',
        table: 'transaction_payments',
        data: newTransaction.payments.map((p: any) => ({
          id: crypto.randomUUID(),
          transaction_id: newTransaction.id,
          currency_code: p.currencyCode,
          amount: p.amount,
          exchange_rate: p.exchangeRate,
          method: p.method,
          bank_card_id: p.bankCardId || null
        }))
      });
    }

    // 3. Items
    if (newTransaction.items && newTransaction.items.length > 0) {
      get().addSyncTask({
        action: 'INSERT',
        table: 'transaction_items',
        data: newTransaction.items.map((i: any) => ({
          id: crypto.randomUUID(),
          transaction_id: newTransaction.id,
          cart_item_id: i.id,
          product_id: i.product.id,
          quantity: i.quantity,
          price: i.product.price || 0,
          cost: i.product.costPrice || 0,
          tax: 0,
          serial_number: i.serialNumber || null,
          warranty_code: i.warrantyCode || null,
          selected_size: i.selectedSize || null,
          selected_color: i.selectedColor || null,
          variant_label: i.variantLabel || null
        }))
      });
    }

    // 4. Inventory (Upsert -> Note: we use RPC or UPDATE for upsert, but we can encode upsert in data)
    const modifiedInventory = updatedInventory.filter(ui => 
      transaction.items.some(ti => ti.product.id === ui.productId && (ti.variantLabel || '') === (ui.variantLabel || ''))
      || transaction.items.some(ti => ti.product.isKit && ti.product.kitComponents?.some(kc => kc.productId === ui.productId))
    );
    if (modifiedInventory.length > 0) {
      get().addSyncTask({
        action: 'UPDATE', // Special marker that this is an UPSERT on inventory
        table: 'inventory_levels_upsert', 
        data: modifiedInventory.map(i => ({
          id: crypto.randomUUID(),
          product_id: i.productId,
          branch_id: i.branchId,
          variant_label: i.variantLabel || null,
          quantity: i.quantity,
          min_quantity: i.minQuantity
        }))
      });
    }

    // 5. Warranties
    if (newWarranties.length > 0) {
      get().addSyncTask({
        action: 'INSERT',
        table: 'warranties',
        data: newWarranties.map(w => ({
          id: w.id,
          product_id: w.productId,
          product_name: w.productName,
          transaction_id: w.transactionId,
          customer_id: w.customerId || null,
          customer_name: w.customerName || null,
          purchase_date: w.purchaseDate,
          expiry_date: w.expiryDate,
          serial_number: w.serialNumber || null,
          status: w.status
        }))
      });
    }"""

content = content.replace(old_block, new_block)
with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
