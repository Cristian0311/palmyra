import { useShallow } from 'zustand/react/shallow';
import React, { useEffect, useState, useMemo } from "react";
import { 
  TrendingUp, 
  Users, 
  DollarSign, 
  Package, 
  ShoppingBag, 
  ArrowUpRight, 
  ArrowDownRight, 
  Clock, 
  MapPin, 
  AlertCircle, 
  Banknote, 
  CreditCard, 
  Receipt, 
  Eye, 
  X, 
  CheckCircle2, 
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Sparkles
} from "lucide-react";
import { useStore } from "../store/useStore";
import { cn } from "../lib/utils";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { getBusinessSummaryAI } from "../services/gemini";
import { loadSaaSContext } from "../services/saas";
import PlanFeatureGate from "../components/PlanFeatureGate";
import type { Transaction, CartItem, Payment } from "../types";

export default function Dashboard() {
  const { branches, currentBranchId, setCurrentBranch, transactions, getBaseCurrency, currencies, inventory, products, customers, users, categories } = useStore(useShallow((state) => ({ branches: state.branches, currentBranchId: state.currentBranchId, setCurrentBranch: state.setCurrentBranch, transactions: state.transactions, getBaseCurrency: state.getBaseCurrency, currencies: state.currencies, inventory: state.inventory, products: state.products, customers: state.customers, users: state.users, categories: state.categories })));
  const baseCurrency = getBaseCurrency();
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories]);
  const currencyByCode = useMemo(() => new Map(currencies.map(currency => [currency.code, currency])), [currencies]);
  const branchById = useMemo(() => new Map(branches.map(branch => [branch.id, branch])), [branches]);
  const [selectedTxForDetail, setSelectedTxForDetail] = useState<Transaction | null>(null);
  const [selectedBranchFilter, setSelectedBranchFilter] = useState<string>(currentBranchId || 'all');
  const [showAllSalesModal, setShowAllSalesModal] = useState<boolean>(false);
  const [aiSummary, setAiSummary] = useState<string>("");
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [showAIGate, setShowAIGate] = useState(false);
  const [businessName, setBusinessName] = useState("tu negocio");
  const [dashboardUserName, setDashboardUserName] = useState("");

  useEffect(() => {
    let mounted = true;
    void loadSaaSContext().then((ctx) => {
      if (mounted) {
        setPlanCode(ctx?.subscription?.planCode || null);
        setBusinessName(ctx?.company?.name || "tu negocio");
        setDashboardUserName(ctx?.user?.name || "");
      }
    }).catch(() => {
      if (mounted) setPlanCode(null);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!branchPickerOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('[data-dashboard-branch-picker]')) setBranchPickerOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [branchPickerOpen]);

  const isCupCode = (code: string) => code === 'CUP' || code === 'MN' || code === 'CUC' || code === '₱';

  const formatMoney = (amount: number, symbol: string = baseCurrency.symbol, code: string = baseCurrency.code, withCode: boolean = false) => {
    const isCup = isCupCode(code) || isCupCode(symbol);
    const formatted = isCup
      ? Math.round(amount).toLocaleString('es-CU')
      : amount.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (withCode) {
      return `${code} ${symbol}${formatted}`;
    }
    return `${symbol}${formatted}`;
  };

  const isToday = (dateStr: string) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  };

  // Filter transactions based on selected branch or all
  const filteredTransactions = useMemo(() => {
    if (selectedBranchFilter === 'all') {
      return transactions;
    }
    return transactions.filter(t => t.branchId === selectedBranchFilter);
  }, [transactions, selectedBranchFilter]);

  const todayTransactions = useMemo(() => 
    filteredTransactions.filter(t => isToday(t.date)),
    [filteredTransactions]
  );

  const totalSalesToday = todayTransactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const averageTicketToday = todayTransactions.length > 0 ? totalSalesToday / todayTransactions.length : 0;

  const topCategories = useMemo(() => {
    const data: Record<string, number> = {};
    todayTransactions.forEach(tx => {
      (tx.items || []).forEach(item => {
        const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
        const prod = prodId ? productById.get(prodId) : undefined;
        const categoryId = prod?.categoryId || (typeof item.product === 'object' ? item.product?.categoryId : '') || 'unclassified';
        const category = categoryById.get(categoryId);
        const categoryName = category?.name || 'Otros';
        data[categoryName] = (data[categoryName] || 0) + (item.total || 0);
      });
    });
    return Object.entries(data)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
  }, [todayTransactions, productById, categoryById]);

  const handleGenerateAI = async () => {
    if (planCode !== "pro") { setShowAIGate(true); return; }
    setIsGeneratingAI(true);
    const summary = await getBusinessSummaryAI({
      salesToday: totalSalesToday,
      txCountToday: todayTransactions.length,
      lowStockCount,
      topCategories,
      baseCurrency: baseCurrency.code
    });
    setAiSummary(summary);
    setIsGeneratingAI(false);
  };

  const lowStockCount = useMemo(() => {
    if (selectedBranchFilter === 'all') {
      return inventory.filter(i => i.quantity <= i.minQuantity).length;
    }
    return inventory.filter(i => i.branchId === selectedBranchFilter && i.quantity <= i.minQuantity).length;
  }, [inventory, selectedBranchFilter]);

  // Chart Data: Sales last 7 days
  const last7DaysData = useMemo(() => {
    const totalsByDay = new Map<string, number>();
    for (const tx of filteredTransactions) {
      const dayKey = tx.date.slice(0, 10);
      totalsByDay.set(dayKey, (totalsByDay.get(dayKey) || 0) + (tx.total || 0));
    }

    const data = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().split('T')[0];
      data.push({
        name: d.toLocaleDateString('es-DO', { weekday: 'short' }),
        total: totalsByDay.get(dayStr) || 0
      });
    }
    return data;
  }, [filteredTransactions]);

  // Sales by Currency Today with breakdown of cash vs transfer
  const salesByCurrency = useMemo(() => {
    const totals: { 
      [key: string]: { 
        total: number; 
        cash: number; 
        transfer: number; 
        rateToBase: number; 
        symbol: string;
      } 
    } = {};

    // Initialize with all configured currencies
    currencies.forEach(c => {
      totals[c.code] = {
        total: 0,
        cash: 0,
        transfer: 0,
        rateToBase: c.rateToBase || 1,
        symbol: c.symbol
      };
    });

    todayTransactions.forEach(tx => {
      (tx.payments || []).forEach(p => {
        if (!totals[p.currencyCode]) {
          const curr = currencyByCode.get(p.currencyCode);
          totals[p.currencyCode] = {
            total: 0,
            cash: 0,
            transfer: 0,
            rateToBase: p.exchangeRate || curr?.rateToBase || 1,
            symbol: curr?.symbol || '$'
          };
        }
        totals[p.currencyCode].total += (p.amount || 0);
        if (p.method === 'transfer') {
          totals[p.currencyCode].transfer += (p.amount || 0);
        } else {
          totals[p.currencyCode].cash += (p.amount || 0);
        }
      });
    });

    return Object.entries(totals)
      .map(([code, data]) => ({
        code,
        ...data,
        baseEquivalent: code === baseCurrency.code ? data.total : data.total * (data.rateToBase || 1)
      }))
      .filter(item => item.total > 0 || item.code === baseCurrency.code);
  }, [todayTransactions, currencies, currencyByCode, baseCurrency]);

  const secondaryCurrencies = useMemo(() => currencies.filter(c => !c.isBase), [currencies]);

  // Helper function to render payment currency badges for a transaction
  const renderPaymentBadges = (tx: Transaction) => {
    const payments = tx.payments || [];
    if (payments.length === 0) {
      return (
        <span className="inline-flex items-center gap-1 text-[8.5px] font-bold px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
          <Banknote className="w-3 h-3 text-slate-400" />
          {baseCurrency.code} {baseCurrency.symbol}{formatMoney(tx.total)}
        </span>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-1">
        {payments.map((p, idx) => {
          const isTransfer = p.method === 'transfer';
          const curr = currencyByCode.get(p.currencyCode) || { symbol: '$', code: p.currencyCode };
          const formattedAmount = isCupCode(p.currencyCode)
            ? Math.round(p.amount).toLocaleString('es-CU')
            : p.amount.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

          const badgeStyles = p.currencyCode === 'USD'
            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/40'
            : p.currencyCode === 'EUR'
            ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/40'
            : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/40';

          return (
            <span 
              key={idx} 
              className={cn(
                "inline-flex items-center gap-1 text-[8.5px] font-black px-1.5 py-0.5 rounded-md border shadow-2xs",
                badgeStyles
              )}
            >
              {isTransfer ? (
                <CreditCard className="w-2.5 h-2.5 opacity-75 shrink-0" />
              ) : (
                <Banknote className="w-2.5 h-2.5 opacity-75 shrink-0" />
              )}
              <span>{p.currencyCode}</span>
              <span>{curr.symbol}{formattedAmount}</span>
              <span className="text-[7px] font-bold opacity-75 uppercase">
                {isTransfer ? 'Transf.' : 'Efec.'}
              </span>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-2.5 text-[9px] animate-in fade-in slide-in-from-bottom-2 duration-500 pb-5">

      <section className="dashboard-hero relative isolate overflow-hidden rounded-[1.6rem] border border-violet-300/20 bg-[radial-gradient(circle_at_78%_18%,rgba(139,92,246,.32),transparent_28%),radial-gradient(circle_at_15%_100%,rgba(99,102,241,.28),transparent_35%),linear-gradient(135deg,#0b0620_0%,#171044_52%,#28135f_100%)] shadow-[0_20px_60px_rgba(67,34,140,.24)] min-h-[390px] sm:min-h-[350px] lg:min-h-[365px]">
        <div className="pointer-events-none absolute inset-0 opacity-30" aria-hidden="true">
          <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full border border-violet-300/20" />
          <div className="absolute -right-5 -top-9 h-44 w-44 rounded-full border border-violet-300/15" />
          <div className="absolute right-16 top-12 h-20 w-20 rounded-full bg-violet-400/15 blur-2xl" />
          <div className="absolute bottom-0 left-1/3 h-px w-2/3 bg-gradient-to-r from-transparent via-violet-300/30 to-transparent" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] bg-[size:28px_28px]" />
        </div>

        <div className="relative z-10 grid min-h-[390px] items-center gap-6 px-5 py-6 sm:min-h-[350px] sm:grid-cols-[1.15fr_.85fr] sm:px-8 sm:py-8 lg:min-h-[365px] lg:px-10">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-200/20 bg-white/[.07] px-2.5 py-1.5 text-[8px] font-black uppercase tracking-[.16em] text-violet-100 backdrop-blur-sm">
              <Sparkles className="h-3.5 w-3.5 text-violet-300" />
              <span>PALMYRA · Centro de mando</span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.9)]" />
            </div>

            <h1 className="mt-4 text-[2.2rem] font-black leading-[.9] tracking-[-.055em] text-white sm:text-4xl lg:text-5xl">
              Hola{dashboardUserName ? ", " + dashboardUserName.split(" ")[0] : ""} <span className="text-[.62em] align-[.02em]" aria-hidden="true">👋</span>
            </h1>

            <p className="mt-2 text-base font-black tracking-[-.02em] text-white/95 sm:text-xl lg:text-2xl">
              Bienvenido a <span className="text-violet-300">{businessName}</span>
            </p>

            <p className="mt-3 max-w-[520px] text-[10px] font-medium leading-[1.55] text-violet-100/75 sm:text-xs lg:text-sm">
              Una vista ejecutiva de tu negocio. Observa el movimiento, detecta oportunidades y toma decisiones con información real.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <div className="rounded-xl border border-white/10 bg-white/[.06] px-3 py-2 backdrop-blur-sm">
                <p className="text-[7px] font-bold uppercase tracking-[.16em] text-violet-200/65">Sucursal activa</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[9px] font-black text-white">
                  <MapPin className="h-3 w-3 text-violet-300" />
                  {selectedBranchFilter === "all" ? "Todas las sucursales" : (branchById.get(selectedBranchFilter)?.name || "Sucursal")}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[.06] px-3 py-2 backdrop-blur-sm">
                <p className="text-[7px] font-bold uppercase tracking-[.16em] text-violet-200/65">Moneda base</p>
                <p className="mt-0.5 text-[9px] font-black text-white">{baseCurrency.code} · {baseCurrency.symbol}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
            <div className="rounded-2xl border border-white/10 bg-white/[.07] p-3.5 shadow-xl backdrop-blur-md">
              <p className="text-[7px] font-black uppercase tracking-[.14em] text-violet-200/65">Ventas de hoy</p>
              <p className="mt-2 text-base font-black tracking-tight text-white sm:text-lg">{formatMoney(totalSalesToday)}</p>
              <p className="mt-1 text-[8px] font-semibold text-emerald-300">Movimiento real</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.07] p-3.5 shadow-xl backdrop-blur-md">
              <p className="text-[7px] font-black uppercase tracking-[.14em] text-violet-200/65">Tickets</p>
              <p className="mt-2 text-base font-black tracking-tight text-white sm:text-lg">{todayTransactions.length}</p>
              <p className="mt-1 text-[8px] font-semibold text-violet-200">Operaciones hoy</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.07] p-3.5 shadow-xl backdrop-blur-md">
              <p className="text-[7px] font-black uppercase tracking-[.14em] text-violet-200/65">Ticket promedio</p>
              <p className="mt-2 text-base font-black tracking-tight text-white sm:text-lg">{formatMoney(averageTicketToday)}</p>
              <p className="mt-1 text-[8px] font-semibold text-violet-200">Por operación</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.07] p-3.5 shadow-xl backdrop-blur-md">
              <p className="text-[7px] font-black uppercase tracking-[.14em] text-violet-200/65">Stock bajo</p>
              <p className="mt-2 text-base font-black tracking-tight text-white sm:text-lg">{lowStockCount}</p>
              <p className="mt-1 text-[8px] font-semibold text-amber-300">Requiere atención</p>
            </div>
          </div>
        </div>
      </section>

      {/* Header */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-sm font-black text-primary tracking-tight">Dashboard</h2>
          <div className="flex flex-wrap items-center gap-2 text-muted mt-0.5">
            <div className="flex items-center gap-1">
              <MapPin className="w-3 h-3 text-indigo-500" />
              <p className="text-[9px] font-black uppercase tracking-widest">
                {selectedBranchFilter === 'all' 
                  ? 'Todas las Sucursales' 
                  : (branchById.get(selectedBranchFilter)?.name || 'Sucursal')}
              </p>
            </div>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <div className="flex items-center gap-1.5 text-[8.5px] font-bold text-slate-500 dark:text-slate-400">
              <span>Moneda Base: <strong className="text-indigo-600 dark:text-indigo-400">{baseCurrency.code} ({baseCurrency.symbol})</strong></span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center justify-end gap-1.5 w-full sm:w-auto ml-auto shrink-0">
          <button
            onClick={handleGenerateAI}
            disabled={isGeneratingAI}
            className="btn-secondary h-7 min-h-0 px-2 rounded-lg text-[8px] font-black uppercase tracking-tight gap-1.5 shadow-none"
          >
            {isGeneratingAI ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-amber-500" />}
            <span>{planCode !== "pro" && planCode ? "IA · Ciudadela" : aiSummary ? "Actualizar IA" : "Analizar con IA"}</span>
          </button>

          <div className="relative min-w-0 w-[clamp(9.5rem,28vw,12.5rem)]" data-dashboard-branch-picker>
            <button
              type="button"
              onClick={() => setBranchPickerOpen((open) => !open)}
              className="w-full min-h-7 rounded-lg bg-secondary border border-base px-2 py-1 flex items-center gap-1.5 text-left hover:border-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-100 transition-colors shadow-none"
              aria-haspopup="listbox"
              aria-expanded={branchPickerOpen}
              title="Seleccionar almacén o sucursal"
            >
              <MapPin className="w-3 h-3 shrink-0 text-indigo-500" />
              <span className="min-w-0 flex-1 text-[8px] sm:text-[8.5px] font-black text-primary leading-tight uppercase whitespace-normal break-words">
                {selectedBranchFilter === "all"
                  ? "Todas las sucursales"
                  : (branchById.get(selectedBranchFilter)?.name || "Sucursal")}
              </span>
              <ChevronDown className={cn("w-3 h-3 shrink-0 text-muted transition-transform", branchPickerOpen && "rotate-180")} />
            </button>

            {branchPickerOpen && (
              <div
                role="listbox"
                aria-label="Seleccionar almacén"
                className="absolute right-0 top-full mt-1.5 z-40 w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-base bg-secondary p-1.5 shadow-2xl"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedBranchFilter === "all"}
                  onClick={() => {
                    setSelectedBranchFilter("all");
                    setBranchPickerOpen(false);
                  }}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-left text-[8.5px] font-black uppercase leading-tight",
                    selectedBranchFilter === "all" ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" : "text-primary hover:bg-subtle"
                  )}
                >
                  🏢 Todas las sucursales
                </button>
                {branches.map((branch) => {
                  const selected = branch.id === selectedBranchFilter;
                  return (
                    <button
                      key={branch.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setSelectedBranchFilter(branch.id);
                        setCurrentBranch(branch.id);
                        setBranchPickerOpen(false);
                      }}
                      className={cn(
                        "w-full rounded-lg px-2.5 py-2 text-left text-[8.5px] font-black uppercase leading-tight whitespace-normal break-words",
                        selected ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" : "text-primary hover:bg-subtle"
                      )}
                    >
                      {branch.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>      </header>

      {showAIGate && planCode !== "pro" && (
        <div className="relative">
          <button type="button" onClick={() => setShowAIGate(false)} className="absolute right-3 top-3 z-10 text-xs font-black text-muted hover:text-primary">Cerrar</button>
          <PlanFeatureGate feature="ai_dashboard" title="Inteligencia artificial en el Dashboard" description="Obtén una lectura inteligente de ventas, categorías, inventario y señales importantes de tu negocio. Esta función está disponible desde Ciudadela." />
        </div>
      )}

      {/* AI Summary Card */}
      {aiSummary && (
        <div className="bg-indigo-600 text-white p-3 rounded-2xl shadow-xl shadow-indigo-200 dark:shadow-none border border-indigo-500 relative overflow-hidden animate-in slide-in-from-top-4 duration-500">
          <div className="absolute top-0 right-0 p-4 opacity-10">
            <Sparkles size={120} />
          </div>
          <div className="relative z-10 flex flex-col sm:flex-row items-start gap-4">
            <div className="p-3 bg-white/20 rounded-2xl shrink-0 backdrop-blur-sm border border-white/30">
              <Sparkles className="w-6 h-6 text-amber-300" />
            </div>
            <div className="flex-1">
              <h3 className="text-xs font-black uppercase tracking-[0.2em] mb-2 text-indigo-100">Visión de Negocio (IA)</h3>
              <p className="text-[10px] font-bold leading-relaxed max-w-3xl whitespace-pre-wrap">{aiSummary}</p>
            </div>
            <button 
              onClick={() => setAiSummary("")}
              className="p-1 hover:bg-white/10 rounded-lg transition-colors shrink-0"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Metrics Grid (Compact & Clear Currency Indicators) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="bg-secondary p-2.5 rounded-2xl border border-base shadow-xs hover:shadow-md transition-all flex flex-col justify-between min-w-0 overflow-hidden">
          <div className="flex justify-between items-start mb-2 gap-1">
            <div className="p-1.5 sm:p-2 rounded-xl text-white shrink-0 shadow-xs bg-indigo-600">
              <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </div>
            <div className="badge-quiet">
              Hoy
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-[8px] font-black text-muted uppercase tracking-widest mb-0.5 truncate">Ventas Hoy</p>
            <div className="flex items-baseline gap-1">
              <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300">
                {baseCurrency.code}
              </span>
              <h4 className="text-sm font-black text-primary tracking-tight truncate tabular-nums">
                {baseCurrency.symbol}{formatMoney(totalSalesToday)}
              </h4>
            </div>
            {secondaryCurrencies.length > 0 && totalSalesToday > 0 && (
              <div className="mt-1 text-[8px] font-bold text-muted flex flex-wrap gap-1.5 tabular-nums">
                {secondaryCurrencies.map(c => (
                  <span key={c.code} className="whitespace-nowrap">
                    ≈ {c.code} {c.symbol}{(totalSalesToday / (c.rateToBase || 1)).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <MetricCard 
          title="Tickets Emitidos" 
          value={todayTransactions.length.toString()} 
          subtitle={todayTransactions.length > 0 ? `Promedio: ${baseCurrency.code} ${baseCurrency.symbol}${formatMoney(averageTicketToday)}` : 'Sin ventas hoy'}
          icon={ShoppingBag} 
          trend="Hoy" 
          positive={true}
          color="bg-emerald-600"
        />

        <MetricCard 
          title="Stock Bajo" 
          value={lowStockCount.toString()} 
          subtitle={lowStockCount > 0 ? "Productos por reponer" : "Inventario estable"}
          icon={Package} 
          trend={lowStockCount > 0 ? "Revisar" : "OK"} 
          positive={lowStockCount === 0}
          color="bg-rose-600"
        />

        <MetricCard 
          title="Clientes" 
          value={customers.length.toString()} 
          subtitle="Registrados en el sistema"
          icon={Users} 
          trend="Total" 
          positive={true}
          color="bg-blue-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5">
        {/* Sales Chart (Compact) */}
        <div className="lg:col-span-2 bg-secondary p-3 rounded-2xl border border-base shadow-xs">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h3 className="text-sm font-black text-primary uppercase tracking-widest">Evolución Semanal</h3>
              <p className="text-[9px] font-bold text-muted uppercase tracking-[0.2em]">Últimos 7 días · {baseCurrency.code}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black text-muted uppercase">Total 7 Días</p>
              <p className="text-sm font-black text-indigo-600 dark:text-indigo-400">
                {baseCurrency.code} {formatMoney(last7DaysData.reduce((sum, d) => sum + d.total, 0))}
              </p>
            </div>
          </div>
          
          <div className="h-48 w-full min-w-0 relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
              <AreaChart data={last7DaysData}>
                <defs>
                  <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-base)" opacity={0.5} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: 'var(--text-muted)', fontSize: 8, fontWeight: 900}} />
                <YAxis hide />
                <Tooltip 
                  contentStyle={{
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: '12px', 
                    border: '1px solid var(--border-base)', 
                    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', 
                    fontSize: '10px', 
                    fontWeight: '900',
                    color: 'var(--text-primary)'
                  }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-muted)', marginBottom: '4px' }}
                  formatter={(value: number) => [`${baseCurrency.code} ${formatMoney(value)}`, 'Ventas']}
                />
                <Area type="monotone" dataKey="total" stroke="#4f46e5" strokeWidth={3} fillOpacity={1} fill="url(#colorTotal)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Currency Breakdown (Detailed Sales by Currency & Payment Method) */}
        <div className="bg-secondary p-3 rounded-2xl border border-base flex flex-col shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-black uppercase tracking-widest text-primary">Recaudación por Moneda</h3>
              <p className="text-[8px] font-bold text-muted uppercase">Pagos recibidos hoy</p>
            </div>
            <div className="w-6 h-6 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
              <DollarSign className="w-3.5 h-3.5" />
            </div>
          </div>
          
          <div className="space-y-2.5 flex-1">
            {salesByCurrency.length > 0 ? salesByCurrency.map(sale => {
              const isBase = sale.code === baseCurrency.code;
              const badgeBg = sale.code === 'USD'
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/40'
                : sale.code === 'EUR'
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/40'
                : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/40';

              return (
                <div key={sale.code} className="bg-subtle p-3 rounded-2xl border border-base flex flex-col gap-2 group hover:border-indigo-500/30 transition-all">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={cn("px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-wider border shadow-2xs", badgeBg)}>
                        {sale.code}
                      </span>
                      {isBase && (
                        <span className="text-[7.5px] font-black uppercase text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 px-1 py-0.2 rounded">
                          Base
                        </span>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-black text-primary leading-tight">
                        {sale.symbol}{formatMoney(sale.total, sale.symbol, sale.code)}
                      </p>
                    </div>
                  </div>

                  {/* Breakdown by Method: Cash vs Transfer */}
                  <div className="flex items-center justify-between text-[8px] font-bold text-muted pt-1 border-t border-base/60">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <Banknote className="w-2.5 h-2.5 text-slate-400" />
                        <span>Efec: {sale.symbol}{formatMoney(sale.cash, sale.symbol, sale.code)}</span>
                      </span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-0.5">
                        <CreditCard className="w-2.5 h-2.5 text-slate-400" />
                        <span>Transf: {sale.symbol}{formatMoney(sale.transfer, sale.symbol, sale.code)}</span>
                      </span>
                    </div>
                    {!isBase && sale.total > 0 && (
                      <span className="font-black text-indigo-600 dark:text-indigo-400">
                        ≈ {baseCurrency.code} ${Math.round(sale.baseEquivalent).toLocaleString('es-CU')}
                      </span>
                    )}
                  </div>
                </div>
              );
            }) : (
              <div className="flex-1 flex flex-col items-center justify-center opacity-40 py-8 text-muted">
                <DollarSign className="w-8 h-8" />
                <p className="text-[9px] font-black uppercase tracking-widest mt-1">Sin ingresos registrados</p>
              </div>
            )}
          </div>
          
          <div className="mt-4 pt-3.5 border-t border-base">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-[8px] font-black uppercase text-muted tracking-widest">Total Equivalente Hoy</p>
                <p className="text-[8px] font-bold text-slate-400">Sumatoria en moneda base</p>
              </div>
              <div className="text-right">
                <span className="text-[8.5px] font-black uppercase text-indigo-600 dark:text-indigo-400 mr-1">
                  {baseCurrency.code}
                </span>
                <span className="text-sm font-black text-indigo-600 dark:text-indigo-400">
                  {baseCurrency.symbol}{formatMoney(totalSalesToday)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {/* Branch Performance */}
        <div className="bg-secondary p-3 rounded-2xl border border-base shadow-xs col-span-1 md:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-widest">Desempeño por Sucursal</h3>
              <p className="text-[8px] font-bold text-muted uppercase">Ventas acumuladas · {baseCurrency.code}</p>
            </div>
            <span className="text-[8px] font-black text-muted uppercase tracking-widest bg-subtle px-2 py-1 rounded-lg border border-base">
              {branches.length} Sucursales
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {branches.map(branch => {
              const branchTx = transactions.filter(t => t.branchId === branch.id);
              const branchTotal = branchTx.reduce((sum, t) => sum + (t.total || 0), 0);
              const branchSalesCount = branchTx.length;
              const allTxSum = transactions.reduce((s,t) => s + (t.total || 0), 0) || 1;
              const percentage = Math.min(100, Math.round((branchTotal / allTxSum) * 100));
              
              return (
                <div key={branch.id} className="p-4 bg-subtle rounded-2xl border border-base group hover:border-indigo-500/50 transition-all flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 rounded-lg flex items-center justify-center shrink-0">
                          <MapPin className="w-3 h-3" />
                        </div>
                        <p className="text-[10px] font-black text-primary uppercase tracking-tight truncate">{branch.name}</p>
                      </div>
                      <span className="text-[8px] font-black text-slate-500 dark:text-slate-400 bg-secondary px-1.5 py-0.5 rounded border border-base">
                        {percentage}%
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-end">
                        <p className="text-[8px] font-black text-muted uppercase tracking-widest">Ventas Totales</p>
                        <p className="text-xs font-black text-indigo-600 dark:text-indigo-400">
                          <span className="text-[7.5px] font-bold text-muted mr-1">{baseCurrency.code}</span>
                          {formatMoney(branchTotal)}
                        </p>
                      </div>
                      <div className="flex justify-between items-end">
                        <p className="text-[8px] font-black text-muted uppercase tracking-widest">Transacciones</p>
                        <p className="text-[10px] font-black text-primary">{branchSalesCount} tickets</p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3.5 h-1.5 bg-secondary border border-base rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Sales with explicit Currencies and Payment Methods */}
        <div className="bg-secondary p-5 rounded-3xl border border-base shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-widest">Últimas Ventas</h3>
              <p className="text-[8px] font-bold text-muted uppercase">Detalle de moneda y método de cobro</p>
            </div>
            {todayTransactions.length > 4 && (
              <button 
                onClick={() => setShowAllSalesModal(true)}
                className="text-[8.5px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest hover:underline flex items-center gap-0.5"
              >
                <span>Ver Todas ({todayTransactions.length})</span>
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
          
          <div className="space-y-2.5">
            {todayTransactions.length > 0 ? todayTransactions.slice(0, 5).map(tx => {
              const customer = customers.find(c => c.id === tx.customerId);
              const cashier = users.find(u => u.id === tx.userId);
              const itemCount = (tx.items || []).reduce((sum, item) => sum + (item.quantity || 1), 0);

              return (
                <div 
                  key={tx.id} 
                  onClick={() => setSelectedTxForDetail(tx)}
                  className="p-2.5 bg-subtle hover:bg-slate-100 dark:hover:bg-slate-800/80 rounded-2xl border border-base transition-all cursor-pointer group flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-xl bg-secondary border border-base flex items-center justify-center text-primary group-hover:border-indigo-500/40">
                        <Receipt className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-[10px] font-black text-primary uppercase tracking-tighter">
                            #{tx.id.slice(-6)}
                          </p>
                          <span className="text-[7.5px] font-bold text-muted bg-secondary px-1 py-0.2 rounded border border-base">
                            {itemCount} {itemCount === 1 ? 'artículo' : 'artículos'}
                          </span>
                        </div>
                        <p className="text-[7.5px] font-bold text-muted uppercase">
                          {new Date(tx.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {customer ? ` · ${customer.name}` : ''}
                          {cashier ? ` · ${cashier.name}` : (tx.cashierName ? ` · ${tx.cashierName}` : '')}
                        </p>
                      </div>
                    </div>

                    <div className="text-right">
                      <p className="text-[11px] font-black text-primary">
                        <span className="text-[8px] font-bold text-indigo-600 dark:text-indigo-400 mr-0.5">{baseCurrency.code}</span>
                        {formatMoney(tx.total)}
                      </p>
                      <span className="text-[7px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest inline-flex items-center gap-0.5">
                        <CheckCircle2 className="w-2.5 h-2.5" /> Cobrado
                      </span>
                    </div>
                  </div>

                  {/* Payment Currencies Breakdown */}
                  <div className="flex items-center justify-between pt-1 border-t border-base/50">
                    <div className="flex-1 overflow-x-auto no-scrollbar">
                      {renderPaymentBadges(tx)}
                    </div>
                    <button 
                      type="button"
                      className="text-[7.5px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0 ml-1"
                    >
                      <Eye className="w-2.5 h-2.5" />
                      Ver ticket
                    </button>
                  </div>
                </div>
              );
            }) : (
              <div className="flex flex-col items-center justify-center py-8 text-muted opacity-40">
                <ShoppingBag className="w-8 h-8" />
                <p className="text-[9px] font-black uppercase tracking-widest mt-2">No hay ventas registradas hoy</p>
              </div>
            )}
          </div>
        </div>

        {/* Low Stock (Compact) */}
        <div className="bg-secondary p-5 rounded-3xl border border-base shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xs font-black text-rose-600 dark:text-rose-400 uppercase tracking-widest">Stock Crítico</h3>
              <p className="text-[8px] font-bold text-muted uppercase">Requieren reposición inmediata</p>
            </div>
            <span className="text-[8px] font-black text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 px-2 py-0.5 rounded-lg border border-rose-200 dark:border-rose-900/40">
              {lowStockCount} alertas
            </span>
          </div>
          <div className="space-y-2">
            {inventory
              .filter(i => (selectedBranchFilter === 'all' || i.branchId === selectedBranchFilter) && i.quantity <= i.minQuantity)
              .slice(0, 4)
              .map(item => {
                const product = products.find(p => p.id === item.productId);
                const branch = branches.find(b => b.id === item.branchId);
                return (
                  <div key={`${item.branchId}-${item.productId}-${item.variantLabel || ''}`} className="flex items-center gap-3 p-2.5 bg-rose-50/30 dark:bg-rose-950/20 rounded-xl border border-rose-100/50 dark:border-rose-900/30">
                    <div className="w-7 h-7 rounded-lg bg-rose-100 dark:bg-rose-900/50 flex items-center justify-center shrink-0">
                      <AlertCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-black text-primary uppercase tracking-tighter truncate">{product?.name || 'Producto'}</p>
                      <p className="text-[7.5px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest">
                        Quedan: <strong>{item.quantity}</strong> {product?.unit || 'u.'} (Mín: {item.minQuantity})
                        {selectedBranchFilter === 'all' && branch ? ` · ${branch.name}` : ''}
                      </p>
                    </div>
                    <div className="w-12 h-1 bg-secondary border border-base rounded-full overflow-hidden shrink-0">
                      <div 
                        className="h-full bg-rose-500 rounded-full" 
                        style={{width: `${Math.min(100, (item.quantity / (item.minQuantity || 1)) * 100)}%`}}
                      />
                    </div>
                  </div>
                );
              })}
            {lowStockCount === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-muted">
                <Package className="w-8 h-8 opacity-20" />
                <p className="text-[9px] font-black uppercase tracking-widest mt-2">Inventario en niveles óptimos</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal: Detalle Completo del Ticket de Venta */}
      {selectedTxForDetail && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-[2rem] max-w-lg w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                  <Receipt className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight">
                    Detalle de Venta #{selectedTxForDetail.id.slice(-8)}
                  </h3>
                  <p className="text-[8.5px] font-bold text-slate-500 uppercase">
                    {new Date(selectedTxForDetail.date).toLocaleString('es-CU')}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setSelectedTxForDetail(null)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* General Info */}
            <div className="grid grid-cols-2 gap-2 text-[9px] bg-slate-50 dark:bg-slate-800/50 p-3 rounded-2xl border border-slate-100 dark:border-slate-800">
              <div>
                <span className="text-slate-400 font-bold uppercase block text-[7.5px]">Sucursal</span>
                <span className="font-black text-slate-800 dark:text-slate-200">
                  {branches.find(b => b.id === selectedTxForDetail.branchId)?.name || 'Sucursal Principal'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 font-bold uppercase block text-[7.5px]">Cajero / Vendedor</span>
                <span className="font-black text-slate-800 dark:text-slate-200">
                  {users.find(u => u.id === selectedTxForDetail.userId)?.name || selectedTxForDetail.cashierName || 'Vendedor'}
                </span>
              </div>
              {selectedTxForDetail.customerId && (
                <div className="col-span-2 pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
                  <span className="text-slate-400 font-bold uppercase block text-[7.5px]">Cliente</span>
                  <span className="font-black text-slate-800 dark:text-slate-200">
                    {customers.find(c => c.id === selectedTxForDetail.customerId)?.name || 'Cliente'}
                  </span>
                </div>
              )}
            </div>

            {/* Products List */}
            <div>
              <h4 className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Artículos Vendidos</h4>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {(selectedTxForDetail.items || []).map((item, idx) => {
                  const prod = products.find(p => p.id === (typeof item.product === 'string' ? item.product : item.product?.id));
                  const name = prod?.name || item.product?.name || 'Producto';
                  const price = item.price || 0;
                  const qty = item.quantity || 1;
                  const itemTotal = price * qty;

                  return (
                    <div key={idx} className="flex justify-between items-center p-2 rounded-xl bg-slate-50 dark:bg-slate-800/40 text-[9.5px]">
                      <div className="min-w-0 pr-2">
                        <p className="font-black text-slate-800 dark:text-slate-200 truncate">{name}</p>
                        <p className="text-[8px] text-slate-500 font-bold">
                          {qty} x {baseCurrency.code} ${price.toLocaleString('es-CU')}
                          {item.variantLabel ? ` · ${item.variantLabel}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0 font-black text-slate-900 dark:text-white">
                        {baseCurrency.code} ${itemTotal.toLocaleString('es-CU')}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Payment & Currency Breakdown Section */}
            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <h4 className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                Detalle de Monedas y Métodos de Cobro
              </h4>
              <div className="space-y-1.5">
                {(selectedTxForDetail.payments || []).map((p, idx) => {
                  const curr = currencies.find(c => c.code === p.currencyCode) || { symbol: '$', code: p.currencyCode, rateToBase: 1 };
                  const rate = p.exchangeRate || curr.rateToBase || 1;
                  const equivInBase = p.currencyCode === baseCurrency.code ? p.amount : p.amount * rate;
                  const isTransfer = p.method === 'transfer';

                  return (
                    <div key={idx} className="p-2.5 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40 flex items-center justify-between text-[9px]">
                      <div className="flex items-center gap-2">
                        <div className="p-1 rounded-lg bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300">
                          {isTransfer ? <CreditCard className="w-3.5 h-3.5" /> : <Banknote className="w-3.5 h-3.5" />}
                        </div>
                        <div>
                          <span className="font-black uppercase text-indigo-900 dark:text-indigo-200 block">
                            {p.currencyCode} {curr.symbol}{p.amount.toLocaleString('es-CU', { minimumFractionDigits: isCupCode(p.currencyCode) ? 0 : 2 })}
                          </span>
                          <span className="text-[7.5px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">
                            {isTransfer ? 'Transferencia Bancaria' : 'Efectivo'} 
                            {p.currencyCode !== baseCurrency.code ? ` · Tasa: $${rate} CUP` : ''}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[7.5px] font-bold text-slate-400 block uppercase">Equivalente Base</span>
                        <span className="font-black text-slate-900 dark:text-white">
                          {baseCurrency.code} ${Math.round(equivInBase).toLocaleString('es-CU')}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {/* Change details if given */}
                {selectedTxForDetail.changeGiven && selectedTxForDetail.changeGiven > 0 && (
                  <div className="p-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 flex items-center justify-between text-[9px]">
                    <span className="font-bold text-amber-800 dark:text-amber-300">↩ Vuelto Entregado:</span>
                    <span className="font-black text-amber-900 dark:text-amber-200">
                      {baseCurrency.code} ${Math.round(selectedTxForDetail.changeGiven).toLocaleString('es-CU')}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Total Footer */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <div>
                <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 block">Total de la Venta</span>
                <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">Transacción Completada</span>
              </div>
              <div className="text-right">
                <span className="text-sm font-black text-slate-900 dark:text-white">
                  <span className="text-[10px] text-indigo-600 dark:text-indigo-400 mr-1">{baseCurrency.code}</span>
                  {baseCurrency.symbol}{formatMoney(selectedTxForDetail.total)}
                </span>
              </div>
            </div>

            <button 
              onClick={() => setSelectedTxForDetail(null)}
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-black text-xs uppercase tracking-wider transition-colors"
            >
              Cerrar Detalle
            </button>
          </div>
        </div>
      )}

      {/* Modal: Todas las Ventas del Día */}
      {showAllSalesModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-[2rem] max-w-2xl w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 animate-in zoom-in-95 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight">
                  Ventas de Hoy ({todayTransactions.length})
                </h3>
                <p className="text-[8.5px] font-bold text-slate-500 uppercase">
                  Detalle de monedas y pagos registrados
                </p>
              </div>
              <button 
                onClick={() => setShowAllSalesModal(false)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {todayTransactions.map(tx => {
                const customer = customers.find(c => c.id === tx.customerId);
                const cashier = users.find(u => u.id === tx.userId);
                const itemCount = (tx.items || []).reduce((sum, item) => sum + (item.quantity || 1), 0);

                return (
                  <div 
                    key={tx.id}
                    onClick={() => {
                      setSelectedTxForDetail(tx);
                      setShowAllSalesModal(false);
                    }}
                    className="p-3 bg-slate-50 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl border border-slate-200/60 dark:border-slate-700/60 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-2 group"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black text-slate-900 dark:text-white">#{tx.id.slice(-8)}</span>
                        <span className="text-[8px] font-bold text-slate-500 bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700">
                          {new Date(tx.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="text-[8px] font-bold text-indigo-600 dark:text-indigo-400">
                          {itemCount} {itemCount === 1 ? 'artículo' : 'artículos'}
                        </span>
                      </div>
                      <p className="text-[8px] text-slate-500 font-bold">
                        {cashier?.name || tx.cashierName || 'Vendedor'} 
                        {customer ? ` · Cliente: ${customer.name}` : ''}
                      </p>
                      <div className="pt-0.5">
                        {renderPaymentBadges(tx)}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-sm font-black text-slate-900 dark:text-white">
                        <span className="text-[8.5px] text-indigo-600 dark:text-indigo-400 mr-1">{baseCurrency.code}</span>
                        {baseCurrency.symbol}{formatMoney(tx.total)}
                      </p>
                      <span className="text-[8px] font-bold text-indigo-600 dark:text-indigo-400 group-hover:underline flex items-center justify-end gap-0.5">
                        <Eye className="w-2.5 h-2.5" /> Ver detalle
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
              <button 
                onClick={() => setShowAllSalesModal(false)}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-black text-xs uppercase tracking-wider transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ title, value, subtitle, icon: Icon, trend, positive, color }: any) {
  return (
    <div className="bg-secondary p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl border border-base shadow-xs hover:shadow-md transition-all flex flex-col justify-between min-w-0 overflow-hidden">
      <div className="flex justify-between items-start mb-2 sm:mb-3 gap-1">
        <div className={cn("p-1.5 sm:p-2 rounded-xl text-white shrink-0 shadow-xs", color)}>
          <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </div>
        <div className="badge-quiet">
          {trend}
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[8px] font-black text-muted uppercase tracking-widest mb-0.5 truncate">{title}</p>
        <h4 className="text-sm font-black text-primary tracking-tight truncate tabular-nums">{value}</h4>
        {subtitle && (
          <p className="text-[7.5px] font-bold text-muted truncate mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

