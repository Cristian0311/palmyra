import { cn } from '../../lib/utils';

const AVATAR_PALETTE = [
  'from-violet-500 to-fuchsia-500',
  'from-indigo-500 to-violet-500',
  'from-fuchsia-500 to-rose-500',
  'from-purple-600 to-indigo-500',
  'from-violet-600 to-sky-500',
  'from-rose-500 to-amber-500',
  'from-teal-500 to-emerald-500',
  'from-blue-600 to-violet-500'
];

export function employeeInitials(name: string) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function employeeAvatarGradient(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

type Props = {
  name: string;
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  pending?: boolean;
  inShift?: boolean;
  className?: string;
};

const SIZE_CLASS = {
  sm: 'h-8 w-8 text-[10px] rounded-xl',
  md: 'h-10 w-10 text-[11px] rounded-2xl',
  lg: 'h-14 w-14 text-lg rounded-[18px]'
};

const DOT_CLASS = {
  sm: 'h-2 w-2 -bottom-0 -right-0',
  md: 'h-2.5 w-2.5 -bottom-0.5 -right-0.5 border-2',
  lg: 'h-3.5 w-3.5 -bottom-0.5 -right-0.5 border-2'
};

export default function EmployeeAvatar({
  name,
  seed,
  size = 'md',
  active = true,
  pending = false,
  inShift = false,
  className
}: Props) {
  const gradient = employeeAvatarGradient(seed || name || 'palmyra');
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center bg-gradient-to-br font-black text-white shadow-sm ring-1 ring-black/5',
        gradient,
        SIZE_CLASS[size],
        !active && 'grayscale opacity-55',
        className
      )}
      aria-hidden="true"
    >
      {employeeInitials(name)}
      {(inShift || pending || !active) && (
        <span
          className={cn(
            'absolute rounded-full border-white dark:border-slate-900',
            DOT_CLASS[size],
            inShift ? 'bg-emerald-500' : pending ? 'bg-amber-400' : 'bg-slate-400'
          )}
          title={inShift ? 'En turno' : pending ? 'Invitación pendiente' : 'Inactivo'}
        />
      )}
    </span>
  );
}
