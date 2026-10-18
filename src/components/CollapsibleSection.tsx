import { useState, useEffect, useRef } from 'react';
import { ChevronDown, LucideIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  id?: string;
  icon: LucideIcon;
  title: string;
  description: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}

export function CollapsibleSection({
  id,
  icon: Icon,
  title,
  description,
  defaultOpen = false,
  badge,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [blinking, setBlinking] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Listen for a custom "section-highlight" event to open + blink
  useEffect(() => {
    if (!id) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sectionId === id) {
        setOpen(true);
        setBlinking(true);
        setTimeout(() => setBlinking(false), 700);
      }
    };
    window.addEventListener('section-highlight', handler);
    return () => window.removeEventListener('section-highlight', handler);
  }, [id]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        id={id}
        ref={containerRef}
        className={cn('scroll-mt-4 rounded-xl transition-all duration-500', blinking && 'ring-2 ring-primary/40')}
      >
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:bg-muted/50 transition-colors text-left group">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{title}</span>
              {badge && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
                  {badge}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{description}</p>
          </div>
          <ChevronDown
            className={cn(
              'w-4 h-4 text-muted-foreground transition-transform duration-200 shrink-0',
              open && 'rotate-180'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 animate-fade-in">
        {children}
      </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
