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
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!isVisible || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const width = Math.min(320, Math.max(192, window.innerWidth - 24));
      const gap = 8;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      let top = rect.top - gap;
      if (top < 12) top = rect.bottom + gap;
      setCoords({ top, left });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isVisible]);

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <div
        ref={triggerRef}
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onClick={() => setIsVisible(prev => !prev)}
        onFocus={() => setIsVisible(true)}
        onBlur={() => setIsVisible(false)}
        className="cursor-help text-slate-400 hover:text-indigo-500 transition-colors p-0.5"
        aria-label="Ver información"
        role="button"
        tabIndex={0}
      >
        <HelpCircle className="w-4 h-4" />
      </div>

      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="fixed z-[100000] p-2.5 bg-slate-800 text-white text-[10px] leading-4 rounded-xl shadow-2xl pointer-events-none text-center whitespace-normal break-words"
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              width: 'min(20rem, calc(100vw - 24px))',
              maxHeight: 'min(50vh, 14rem)',
              overflowY: 'auto',
            }}
          >
            {text}
            <div className="hidden" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
