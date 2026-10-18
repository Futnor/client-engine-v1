import { useCallback } from 'react';
import { LucideIcon } from 'lucide-react';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { cn } from '@/lib/utils';

export interface SectionNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

interface SectionSidebarProps {
  items: SectionNavItem[];
}

export function SectionSidebar({ items }: SectionSidebarProps) {
  const sectionIds = items.map((i) => i.id);
  const activeId = useScrollSpy(sectionIds);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.dispatchEvent(
        new CustomEvent('section-highlight', { detail: { sectionId: id } })
      );
    }
  }, []);

  return (
    <nav className="hidden lg:flex flex-col gap-0.5 sticky top-24 w-48 shrink-0 self-start max-h-[calc(100vh-8rem)] overflow-y-auto pr-2 scrollbar-thin">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-2 mb-1">
        Sections
      </span>
      {items.map((item) => {
        const isActive = activeId === item.id;
        return (
          <button
            key={item.id}
            onClick={() => scrollTo(item.id)}
            className={cn(
              'flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-200 text-left group',
              isActive
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            <item.icon
              className={cn(
                'w-3.5 h-3.5 shrink-0 transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground/60 group-hover:text-foreground'
              )}
            />
            <span className="truncate">{item.label}</span>
            {item.badge && (
              <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-primary/15 text-primary font-semibold">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
