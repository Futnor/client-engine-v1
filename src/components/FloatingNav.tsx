import { useState, useCallback } from 'react';
import { LucideIcon, Navigation, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface FloatingNavProps {
  items: NavItem[];
}

export function FloatingNav({ items }: FloatingNavProps) {
  const [open, setOpen] = useState(false);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setOpen(false);

      // Heartbeat glow: 3 pulses after scroll completes
      setTimeout(() => {
        el.classList.add('nav-heartbeat');
        el.addEventListener(
          'animationend',
          () => el.classList.remove('nav-heartbeat'),
          { once: true }
        );
      }, 400);
    }
  }, []);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {/* Menu items */}
      <div
        className={cn(
          'flex flex-col gap-1.5 rounded-xl border border-border bg-card/95 backdrop-blur-md shadow-lg p-2 transition-all duration-200 origin-bottom-right',
          open ? 'scale-100 opacity-100' : 'scale-90 opacity-0 pointer-events-none'
        )}
      >
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => scrollTo(item.id)}
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors whitespace-nowrap"
          >
            <item.icon className="w-4 h-4 text-primary shrink-0" />
            {item.label}
          </button>
        ))}
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-200',
          'bg-gradient-to-br from-primary to-accent text-primary-foreground hover:opacity-90',
          open && 'rotate-90'
        )}
      >
        {open ? <X className="w-5 h-5" /> : <Navigation className="w-5 h-5" />}
      </button>
    </div>
  );
}
