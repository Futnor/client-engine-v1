import { useCallback, useRef, useState } from 'react';

interface TiltState {
  rotateX: number;
  rotateY: number;
  scale: number;
}

const defaultState: TiltState = { rotateX: 0, rotateY: 0, scale: 1 };

export function useMouseTilt<T extends HTMLElement = HTMLDivElement>(
  maxTilt = 6,
  scaleOnHover = 1.02
) {
  const ref = useRef<T>(null);
  const [tilt, setTilt] = useState<TiltState>(defaultState);
  const rafId = useRef<number>(0);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const el = ref.current;
      if (!el) return;

      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        setTilt({
          rotateX: (0.5 - y) * maxTilt,
          rotateY: (x - 0.5) * maxTilt,
          scale: scaleOnHover,
        });
      });
    },
    [maxTilt, scaleOnHover]
  );

  const handleMouseLeave = useCallback(() => {
    cancelAnimationFrame(rafId.current);
    setTilt(defaultState);
  }, []);

  const style: React.CSSProperties = {
    transform: `perspective(800px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg) scale(${tilt.scale})`,
    transition: tilt.scale === 1 ? 'transform 0.5s cubic-bezier(0.23, 1, 0.32, 1)' : 'transform 0.1s ease-out',
    willChange: 'transform',
  };

  return { ref, style, onMouseMove: handleMouseMove, onMouseLeave: handleMouseLeave };
}
