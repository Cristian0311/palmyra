import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store/useStore';

export const PENDING_QUOTE_STORAGE_KEY = 'palmyra_pending_quote_id';
const PENDING_QUOTE_EVENT = 'palmyra:pending-quote-changed';

function readPendingQuoteId(): string | null {
  try {
    return localStorage.getItem(PENDING_QUOTE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setPendingQuoteId(id: string | null) {
  try {
    if (id) localStorage.setItem(PENDING_QUOTE_STORAGE_KEY, id);
    else localStorage.removeItem(PENDING_QUOTE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private mode; the in-memory state still works.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PENDING_QUOTE_EVENT, { detail: id }));
  }
}

/**
 * Keeps the quote that was handed off from Cotizaciones visible for as long as
 * its items remain in the ticket. It never relies on a transient toast, so the
 * quote cannot stay "in the air" without an explicit way to cancel it.
 */
export function usePendingQuote() {
  const [quoteId, setQuoteId] = useState<string | null>(readPendingQuoteId);
  const quotes = useStore(state => state.quotes);
  const cartCount = useStore(state => state.cart.length);
  const clearCart = useStore(state => state.clearCart);
  const sawCartItems = useRef(false);

  useEffect(() => {
    const sync = (event?: Event) => {
      const next = event instanceof CustomEvent ? (event.detail as string | null) : readPendingQuoteId();
      setQuoteId(next ?? null);
    };
    window.addEventListener(PENDING_QUOTE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PENDING_QUOTE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const quote = useMemo(
    () => (quoteId ? quotes.find(item => item.id === quoteId) || null : null),
    [quoteId, quotes]
  );

  // A converted or removed quote no longer belongs to the ticket. If the quote was
  // deleted (here or on another device), the items imported from it must not
  // survive in the cart: opening POS after deleting a quote shows an empty ticket.
  useEffect(() => {
    if (!quoteId) return;
    if (quote) {
      if (quote.status !== 'converted') return;
      setPendingQuoteId(null);
      return;
    }
    sawCartItems.current = false;
    if (cartCount > 0) clearCart();
    setPendingQuoteId(null);
  }, [quoteId, quote, cartCount, clearCart]);

  // If the cashier empties the ticket, the handoff is finished. The ref keeps
  // this from firing before Zustand rehydrates a persisted ticket on reload.
  useEffect(() => {
    if (!quoteId) return;
    if (cartCount > 0) {
      sawCartItems.current = true;
      return;
    }
    if (!sawCartItems.current) return;
    sawCartItems.current = false;
    setPendingQuoteId(null);
  }, [quoteId, cartCount]);

  const cancel = useCallback(() => {
    sawCartItems.current = false;
    clearCart();
    setPendingQuoteId(null);
  }, [clearCart]);

  return {
    quoteId,
    quote,
    isLoaded: Boolean(quoteId && quote && quote.status !== 'converted'),
    cancel
  };
}
