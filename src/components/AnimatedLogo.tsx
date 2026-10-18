import { useEffect, useRef, useState } from 'react';
import logo from '@/assets/logo.png';

interface AnimatedLogoProps {
  /** Rendered size in px (square box). The portrait logo fits inside via object-contain. */
  size?: number;
  className?: string;
  alt?: string;
  /** Disable mouse tracking (e.g., reduced motion). */
  static?: boolean;
}

/**
 * Logo that subtly orients toward the cursor, so the bot's existing blue
 * eyes appear to follow the mouse. We translate the whole image by a few
 * pixels in the cursor direction — no overlays are drawn on top of the
 * original artwork.
 */
export function AnimatedLogo({
  size = 64,
  className = '',
  alt = 'Client Engine',
  static: isStatic = false,
}: AnimatedLogoProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });

  useEffect(() => {
    if (isStatic) return;
    const handleMove = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Anchor at the bot's eye line — horizontal center, ~43% from top
      // (measured from the drawn cyan pupil centroids on logo.png).
      const anchorX = rect.left + rect.width / 2;
      const anchorY = rect.top + rect.height * 0.4314;
      const dx = e.clientX - anchorX;
      const dy = e.clientY - anchorY;
      const dist = Math.hypot(dx, dy) || 1;
      // Smooth ramp — full travel reached ~280px from the logo
      const intensity = Math.min(1, dist / 280);
      setOffset({
        dx: (dx / dist) * intensity,
        dy: (dy / dist) * intensity,
      });
    };
    window.addEventListener('mousemove', handleMove, { passive: true });
    return () => window.removeEventListener('mousemove', handleMove);
  }, [isStatic]);

  // Maximum visual nudge — small, so the bot just "glances" toward the cursor
  const maxNudgePx = Math.max(1.5, size * 0.025);
  const tx = offset.dx * maxNudgePx;
  const ty = offset.dy * maxNudgePx;

  // Each eye has two layers:
  //   - socket: dark dot that covers the drawn cyan pupil on the static image
  //   - pupil:  cyan dot inside the socket that translates with the cursor,
  //             giving the illusion that the bot's blue pupil is following.
  // Coordinates measured from logo.png (1030x1650) by sampling cyan pixels:
  //   left  cyan centroid = (35.70%, 43.14%) of image
  //   right cyan centroid = (64.24%, 43.14%) of image
  // Image is rendered at 62.4% container width via object-contain with
  // 18.8% horizontal margin, so pupils land at ±8.93% from container center.
  const eyeOffsetXPct = 8.93;
  const eyeTopPct = 43.14;
  const socketDiameter = Math.max(8, size * 0.085);
  const pupilDiameter = Math.max(4, size * 0.04);
  const pupilRangePx = Math.max(2, size * 0.022);
  const pupilTx = offset.dx * pupilRangePx;
  const pupilTy = offset.dy * pupilRangePx;

  return (
    <div
      ref={wrapRef}
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      aria-label={alt}
    >
      <img
        src={logo}
        alt={alt}
        className="w-full h-full object-contain select-none pointer-events-none"
        draggable={false}
        style={{
          transform: `translate(${tx}px, ${ty}px)`,
          transition: 'transform 120ms ease-out',
          willChange: 'transform',
        }}
      />
      {[-1, 1].map((side) => (
        <span
          key={side}
          aria-hidden="true"
          className="absolute rounded-full pointer-events-none flex items-center justify-center"
          style={{
            width: socketDiameter,
            height: socketDiameter,
            left: `calc(50% + ${(side * eyeOffsetXPct) / 100} * ${size}px - ${socketDiameter / 2}px)`,
            top: `calc(${eyeTopPct}% - ${socketDiameter / 2}px)`,
            background: '#0f0a24',
          }}
        >
          <span
            className="rounded-full"
            style={{
              width: pupilDiameter,
              height: pupilDiameter,
              background: '#19b8d1',
              boxShadow: '0 0 3px rgba(25, 184, 209, 0.5)',
              transform: `translate(${pupilTx}px, ${pupilTy}px)`,
              transition: 'transform 100ms ease-out',
              willChange: 'transform',
            }}
          />
        </span>
      ))}
    </div>
  );
}
