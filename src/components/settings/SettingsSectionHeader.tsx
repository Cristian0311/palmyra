import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type Props = {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  action?: ReactNode;
};

export function SettingsSectionHeader({ icon: Icon, title, subtitle, action }: Props) {
  return (
    <header className="border-b border-base pb-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 rounded-xl bg-violet-100 p-2 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-tight text-primary break-words">{title}</h3>
          <p className="mt-0.5 text-sm font-medium leading-snug text-muted">{subtitle}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </header>
  );
}
