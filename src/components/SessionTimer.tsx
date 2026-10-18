import { cn } from '@/lib/utils';
import { Clock } from 'lucide-react';

interface SessionTimerProps {
  elapsed: number;
  total: number;
  isRunning: boolean;
}

export function SessionTimer({ elapsed, total, isRunning }: SessionTimerProps) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className={cn(
      "inline-flex items-center gap-1.5 text-xs font-mono rounded-md px-2 py-1 border border-border bg-card/50",
      isRunning ? "text-primary" : "text-muted-foreground"
    )}>
      <Clock className="w-3 h-3" />
      <span>{formatTime(elapsed)}</span>
      <span className="text-muted-foreground/60">/</span>
      <span className="text-muted-foreground">{formatTime(total)}</span>
      {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
    </div>
  );
}
