import { useCallback, useState } from 'react';
import { LucideIcon, ChevronUp } from 'lucide-react';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { cn } from '@/lib/utils';

export interface MobileNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface MobileBottomNavProps {
  items: MobileNavItem[];
}

export function MobileBottomNav({ items }: MobileBottomNavProps) {
  const [expanded, setExpanded] = useState(false);
  const sectionIds = items.map((i) => i.id);
  const activeId = useScrollSpy(sectionIds);

  // Show first 4 items in collapsed mode, all when expanded
  const visibleItems = expanded ? items : items.slice(0, 5);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.dispatchEvent(
        new CustomEvent('section-highlight', { detail: { sectionId: id } })
      );
    }
    setExpanded(false);
  }, []);

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50">
      {/* Expanded drawer */}
      {expanded && (
        <div
          className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
          onClick={() => setExpanded(false)}
        />
      )}

      <div
        className={cn(
          'relative z-50 border-t border-border bg-card/95 backdrop-blur-xl transition-all duration-300 safe-area-bottom',
          expanded ? 'rounded-t-2xl shadow-2xl' : ''
        )}
      >
        {/* Expand/collapse toggle */}
        {items.length > 5 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="absolute -top-8 left-1/2 -translate-x-1/2 w-10 h-8 rounded-t-xl bg-card border border-b-0 border-border flex items-center justify-center"
          >
            <ChevronUp
              className={cn(
                'w-4 h-4 text-muted-foreground transition-transform duration-200',
                expanded && 'rotate-180'
              )}
            />
          </button>
        )}

        {/* Grid of items */}
        <div
          className={cn(
            'grid gap-0.5 p-1.5',
            expanded ? 'grid-cols-4 max-h-[50vh] overflow-y-auto' : 'grid-cols-5'
          )}
        >
          {visibleItems.map((item) => {
            const isActive = activeId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => scrollTo(item.id)}
                className={cn(
                  'flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-all duration-200',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground active:bg-muted/50'
                )}
              >
                <item.icon className={cn('w-4 h-4', isActive && 'text-primary')} />
                <span className="text-[10px] font-medium leading-tight text-center truncate w-full">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
