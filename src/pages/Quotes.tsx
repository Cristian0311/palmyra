import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  FileDown,
  FileText,
  Minus,
  Package,
  Plus,
  Printer,
  Search,
  ShoppingCart,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Wallet,
  Warehouse,
  X,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { formatMoney, cn } from '../lib/utils';
import { InfoTooltip } from '../components/InfoTooltip';
import { getAuthorizedWarehouseIds } from '../modules/warehouse/warehouseScope';
import type { CartItem, Customer, Product, Quote } from '../types';

type QuoteStatus = 'pending' | 'converted' | 'expired';
type View = 'list' | 'builder';

type DraftLine = {
  id: string;
  product: Product;
  variantLabel?: string;
  quantity: number;
  price: number;
};

/**
 * Numeric input that keeps its own text draft so the user can select,
 * delete and retype freely without the field rewriting the value mid-edit.
 */
function NumberField({
  value,
  min = 0,
  max,
  integer = false,
  onCommit,
  ariaLabel,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  integer?: boolean;
  onCommit: (next: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const clamp = (raw: string, fallback: number) => {
    const parsed = Number(raw.replace(',', '.'));
    if (raw.trim() === '' || !Number.isFinite(parsed)) return fallback;
    const normalized = integer ? Math.floor(parsed) : parsed;
    return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, normalized));
  };

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={draft}
      aria-label={ariaLabel}
      onFocus={(event) => {
        setFocused(true);
        event.currentTarget.select();
      }}
      onChange={(event) => {
        const raw = event.target.value;
        if (!/^\d*[.,]?\d*$/.test(raw)) return;
        setDraft(raw);
        const parsed = Number(raw.replace(',', '.'));
        if (raw.trim() !== '' && Number.isFinite(parsed)) {
          const normalized = integer ? Math.floor(parsed) : parsed;
          if (normalized >= min && normalized <= (max ?? Number.POSITIVE_INFINITY)) onCommit(normalized);
        }
      }}
      onBlur={() => {
        setFocused(false);
        const final = clamp(draft, value);
        onCommit(final);
        setDraft(String(final));
      }}
      className={className}
    />
  );
}

type CatalogEntry = {
  key: string;
  product: Product;
  variantLabel?: string;
  stock: number;
};

const STATUS_LABEL: Record<QuoteStatus, string> = {
  pending: 'Pendiente',
  converted: 'Convertida',
  expired: 'Vencida',
};

const STATUS_CLASS: Record<QuoteStatus, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  converted: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  expired: 'border-base bg-subtle text-muted',
};

const QUOTE_CODE = (id: string) => `COT-${id.replace(/-/g, '').slice(-8).toUpperCase()}`;

const quoteDerivedStatus = (quote: Quote): QuoteStatus => {
  if (
    quote.status === 'pending' &&
    quote.validUntil &&
    new Date(quote.validUntil).getTime() < Date.now()
  ) {
    return 'expired';
  }
  return quote.status;
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' });

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('es-CU', { day: '2-digit', month: 'long', year: 'numeric' });

const money = (value: number) =>
  new Intl.NumberFormat('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(value) || 0,
  );

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );

type PrintContext = {
  businessName: string;
  businessAddress: string;
  businessPhone: string;
  customerName: string;
  customerPhone: string;
  customerTaxId: string;
  warehouseName: string;
  currencyCode: string;
};

function buildQuoteHtml(quote: Quote, ctx: PrintContext): string {
  const lines = (quote.items || []).map((item, index) => {
    const product = item.product as Product;
    return `
      <tr>
        <td class="num">${index + 1}</td>
        <td>
          <div class="item-name">${escapeHtml(product?.name || 'Producto')}</div>
          <div class="item-meta">${escapeHtml(item.variantLabel || '')}${item.variantLabel && product?.sku ? ' · ' : ''}${escapeHtml(product?.sku || '')}</div>
        </td>
        <td class="center">${Number(item.quantity) || 0}</td>
        <td class="right">${money(item.price)}</td>
        <td class="right strong">${money(item.total)}</td>
      </tr>`;
  }).join('');

  const contactBits = [ctx.businessAddress, ctx.businessPhone].filter(Boolean);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(QUOTE_CODE(quote.id))} · Cotización</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1f2937; background: #fff; font-size: 12px; }
  .toolbar { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; background: #f5f3ff; border-bottom: 1px solid #ddd6fe; }
  .toolbar button { border: 0; border-radius: 8px; padding: 9px 16px; font-weight: 700; cursor: pointer; font-size: 12px; }
  .toolbar .primary { background: #6535c5; color: #fff; }
  .toolbar .ghost { background: #fff; color: #4c1d95; border: 1px solid #c4b5fd; }
  .sheet { max-width: 760px; margin: 20px auto 40px; padding: 8px 6px; }
  .top { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #6535c5; padding-bottom: 16px; }
  .brand { display: flex; gap: 12px; align-items: flex-start; }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #6535c5, #8b63e6); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; }
  .brand h1 { margin: 0; font-size: 20px; letter-spacing: .08em; color: #3b0764; }
  .brand p { margin: 3px 0 0; color: #6b7280; font-size: 11px; line-height: 1.5; }
  .doc { text-align: right; }
  .doc .kind { font-size: 22px; font-weight: 800; letter-spacing: .12em; color: #6535c5; margin: 0; }
  .doc .code { font-family: "Consolas", monospace; font-size: 13px; font-weight: 700; color: #111827; margin-top: 4px; }
  .doc .date { color: #6b7280; font-size: 11px; margin-top: 4px; }
  .meta { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; margin: 18px 0; }
  .box { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; }
  .box h2 { margin: 0 0 8px; font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: #7c3aed; }
  .box p { margin: 2px 0; font-size: 12px; }
  .box .lbl { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th { background: #f5f3ff; color: #4c1d95; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; padding: 9px 10px; border-bottom: 1px solid #ddd6fe; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; font-size: 12px; }
  tbody tr:nth-child(even) { background: #fcfbff; }
  .num { width: 26px; color: #9ca3af; }
  .center { text-align: center; }
  .right { text-align: right; }
  .strong { font-weight: 700; }
  .item-name { font-weight: 700; color: #111827; }
  .item-meta { color: #6b7280; font-size: 10px; margin-top: 1px; }
  .totals { display: flex; justify-content: flex-end; margin-top: 12px; }
  .totals table { width: 300px; }
  .totals td { padding: 7px 10px; border: 0; font-size: 12px; }
  .totals tr.grand td { border-top: 2px solid #6535c5; font-size: 16px; font-weight: 800; color: #3b0764; padding-top: 10px; }
  .notes { margin-top: 18px; border-left: 3px solid #c4b5fd; background: #faf8ff; padding: 10px 12px; border-radius: 0 10px 10px 0; }
  .notes h3 { margin: 0 0 4px; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: #6d28d9; }
  .notes p { margin: 0; white-space: pre-wrap; font-size: 11px; color: #374151; line-height: 1.55; }
  .valid { margin-top: 14px; font-size: 11px; color: #4b5563; }
  .valid b { color: #3b0764; }
  .signs { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 54px; }
  .sign { border-top: 1px solid #9ca3af; padding-top: 6px; text-align: center; font-size: 10px; color: #6b7280; }
  .foot { margin-top: 26px; border-top: 1px solid #e5e7eb; padding-top: 10px; font-size: 9px; color: #9ca3af; display: flex; justify-content: space-between; gap: 12px; }
  @media print { .toolbar { display: none !important; } .sheet { margin: 0 auto; padding: 0; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="ghost" onclick="window.close()">Cerrar</button>
    <button class="primary" onclick="window.print()">Imprimir / Guardar PDF</button>
  </div>
  <main class="sheet">
    <header class="top">
      <div class="brand">
        <div class="mark">P</div>
        <div>
          <h1>${escapeHtml(ctx.businessName)}</h1>
          ${contactBits.length ? `<p>${contactBits.map(escapeHtml).join('<br/>')}</p>` : ''}
        </div>
      </div>
      <div class="doc">
        <p class="kind">COTIZACIÓN</p>
        <div class="code">${escapeHtml(QUOTE_CODE(quote.id))}</div>
        <div class="date">Emitida el ${escapeHtml(longDate(quote.date))}</div>
      </div>
    </header>

    <section class="meta">
      <div class="box">
        <h2>Cliente</h2>
        <p class="strong">${escapeHtml(ctx.customerName)}</p>
        ${ctx.customerPhone ? `<p><span class="lbl">Teléfono</span> ${escapeHtml(ctx.customerPhone)}</p>` : ''}
        ${ctx.customerTaxId ? `<p><span class="lbl">Documento</span> ${escapeHtml(ctx.customerTaxId)}</p>` : ''}
      </div>
      <div class="box">
        <h2>Datos de la oferta</h2>
        <p><span class="lbl">Almacén</span> ${escapeHtml(ctx.warehouseName)}</p>
        <p><span class="lbl">Moneda</span> ${escapeHtml(ctx.currencyCode)}</p>
        ${quote.validUntil ? `<p><span class="lbl">Válida hasta</span> ${escapeHtml(longDate(quote.validUntil))}</p>` : ''}
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Descripción</th>
          <th class="center">Cant.</th>
          <th class="right">Precio unit.</th>
          <th class="right">Importe</th>
        </tr>
      </thead>
      <tbody>${lines}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td>Subtotal</td><td class="right">${money(quote.subtotal)} ${escapeHtml(ctx.currencyCode)}</td></tr>
        <tr><td>Impuestos</td><td class="right">${money(quote.tax)} ${escapeHtml(ctx.currencyCode)}</td></tr>
        <tr class="grand"><td>Total</td><td class="right">${money(quote.total)} ${escapeHtml(ctx.currencyCode)}</td></tr>
      </table>
    </div>

    ${quote.notes ? `<section class="notes"><h3>Notas y condiciones</h3><p>${escapeHtml(quote.notes)}</p></section>` : ''}

    <p class="valid">Precios expresados en <b>${escapeHtml(ctx.currencyCode)}</b>. ${quote.validUntil ? `Esta oferta es válida hasta el <b>${escapeHtml(longDate(quote.validUntil))}</b>.` : ''} La disponibilidad está sujeta al stock al momento de confirmar el pedido.</p>

    <div class="signs">
      <div class="sign">Firma del cliente</div>
      <div class="sign">Autorizado por ${escapeHtml(ctx.businessName)}</div>
    </div>

    <footer class="foot">
      <span>Documento generado por PALMYRA · No es una factura ni comprobante de pago.</span>
      <span>${escapeHtml(QUOTE_CODE(quote.id))}</span>
    </footer>
  </main>
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 350); });</script>
</body>
</html>`;
}

export default function Quotes() {
  const {
    quotes,
    customers,
    products,
    categories,
    inventory,
    branches,
    currentUser,
    currentBranchId,
    receiptConfig,
    addQuote,
    addCustomer,
    deleteQuote,
    addNotification,
    getBaseCurrency,
  } = useStore(useShallow((state) => ({
    quotes: state.quotes,
    customers: state.customers,
    products: state.products,
    categories: state.categories,
    inventory: state.inventory,
    branches: state.branches,
    currentUser: state.currentUser,
    currentBranchId: state.currentBranchId,
    receiptConfig: state.receiptConfig,
    addQuote: state.addQuote,
    addCustomer: state.addCustomer,
    deleteQuote: state.deleteQuote,
    addNotification: state.addNotification,
    getBaseCurrency: state.getBaseCurrency,
  })));

  const navigate = useNavigate();
  const baseCurrency = getBaseCurrency();

  const allowedWarehouses = useMemo(() => {
    if (!currentUser || currentUser.role === 'admin') return branches;
    const allowed = getAuthorizedWarehouseIds(currentUser);
    const filtered = branches.filter((b) => allowed.includes(b.id));
    return filtered.length ? filtered : branches;
  }, [branches, currentUser]);

  const defaultWarehouseId = useMemo(() => {
    if (allowedWarehouses.some((b) => b.id === currentBranchId)) return currentBranchId;
    return allowedWarehouses[0]?.id || '';
  }, [allowedWarehouses, currentBranchId]);

  const [view, setView] = useState<View>('list');
  const [statusFilter, setStatusFilter] = useState<'all' | QuoteStatus>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [detailQuote, setDetailQuote] = useState<Quote | null>(null);
  const [quoteToDelete, setQuoteToDelete] = useState<Quote | null>(null);

  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId);
  const [customerId, setCustomerId] = useState('');
  const [validDays, setValidDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', email: '', taxId: '' });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [creating, setCreating] = useState(false);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const confirmDeleteQuote = () => {
    if (!quoteToDelete) return;
    deleteQuote(quoteToDelete.id);
    if (detailQuote?.id === quoteToDelete.id) setDetailQuote(null);
    setQuoteToDelete(null);
    addNotification('Cotización eliminada. Si estabas sin conexión, se borrará en la nube al sincronizar.', 'success');
  };

  const warehouseName = (id: string) => branches.find((b) => b.id === id)?.name || 'Almacén';

  const startNewQuote = () => {
    setWarehouseId(defaultWarehouseId);
    setCustomerId('');
    setValidDays(7);
    setNotes('');
    setLines([]);
    setCatalogSearch('');
    setCategoryFilter('all');
    setView('builder');
  };

  const duplicateQuote = (quote: Quote) => {
    setWarehouseId(quote.branchId || defaultWarehouseId);
    setCustomerId(quote.customerId || '');
    setValidDays(7);
    setNotes(quote.notes || '');
    setLines(
      (quote.items || [])
        .map((item, index): DraftLine | null => {
          const product = productById.get((item.product as Product)?.id || '');
          if (!product) return null;
          return {
            id: `line-${index}-${Date.now()}`,
            product,
            variantLabel: item.variantLabel,
            quantity: Math.max(1, Number(item.quantity) || 1),
            price: Number(item.price) || product.price,
          } satisfies DraftLine;
        })
        .filter((line): line is DraftLine => Boolean(line)),
    );
    setCatalogSearch('');
    setCategoryFilter('all');
    setView('builder');
  };

  const catalog = useMemo<CatalogEntry[]>(() => {
    const entries = new Map<string, CatalogEntry>();
    for (const product of products) {
      if (product.status === 'discontinued') continue;
      const rows = inventory.filter(
        (row) =>
          row.productId === product.id &&
          (row.branchId === warehouseId || row.warehouseId === warehouseId),
      );
      if (rows.length === 0) {
        entries.set(`${product.id}::`, { key: `${product.id}::`, product, stock: 0 });
        continue;
      }
      for (const row of rows) {
        const key = `${product.id}::${row.variantLabel || ''}`;
        const existing = entries.get(key);
        entries.set(key, {
          key,
          product,
          variantLabel: row.variantLabel,
          stock: (existing?.stock || 0) + (Number(row.quantity) || 0),
        });
      }
    }
    return Array.from(entries.values()).sort((a, b) => {
      const byName = a.product.name.localeCompare(b.product.name, 'es');
      if (byName !== 0) return byName;
      return (a.variantLabel || '').localeCompare(b.variantLabel || '', 'es');
    });
  }, [products, inventory, warehouseId]);

  const filteredCatalog = useMemo(() => {
    const term = catalogSearch.trim().toLowerCase();
    return catalog.filter((entry) => {
      const matchesCategory =
        categoryFilter === 'all' || entry.product.categoryId === categoryFilter;
      const haystack = [
        entry.product.name,
        entry.product.sku,
        entry.product.barcode,
        entry.variantLabel,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return matchesCategory && (!term || haystack.includes(term));
    });
  }, [catalog, catalogSearch, categoryFilter]);

  const visibleCatalog = filteredCatalog.slice(0, 80);

  const lineTotal = (line: DraftLine) =>
    Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.price) || 0);

  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const totalUnits = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  const addLine = (entry: CatalogEntry) => {
    setLines((current) => {
      const existing = current.find(
        (line) =>
          line.product.id === entry.product.id &&
          (line.variantLabel || '') === (entry.variantLabel || ''),
      );
      if (existing) {
        return current.map((line) =>
          line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          id: `line-${entry.key}-${Date.now()}`,
          product: entry.product,
          variantLabel: entry.variantLabel,
          quantity: 1,
          price: Number(entry.product.price) || 0,
        },
      ];
    });
  };

  const updateLine = (id: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const removeLine = (id: string) => setLines((current) => current.filter((line) => line.id !== id));

  const handleCreateCustomer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newCustomer.name.trim()) return;
    setSavingCustomer(true);
    try {
      const id = crypto.randomUUID();
      const created: Customer = {
        id,
        name: newCustomer.name.trim(),
        phone: newCustomer.phone.trim(),
        email: newCustomer.email.trim(),
        taxId: newCustomer.taxId.trim() || undefined,
      };
      const saved = await addCustomer(created);
      if (!saved) {
        addNotification('No se pudo guardar el cliente. Intenta de nuevo.', 'error');
        return;
      }
      setCustomerId(id);
      setShowNewCustomer(false);
      setNewCustomer({ name: '', phone: '', email: '', taxId: '' });
      addNotification('Cliente creado y seleccionado en la cotización.', 'success');
    } finally {
      setSavingCustomer(false);
    }
  };

  const printQuote = (quote: Quote, customer?: Customer) => {
    const win = window.open('', '_blank', 'width=980,height=1000');
    if (!win) {
      addNotification('El navegador bloqueó la ventana del documento. Permite las ventanas emergentes para generar el PDF.', 'warning');
      return;
    }
    const html = buildQuoteHtml(quote, {
      businessName: receiptConfig?.businessName || 'PALMYRA',
      businessAddress: receiptConfig?.businessAddress || '',
      businessPhone: receiptConfig?.businessPhone || '',
      customerName: customer?.name || 'Consumidor final',
      customerPhone: customer?.phone || '',
      customerTaxId: customer?.taxId || '',
      warehouseName: warehouseName(quote.branchId),
      currencyCode: quote.currencyCode || baseCurrency.code,
    });
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  const handleCreateQuote = () => {
    if (!warehouseId) {
      addNotification('Selecciona el almacén de la cotización.', 'warning');
      return;
    }
    if (lines.length === 0) {
      addNotification('Agrega al menos un producto a la cotización.', 'warning');
      return;
    }
    setCreating(true);
    try {
      const items: CartItem[] = lines.map((line) => ({
        id: crypto.randomUUID(),
        product: line.product,
        quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)),
        price: Math.max(0, Number(line.price) || 0),
        total: lineTotal(line),
        variantLabel: line.variantLabel,
      }));
      const quote: Quote = {
        id: crypto.randomUUID(),
        branchId: warehouseId,
        userId: currentUser?.id || 'system',
        customerId: customerId || undefined,
        date: new Date().toISOString(),
        subtotal,
        tax: 0,
        total: subtotal,
        items,
        status: 'pending',
        notes: notes.trim() || undefined,
        currencyCode: baseCurrency.code,
        validUntil: new Date(Date.now() + validDays * 86400000).toISOString(),
      };
      addQuote(quote);
      printQuote(quote, customerId ? customerById.get(customerId) : undefined);
      setView('list');
      setDetailQuote(quote);
      addNotification(`Cotización ${QUOTE_CODE(quote.id)} creada. Usa «Guardar PDF» en el documento para descargarla.`, 'success');
    } finally {
      setCreating(false);
    }
  };

  const derivedStatuses = useMemo(
    () => new Map(quotes.map((quote) => [quote.id, quoteDerivedStatus(quote)])),
    [quotes],
  );

  const filteredQuotes = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return quotes
      .filter((quote) => {
        const customer = quote.customerId ? customerById.get(quote.customerId) : undefined;
        const matchesSearch =
          !term ||
          QUOTE_CODE(quote.id).toLowerCase().includes(term) ||
          String(quote.id).toLowerCase().includes(term) ||
          (customer?.name || '').toLowerCase().includes(term) ||
          (customer?.phone || '').toLowerCase().includes(term);
        const status = derivedStatuses.get(quote.id) || quote.status;
        return matchesSearch && (statusFilter === 'all' || status === statusFilter);
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [quotes, customerById, searchTerm, statusFilter, derivedStatuses]);

  const kpis = useMemo(() => {
    let pending = 0;
    let converted = 0;
    let expired = 0;
    let pendingValue = 0;
    for (const quote of quotes) {
      const status = derivedStatuses.get(quote.id) || quote.status;
      if (status === 'pending') {
        pending += 1;
        pendingValue += Number(quote.total) || 0;
      } else if (status === 'converted') {
        converted += 1;
      } else {
        expired += 1;
      }
    }
    return { pending, converted, expired, pendingValue };
  }, [quotes, derivedStatuses]);

  const filters: Array<{ id: 'all' | QuoteStatus; label: string; count: number }> = [
    { id: 'all', label: 'Todas', count: quotes.length },
    { id: 'pending', label: 'Pendientes', count: kpis.pending },
    { id: 'converted', label: 'Convertidas', count: kpis.converted },
    { id: 'expired', label: 'Vencidas', count: kpis.expired },
  ];

  if (view === 'builder') {
    return (
      <div className="space-y-4 animate-in fade-in duration-200 pb-24">
        <div className="flex flex-col gap-3 rounded-2xl border border-base bg-secondary p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => setView('list')}
              aria-label="Volver al listado de cotizaciones"
              className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-base bg-subtle text-secondary transition-colors hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div>
              <h1 className="text-lg font-black uppercase tracking-tight text-primary sm:text-xl">Nueva cotización</h1>
              <p className="mt-0.5 text-sm font-semibold text-muted">
                Elige el almacén, agrega productos y crea el documento sin abrir el Punto de Venta.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-black uppercase tracking-wide text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">
              <Sparkles size={14} /> {lines.length} {lines.length === 1 ? 'línea' : 'líneas'} · {totalUnits} {totalUnits === 1 ? 'unidad' : 'unidades'}
            </span>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-muted">
                    <Warehouse size={13} /> Almacén
                  </span>
                  <select
                    value={warehouseId}
                    onChange={(e) => setWarehouseId(e.target.value)}
                    className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                  >
                    {allowedWarehouses.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-muted">
                    <Users size={13} /> Cliente
                  </span>
                  <div className="flex gap-2">
                    <select
                      value={customerId}
                      onChange={(e) => setCustomerId(e.target.value)}
                      className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                    >
                      <option value="">Consumidor final</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}{customer.phone ? ` · ${customer.phone}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowNewCustomer(true)}
                      aria-label="Crear un cliente nuevo"
                      title="Crear cliente nuevo"
                      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition-colors hover:bg-violet-700"
                    >
                      <UserPlus size={16} />
                    </button>
                  </div>
                </label>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
              <div className="flex flex-col gap-2 border-b border-base p-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    type="search"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    placeholder="Buscar por nombre, SKU o código de barras…"
                    className="w-full rounded-xl border border-base bg-subtle py-2.5 pl-9 pr-3 text-sm font-bold text-primary"
                  />
                </div>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary sm:w-52"
                >
                  <option value="all">Todas las categorías</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </div>

              <div className="max-h-[560px] divide-y divide-base overflow-y-auto">
                {visibleCatalog.map((entry) => {
                  const inDraft = lines.find(
                    (line) =>
                      line.product.id === entry.product.id &&
                      (line.variantLabel || '') === (entry.variantLabel || ''),
                  );
                  const lowStock = entry.stock <= 0;
                  return (
                    <div key={entry.key} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-subtle/60">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-base bg-subtle text-violet-600 dark:text-violet-300">
                        <Package size={17} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-black text-primary">{entry.product.name}</p>
                        <p className="truncate text-xs font-semibold text-muted">
                          {entry.variantLabel ? `${entry.variantLabel} · ` : ''}{entry.product.sku || 'Sin SKU'}
                        </p>
                      </div>
                      <div className="hidden shrink-0 text-right sm:block">
                        <p className="text-sm font-black tabular-nums text-primary">{formatMoney(entry.product.price, baseCurrency.symbol)}</p>
                        <p className={cn('text-xs font-bold', lowStock ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
                          {lowStock ? 'Sin stock' : `${entry.stock} disp.`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => addLine(entry)}
                        aria-label={`Agregar ${entry.product.name} a la cotización`}
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors',
                          inDraft
                            ? 'bg-violet-600 text-white'
                            : 'border border-base bg-secondary text-secondary hover:border-violet-300 hover:text-violet-700 dark:hover:text-violet-300',
                        )}
                      >
                        {inDraft ? <CheckCircle2 size={16} /> : <Plus size={16} />}
                      </button>
                    </div>
                  );
                })}
                {visibleCatalog.length === 0 && (
                  <div className="flex flex-col items-center gap-2 p-10 text-center">
                    <Package size={26} className="text-muted" />
                    <p className="text-sm font-black text-primary">Sin resultados</p>
                    <p className="text-xs font-semibold text-muted">Cambia la búsqueda o la categoría seleccionada.</p>
                  </div>
                )}
              </div>
              {filteredCatalog.length > visibleCatalog.length && (
                <p className="border-t border-base bg-subtle px-3 py-2 text-xs font-bold text-muted">
                  Mostrando {visibleCatalog.length} de {filteredCatalog.length}. Refina la búsqueda para ver más.
                </p>
              )}
            </div>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
            <div className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
              <div className="flex items-center justify-between border-b border-base bg-subtle px-4 py-3">
                <span className="flex items-center gap-2 text-sm font-black uppercase tracking-tight text-primary">
                  <FileText size={15} className="text-violet-600 dark:text-violet-300" /> Borrador
                </span>
                {lines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setLines([])}
                    className="text-xs font-black uppercase tracking-wide text-muted transition-colors hover:text-red-600 dark:hover:text-red-400"
                  >
                    Vaciar
                  </button>
                )}
              </div>

              <div className="max-h-[340px] divide-y divide-base overflow-y-auto">
                {lines.map((line) => (
                  <div key={line.id} className="space-y-2 px-3 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-primary">{line.product.name}</p>
                        <p className="truncate text-xs font-semibold text-muted">
                          {line.variantLabel || line.product.sku || 'Producto'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        aria-label={`Quitar ${line.product.name}`}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center rounded-xl border border-base bg-subtle">
                        <button
                          type="button"
                          onClick={() => updateLine(line.id, { quantity: Math.max(1, line.quantity - 1) })}
                          aria-label="Reducir cantidad"
                          className="flex h-8 w-8 items-center justify-center text-secondary"
                        >
                          <Minus size={13} />
                        </button>
                        <NumberField
                          value={line.quantity}
                          min={1}
                          integer
                          onCommit={(next) => updateLine(line.id, { quantity: next })}
                          ariaLabel={`Cantidad de ${line.product.name}`}
                          className="w-11 border-0 bg-transparent p-0 text-center text-sm font-black tabular-nums text-primary focus:ring-0"
                        />
                        <button
                          type="button"
                          onClick={() => updateLine(line.id, { quantity: line.quantity + 1 })}
                          aria-label="Aumentar cantidad"
                          className="flex h-8 w-8 items-center justify-center text-secondary"
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <label className="flex flex-1 items-center gap-1.5 rounded-xl border border-base bg-subtle px-2 py-1.5">
                        <span className="text-[10px] font-black uppercase tracking-wide text-muted">{baseCurrency.code}</span>
                        <NumberField
                          value={line.price}
                          min={0}
                          onCommit={(next) => updateLine(line.id, { price: next })}
                          ariaLabel={`Precio unitario de ${line.product.name}`}
                          className="w-full border-0 bg-transparent p-0 text-right text-sm font-black tabular-nums text-primary focus:ring-0"
                        />
                      </label>
                    </div>
                    <div className="flex items-center justify-between text-xs font-bold text-muted">
                      <span>Importe</span>
                      <span className="text-sm font-black tabular-nums text-primary">
                        {formatMoney(lineTotal(line), baseCurrency.symbol)}
                      </span>
                    </div>
                  </div>
                ))}
                {lines.length === 0 && (
                  <div className="flex flex-col items-center gap-2 p-8 text-center">
                    <ShoppingCart size={24} className="text-muted" />
                    <p className="text-sm font-black text-primary">La cotización está vacía</p>
                    <p className="text-xs font-semibold text-muted">Agrega productos desde el catálogo.</p>
                  </div>
                )}
              </div>

              <div className="space-y-3 border-t border-base p-4">
                <div className="flex items-center justify-between text-sm font-bold text-secondary">
                  <span>Subtotal</span>
                  <span className="font-black tabular-nums text-primary">{formatMoney(subtotal, baseCurrency.symbol)}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-violet-50 px-3 py-2.5 dark:bg-violet-950/40">
                  <span className="text-sm font-black uppercase tracking-wide text-violet-700 dark:text-violet-300">Total</span>
                  <span className="text-lg font-black tabular-nums text-violet-700 dark:text-violet-300">
                    {formatMoney(subtotal, baseCurrency.symbol)} {baseCurrency.code}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-muted">Validez</span>
                    <select
                      value={validDays}
                      onChange={(e) => setValidDays(Number(e.target.value))}
                      className="w-full rounded-xl border border-base bg-subtle px-2 py-2 text-sm font-bold text-primary"
                    >
                      <option value={7}>7 días</option>
                      <option value={15}>15 días</option>
                      <option value={30}>30 días</option>
                    </select>
                  </label>
                  <div className="flex items-end">
                    <span className="flex w-full items-center gap-1.5 rounded-xl border border-base bg-subtle px-2 py-2 text-xs font-bold text-muted">
                      <CalendarDays size={13} />
                      {shortDate(new Date(Date.now() + validDays * 86400000).toISOString())}
                    </span>
                  </div>
                </div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Condiciones, entrega o notas para el cliente…"
                  className="w-full resize-none rounded-xl border border-base bg-subtle px-3 py-2 text-sm font-semibold text-primary"
                />
                <button
                  type="button"
                  onClick={handleCreateQuote}
                  disabled={creating || lines.length === 0 || !warehouseId}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-sm font-black uppercase tracking-wide text-white shadow-md shadow-violet-600/20 transition-all hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Printer size={16} />
                  {creating ? 'Creando…' : 'Crear cotización y PDF'}
                </button>
                <p className="text-center text-[11px] font-semibold leading-relaxed text-muted">
                  Se abrirá el documento listo para imprimir o guardar como PDF.
                </p>
              </div>
            </div>
          </aside>
        </div>

        {showNewCustomer && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm">
            <form onSubmit={handleCreateCustomer} className="w-full max-w-md overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl">
              <div className="flex items-center justify-between border-b border-base bg-subtle px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-tight text-primary">
                  <UserPlus size={16} className="text-violet-600 dark:text-violet-300" /> Nuevo cliente
                </h2>
                <button
                  type="button"
                  onClick={() => setShowNewCustomer(false)}
                  aria-label="Cerrar formulario de cliente"
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-secondary hover:text-primary"
                >
                  <X size={17} />
                </button>
              </div>
              <div className="space-y-3 p-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-wider text-muted">Nombre</span>
                  <input
                    required
                    autoFocus
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                    placeholder="Ej: María López"
                    className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-black uppercase tracking-wider text-muted">Teléfono</span>
                    <input
                      inputMode="tel"
                      value={newCustomer.phone}
                      onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                      placeholder="Ej: 5351234567"
                      className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-black uppercase tracking-wider text-muted">Documento</span>
                    <input
                      value={newCustomer.taxId}
                      onChange={(e) => setNewCustomer({ ...newCustomer, taxId: e.target.value })}
                      placeholder="Cédula o RNC"
                      className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-wider text-muted">Correo</span>
                  <input
                    type="email"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                    placeholder="cliente@correo.com"
                    className="w-full rounded-xl border border-base bg-subtle px-3 py-2.5 text-sm font-bold text-primary"
                  />
                </label>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowNewCustomer(false)}
                    className="flex-1 rounded-xl border border-base bg-secondary py-2.5 text-xs font-black uppercase tracking-wide text-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={savingCustomer || !newCustomer.name.trim()}
                    className="flex-1 rounded-xl bg-violet-600 py-2.5 text-xs font-black uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    {savingCustomer ? 'Guardando…' : 'Guardar cliente'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-black uppercase tracking-tight text-primary sm:text-xl">
              <FileText size={19} className="text-violet-600 dark:text-violet-300" />
              Cotizaciones y presupuestos
              <InfoTooltip text="Crea presupuestos con almacén, productos y cliente. Cada cotización genera un documento PDF listo para enviar al cliente." />
            </h1>
            <p className="mt-1 text-sm font-semibold text-muted">
              Prepara la oferta sin abrir el Punto de Venta y conviértela en venta cuando el cliente acepte.
            </p>
          </div>
          <button
            type="button"
            onClick={startNewQuote}
            className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-black uppercase tracking-wide text-white shadow-md shadow-violet-600/20 transition-all hover:bg-violet-700 active:scale-95"
          >
            <Plus size={16} /> Nueva cotización
          </button>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
          <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-muted">
            <Clock3 size={13} className="text-amber-500" /> Pendientes
          </span>
          <p className="mt-2 text-2xl font-black tabular-nums text-primary">{kpis.pending}</p>
        </div>
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
          <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-muted">
            <Wallet size={13} className="text-violet-600 dark:text-violet-300" /> Valor pendiente
          </span>
          <p className="mt-2 text-2xl font-black tabular-nums text-primary">
            {formatMoney(kpis.pendingValue, baseCurrency.symbol)}
          </p>
        </div>
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
          <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-muted">
            <CheckCircle2 size={13} className="text-emerald-500" /> Convertidas
          </span>
          <p className="mt-2 text-2xl font-black tabular-nums text-primary">{kpis.converted}</p>
        </div>
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
          <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-muted">
            <AlertTriangle size={13} className="text-red-500" /> Vencidas
          </span>
          <p className="mt-2 text-2xl font-black tabular-nums text-primary">{kpis.expired}</p>
        </div>
      </section>

      <div className="flex flex-col gap-3 rounded-2xl border border-base bg-secondary p-3 shadow-sm lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar por número, cliente o teléfono…"
            aria-label="Buscar cotizaciones"
            className="w-full rounded-xl border border-base bg-subtle py-2.5 pl-9 pr-3 text-sm font-bold text-primary"
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1 lg:pb-0">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatusFilter(filter.id)}
              aria-pressed={statusFilter === filter.id}
              className={cn(
                'shrink-0 rounded-lg px-3 py-2 text-[11px] font-black uppercase tracking-wide transition-colors',
                statusFilter === filter.id
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'border border-base bg-secondary text-secondary hover:bg-subtle hover:text-primary',
              )}
            >
              {filter.label} <span className="opacity-70">({filter.count})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <div className="flex items-center justify-between border-b border-base bg-subtle/60 px-4 py-3">
          <span className="text-xs font-black uppercase tracking-wider text-primary">Listado de cotizaciones</span>
          <span className="text-xs font-bold text-muted">{filteredQuotes.length} registros</span>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[820px] text-left [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2.5">
            <thead className="border-b border-base bg-subtle">
              <tr className="text-[10px] font-black uppercase tracking-wider text-muted">
                <th>Cotización</th>
                <th>Cliente</th>
                <th>Fecha / validez</th>
                <th className="text-center">Estado</th>
                <th className="text-right">Total</th>
                <th className="text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {filteredQuotes.map((quote) => {
                const status = derivedStatuses.get(quote.id) || quote.status;
                const customer = quote.customerId ? customerById.get(quote.customerId) : undefined;
                const items = quote.items || [];
                return (
                  <tr key={quote.id} className="transition-colors hover:bg-subtle/60">
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-base bg-subtle text-violet-600 dark:text-violet-300">
                          <FileText size={16} />
                        </span>
                        <div>
                          <p className="font-mono text-sm font-black tracking-wide text-primary">{QUOTE_CODE(quote.id)}</p>
                          <p className="text-[11px] font-bold text-muted">{items.length} {items.length === 1 ? 'artículo' : 'artículos'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      <p className="text-sm font-black text-primary">{customer?.name || 'Consumidor final'}</p>
                      {customer?.phone && <p className="text-[11px] font-semibold text-muted">{customer.phone}</p>}
                    </td>
                    <td className="whitespace-nowrap">
                      <p className="text-sm font-bold text-primary">{shortDate(quote.date)}</p>
                      <p className="text-[11px] font-semibold text-muted">
                        {quote.validUntil ? `Válida hasta ${shortDate(quote.validUntil)}` : 'Sin vencimiento'}
                      </p>
                    </td>
                    <td className="text-center">
                      <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide', STATUS_CLASS[status])}>
                        {STATUS_LABEL[status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <span className="text-sm font-black tabular-nums text-primary">
                        {formatMoney(quote.total, baseCurrency.symbol)}
                      </span>
                      <span className="ml-1 text-[11px] font-bold text-muted">{quote.currencyCode || baseCurrency.code}</span>
                    </td>
                    <td>
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDetailQuote(quote)}
                          aria-label={`Ver detalle de ${QUOTE_CODE(quote.id)}`}
                          title="Ver detalle"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-base bg-secondary text-secondary transition-colors hover:text-violet-700 dark:hover:text-violet-300"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => printQuote(quote, customer)}
                          aria-label={`Descargar PDF de ${QUOTE_CODE(quote.id)}`}
                          title="PDF"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-violet-700 transition-colors hover:bg-violet-100 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300"
                        >
                          <FileDown size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateQuote(quote)}
                          aria-label={`Duplicar ${QUOTE_CODE(quote.id)}`}
                          title="Duplicar"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-base bg-secondary text-secondary transition-colors hover:text-primary"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(`/pos?loadQuote=${quote.id}`)}
                          title="Abre el POS con estos productos. El empleado elige su nombre y almacén, y el carrito se llena solo."
                          aria-label="Cobrar esta cotización en el Punto de Venta"
                          className="flex h-8 items-center justify-center gap-1 rounded-lg bg-violet-600 px-2 text-[10px] font-black uppercase text-white transition-colors hover:bg-violet-700"
                        >
                          <ShoppingCart size={13} /> Cobrar en POS
                        </button>
                        <button
                          type="button"
                          onClick={() => setQuoteToDelete(quote)}
                          aria-label={`Eliminar ${QUOTE_CODE(quote.id)}`}
                          title="Eliminar cotización"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 transition-colors hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredQuotes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-14 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <FileText size={28} className="text-muted opacity-70" />
                      <p className="text-sm font-black text-primary">No hay cotizaciones para este filtro</p>
                      <p className="text-xs font-semibold text-muted">Crea una nueva cotización o cambia el estado seleccionado.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <ul className="divide-y divide-base md:hidden">
          {filteredQuotes.length > 0 ? filteredQuotes.map((quote) => {
            const status = derivedStatuses.get(quote.id) || quote.status;
            const customer = quote.customerId ? customerById.get(quote.customerId) : undefined;
            return (
              <li key={quote.id} className="space-y-2.5 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-black tracking-wide text-primary">{QUOTE_CODE(quote.id)}</p>
                    <p className="mt-0.5 truncate text-[12px] font-bold text-secondary" title={customer?.name || 'Consumidor final'}>
                      {customer?.name || 'Consumidor final'}
                    </p>
                  </div>
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide', STATUS_CLASS[status])}>
                    {STATUS_LABEL[status]}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-[11px] font-semibold text-muted">
                    {shortDate(quote.date)} · {(quote.items || []).length} {(quote.items || []).length === 1 ? 'artículo' : 'artículos'}
                  </p>
                  <p className="shrink-0 text-sm font-black tabular-nums text-primary">
                    {formatMoney(quote.total, baseCurrency.symbol)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDetailQuote(quote)}
                    aria-label={`Ver detalle de ${QUOTE_CODE(quote.id)}`}
                    className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-base bg-secondary px-2 text-[11px] font-black uppercase text-secondary"
                  >
                    <Eye size={14} /> Ver
                  </button>
                  <button
                    type="button"
                    onClick={() => printQuote(quote, customer)}
                    aria-label={`Descargar PDF de ${QUOTE_CODE(quote.id)}`}
                    className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2 text-[11px] font-black uppercase text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300"
                  >
                    <FileDown size={14} /> PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicateQuote(quote)}
                    aria-label={`Duplicar ${QUOTE_CODE(quote.id)}`}
                    className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-base bg-secondary px-2 text-[11px] font-black uppercase text-secondary"
                  >
                    <Copy size={14} /> Duplicar
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuoteToDelete(quote)}
                    aria-label={`Eliminar ${QUOTE_CODE(quote.id)}`}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/pos?loadQuote=${quote.id}`)}
                  className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 text-[11px] font-black uppercase tracking-wide text-white active:scale-[0.99]"
                >
                  <ShoppingCart size={14} /> Cobrar en POS
                </button>
              </li>
            );
          }) : (
            <li className="px-6 py-12 text-center">
              <FileText size={28} className="mx-auto text-muted opacity-70" />
              <p className="mt-2 text-sm font-black text-primary">No hay cotizaciones para este filtro</p>
              <p className="text-xs font-semibold text-muted">Crea una nueva cotización o cambia el estado seleccionado.</p>
            </li>
          )}
        </ul>
      </div>

      {detailQuote && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm">
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl">
            <div className="flex items-start justify-between border-b border-base bg-subtle px-4 py-3">
              <div>
                <p className="font-mono text-sm font-black tracking-wide text-primary">{QUOTE_CODE(detailQuote.id)}</p>
                <p className="mt-0.5 text-xs font-semibold text-muted">
                  {shortDate(detailQuote.date)} · {warehouseName(detailQuote.branchId)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailQuote(null)}
                aria-label="Cerrar detalle"
                className="flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-secondary hover:text-primary"
              >
                <X size={17} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-base bg-subtle p-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-muted">Cliente</p>
                  <p className="text-sm font-black text-primary">
                    {detailQuote.customerId ? customerById.get(detailQuote.customerId)?.name || 'Cliente' : 'Consumidor final'}
                  </p>
                </div>
                <div className="rounded-xl border border-base bg-subtle p-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-muted">Validez</p>
                  <p className="text-sm font-black text-primary">
                    {detailQuote.validUntil ? longDate(detailQuote.validUntil) : 'Sin vencimiento'}
                  </p>
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border border-base">
                <table className="w-full [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
                  <thead className="border-b border-base bg-subtle text-[10px] font-black uppercase tracking-wider text-muted">
                    <tr>
                      <th className="text-left">Producto</th>
                      <th className="text-center">Cant.</th>
                      <th className="text-right">Precio</th>
                      <th className="text-right">Importe</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-base">
                    {(detailQuote.items || []).map((item) => (
                      <tr key={item.id}>
                        <td>
                          <p className="text-sm font-black text-primary">{(item.product as Product)?.name || 'Producto'}</p>
                          {item.variantLabel && <p className="text-[11px] font-semibold text-muted">{item.variantLabel}</p>}
                        </td>
                        <td className="text-center text-sm font-bold tabular-nums text-primary">{item.quantity}</td>
                        <td className="text-right text-sm font-bold tabular-nums text-primary">{formatMoney(item.price, baseCurrency.symbol)}</td>
                        <td className="text-right text-sm font-black tabular-nums text-primary">{formatMoney(item.total, baseCurrency.symbol)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detailQuote.notes && (
                <div className="mt-3 rounded-xl border-l-4 border-violet-400 bg-violet-50 px-3 py-2 text-sm font-semibold text-primary dark:bg-violet-950/40">
                  {detailQuote.notes}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between rounded-xl border border-base bg-subtle px-3 py-2.5">
                <span className="text-xs font-black uppercase tracking-wider text-muted">Total</span>
                <span className="text-lg font-black tabular-nums text-primary">
                  {formatMoney(detailQuote.total, baseCurrency.symbol)} {detailQuote.currencyCode || baseCurrency.code}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2 border-t border-base bg-subtle px-4 py-3 sm:flex-row">
              <button
                type="button"
                onClick={() => setDetailQuote(null)}
                className="rounded-xl border border-base bg-secondary px-4 py-2.5 text-xs font-black uppercase tracking-wide text-secondary"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => duplicateQuote(detailQuote)}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-4 py-2.5 text-xs font-black uppercase tracking-wide text-secondary"
              >
                <Copy size={14} /> Duplicar
              </button>
              <button
                type="button"
                onClick={() => printQuote(detailQuote, detailQuote.customerId ? customerById.get(detailQuote.customerId) : undefined)}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-4 py-2.5 text-xs font-black uppercase tracking-wide text-secondary"
              >
                <Printer size={14} /> Guardar PDF
              </button>
              <button
                type="button"
                onClick={() => setQuoteToDelete(detailQuote)}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-black uppercase tracking-wide text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
              >
                <Trash2 size={14} /> Eliminar
              </button>
              <button
                type="button"
                onClick={() => {
                  const quoteId = detailQuote.id;
                  setDetailQuote(null);
                  navigate(`/pos?loadQuote=${quoteId}`);
                }}
                title="Abre el POS con estos productos. El empleado elige su nombre y almacén, y el carrito se llena solo."
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-violet-700"
              >
                <ShoppingCart size={14} /> Cobrar en POS
              </button>
            </div>
          </div>
        </div>
      )}

      {quoteToDelete && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl">
            <div className="flex items-start gap-3 px-4 pt-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-300">
                <Trash2 size={18} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-black uppercase tracking-wide text-primary">Eliminar cotización</h3>
                <p className="mt-1 truncate text-xs font-bold text-secondary">
                  {QUOTE_CODE(quoteToDelete.id)} · {formatMoney(quoteToDelete.total, baseCurrency.symbol)}
                </p>
              </div>
            </div>
            <p className="px-4 pt-3 text-xs font-semibold leading-relaxed text-muted">
              Se borrará del historial de este dispositivo y de la nube al sincronizar. Las ventas ya cobradas de esta cotización no se modifican y el stock no cambia.
            </p>
            <div className="mt-4 flex gap-2 border-t border-base bg-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => setQuoteToDelete(null)}
                className="flex-1 rounded-xl border border-base bg-secondary px-3 py-2.5 text-xs font-black uppercase tracking-wide text-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteQuote}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-rose-700"
              >
                <Trash2 size={14} /> Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
