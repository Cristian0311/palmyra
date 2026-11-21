import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

export type SettingsNavTab = { id: string; label: string; detail: string; icon: LucideIcon };
export type SettingsNavGroup = { id: string; label: string; tabs: SettingsNavTab[] };

type Props = { groups: SettingsNavGroup[]; activeTab: string };

export function SettingsSectionNav({ groups, activeTab }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setOverflow({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    sync();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [sync]);

  useEffect(() => {
    const el = scrollerRef.current;
    const active = activeRef.current;
    if (!el || !active) return;
    const target = active.offsetLeft - (el.clientWidth - active.clientWidth) / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [activeTab]);

  const move = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  return (
    <nav aria-label="Secciones de configuración" className="sticky top-0 z-20 -mx-1 min-w-0 rounded-2xl bg-primary/85 px-1 py-1 backdrop-blur">
      <div className="relative min-w-0">
        <div
          ref={scrollerRef}
          onScroll={sync}
          className="custom-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto scroll-smooth rounded-2xl border border-base bg-secondary p-1.5"
        >
          {groups.map((group, groupIndex) => (
            <Fragment key={group.id}>
              {groupIndex > 0 && <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-[var(--border-base)]" />}
              {group.tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <Link
                    key={tab.id}
                    ref={isActive ? activeRef : undefined}
                    to={`?section=${tab.id}`}
                    aria-current={isActive ? 'page' : undefined}
                    title={`${tab.label} · ${tab.detail}`}
                    className={cn(
                      'flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3 text-sm font-semibold transition-colors',
                      isActive
                        ? 'bg-violet-600 text-white shadow-sm'
                        : 'text-secondary hover:bg-subtle hover:text-primary',
                    )}
                  >
                    <tab.icon size={15} className="shrink-0" />
                    {tab.label}
                  </Link>
                );
              })}
            </Fragment>
          ))}
        </div>

        {overflow.left && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center rounded-l-2xl bg-gradient-to-r from-secondary via-secondary/95 to-transparent pl-0.5 pr-8">
            <button
              type="button"
              onClick={() => move(-1)}
              aria-label="Ver secciones anteriores"
              title="Ver secciones anteriores"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-xl border border-base bg-primary text-primary shadow-sm transition-colors hover:bg-subtle"
            >
              <ChevronLeft size={17} />
            </button>
          </div>
        )}
        {overflow.right && (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-2xl bg-gradient-to-l from-secondary via-secondary/95 to-transparent pl-8 pr-0.5">
            <button
              type="button"
              onClick={() => move(1)}
              aria-label="Ver más secciones"
              title="Ver más secciones"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-xl border border-base bg-primary text-primary shadow-sm transition-colors hover:bg-subtle"
            >
              <ChevronRight size={17} />
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
