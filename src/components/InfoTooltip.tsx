import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface InfoTooltipProps {
  text: string;
  className?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export function InfoTooltip({ 
  text, 
  className, 
  position = 'top' 
}: InfoTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!isVisible || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const bubble = bubbleRef.current;
      const width = bubble?.offsetWidth || Math.min(280, window.innerWidth - 20);
      const height = bubble?.offsetHeight || 0;
      const gap = 10;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
      let top = rect.top - height - gap;
      if (top < 10) top = rect.bottom + gap;
      if (top + height > window.innerHeight - 10) top = Math.max(10, window.innerHeight - height - 10);
      setCoords({ top, left });
    };
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (triggerRef.current && !triggerRef.current.parentElement?.contains(event.target as Node)) {
        setIsVisible(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsVisible(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isVisible]);

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <div
        ref={triggerRef}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') setIsVisible(true); }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') setIsVisible(false); }}
        onClick={(event) => {
          event.stopPropagation();
          setIsVisible(prev => !prev);
        }}
        onFocus={() => setIsVisible(true)}
        onBlur={() => setIsVisible(false)}
        className="-m-1.5 flex h-9 w-9 cursor-help items-center justify-center rounded-full text-muted transition-colors hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        aria-label="Ver información"
        role="button"
        tabIndex={0}
        aria-expanded={isVisible}
      >
        <HelpCircle className="w-4 h-4" />
      </div>

      <AnimatePresence>
        {isVisible && (
          <motion.div
            ref={bubbleRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="palmyra-tooltip pointer-events-none fixed z-[var(--z-tooltip)] w-[min(17.5rem,calc(100vw-20px))] px-2.5 py-2 text-left break-words whitespace-normal sm:w-[min(20rem,calc(100vw-24px))] sm:px-3 sm:py-2.5"
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              maxHeight: 'min(40vh, 12rem)',
              overflowY: 'auto',
            }}
          >
            {text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
