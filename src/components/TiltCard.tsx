import { ReactNode } from 'react';
import { useMouseTilt } from '@/hooks/useMouseTilt';
import { cn } from '@/lib/utils';

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  maxTilt?: number;
  scale?: number;
  glare?: boolean;
}

export function TiltCard({ children, className, maxTilt = 5, scale = 1.01, glare = true }: TiltCardProps) {
  const { ref, style, onMouseMove, onMouseLeave } = useMouseTilt<HTMLDivElement>(maxTilt, scale);

  return (
    <div
      ref={ref}
      style={style}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={cn('relative overflow-hidden', className)}
    >
      {children}
      {glare && (
        <div
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          style={{
            background: 'radial-gradient(600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), hsl(var(--primary) / 0.06), transparent 40%)',
          }}
        />
      )}
    </div>
  );
}
