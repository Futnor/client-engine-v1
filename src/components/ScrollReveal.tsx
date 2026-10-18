import { ReactNode } from 'react';
import { useScrollReveal } from '@/hooks/useScrollReveal';
import { cn } from '@/lib/utils';

type Direction = 'up' | 'down' | 'left' | 'right' | 'scale';

interface ScrollRevealProps {
  children: ReactNode;
  direction?: Direction;
  delay?: number;
  duration?: number;
  className?: string;
  once?: boolean;
}

const directionMap: Record<Direction, string> = {
  up: 'translate3d(0, 32px, 0)',
  down: 'translate3d(0, -32px, 0)',
  left: 'translate3d(32px, 0, 0)',
  right: 'translate3d(-32px, 0, 0)',
  scale: 'scale(0.92)',
};

export function ScrollReveal({
  children,
  direction = 'up',
  delay = 0,
  duration = 600,
  className,
  once = true,
}: ScrollRevealProps) {
  const { ref, isVisible } = useScrollReveal<HTMLDivElement>({ once });

  return (
    <div
      ref={ref}
      className={cn(className)}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translate3d(0,0,0) scale(1)' : directionMap[direction],
        transition: `opacity ${duration}ms cubic-bezier(0.23, 1, 0.32, 1) ${delay}ms, transform ${duration}ms cubic-bezier(0.23, 1, 0.32, 1) ${delay}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}
