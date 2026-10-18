import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter';
import { CircularProgress } from '@/components/CircularProgress';

interface StatCardProps {
  label: string;
  value: number;
  max?: number;
  icon: LucideIcon;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'accent';
}

const variantStyles = {
  default: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  accent: 'text-accent',
};

export function StatCard({ label, value, max, icon: Icon, variant = 'default' }: StatCardProps) {
  const animatedValue = useAnimatedCounter(value);

  return (
    <div className="glass rounded-xl p-5 space-y-3 animate-fade-in">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground font-medium">{label}</span>
        <Icon className={cn('w-5 h-5', variantStyles[variant])} />
      </div>
      <div className="flex items-center gap-3">
        {max ? (
          <CircularProgress value={value} max={max} size={48} strokeWidth={4} variant={variant}>
            <span className={cn('text-[10px] font-bold font-mono', variantStyles[variant])}>
              {Math.round(Math.min((value / max) * 100, 100))}%
            </span>
          </CircularProgress>
        ) : null}
        <div className="flex items-baseline gap-2">
          <span className={cn('text-3xl font-bold font-mono', variantStyles[variant])}>
            {animatedValue}
          </span>
          {max && (
            <span className="text-muted-foreground text-sm">/ {max}</span>
          )}
        </div>
      </div>
    </div>
  );
}
