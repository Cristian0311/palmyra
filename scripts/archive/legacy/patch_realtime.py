import re

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

# 1. Update AppState interface
content = content.replace("processSyncQueue: () => Promise<void>;", "processSyncQueue: () => Promise<void>;\n  setupRealtimeSubscriptions: () => () => void;")

# 2. Add setupRealtimeSubscriptions implementation
# I'll add it before initializeFromSupabase
realtime_impl = """  setupRealtimeSubscriptions: () => {
    const channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'products' },
        (payload) => {
          console.log('[Realtime] Product change:', payload);
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const p = payload.new;
            const mappedProduct = {
              id: p.id,
              name: p.name,
              sku: p.sku,
              barcode: p.barcode || '',
              price: p.price,
              costPrice: p.cost_price,
              margin: p.margin,
              categoryId: p.category_id,
              color: p.color || 'bg-slate-100',
              commissionType: p.commission_type || 'percentage',
              commissionValue: p.commission_value || 0,
              unit: p.unit || 'unidad',
              status: p.status || 'active',
              minStockAlert: p.min_stock_alert || 0,
              hasSerial: p.has_serial || false,
              isKit: p.is_kit || false,
              warrantyDays: p.warranty_days || 0,
              deviceColor: p.device_color,
              availableSizes: p.available_sizes || [],
              availableColors: p.available_colors || [],
              nextSerial: p.next_serial || 1,
              image: p.image
            };
            set(state => ({
              products: state.products.some(old => old.id === p.id)
                ? state.products.map(old => old.id === p.id ? mappedProduct : old)
                : [mappedProduct, ...state.products]
            }));
          } else if (payload.eventType === 'DELETE') {
            set(state => ({
              products: state.products.filter(p => p.id !== payload.old.id)
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory_levels' },
        (payload) => {
          console.log('[Realtime] Inventory change:', payload);
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const i = payload.new;
            const mappedInv = {
              id: i.id,
              productId: i.product_id,
              branchId: i.branch_id,
              variantLabel: i.variant_label,
              quantity: i.quantity,
              minQuantity: i.min_quantity
            };
            set(state => ({
              inventory: state.inventory.some(old => old.id === i.id)
                ? state.inventory.map(old => old.id === i.id ? mappedInv : old)
                : [...state.inventory, mappedInv]
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'categories' },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const c = payload.new;
            set(state => ({
              categories: state.categories.some(old => old.id === c.id)
                ? state.categories.map(old => old.id === c.id ? { id: c.id, name: c.name, department: c.department } : old)
                : [...state.categories, { id: c.id, name: c.name, department: c.department }]
            }));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  },
"""

content = content.replace("initializeFromSupabase: async () => {", realtime_impl + "  initializeFromSupabase: async () => {")

with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
