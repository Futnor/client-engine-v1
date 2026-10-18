import { useState, useEffect } from 'react';
import { CheckCircle2, Circle, X, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Platform } from '@/lib/botEngine';

interface QuickStartGuideProps {
  platform: Platform;
  isRunning: boolean;
  hasStartedOnce: boolean;
}

const STORAGE_KEY = 'futnor_quickstart_dismissed';

export function QuickStartGuide({ platform, isRunning, hasStartedOnce }: QuickStartGuideProps) {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  useEffect(() => {
    if (hasStartedOnce && !dismissed) {
      setDismissed(true);
      localStorage.setItem(STORAGE_KEY, 'true');
    }
  }, [hasStartedOnce, dismissed]);

  if (dismissed) return null;

  const steps = [
    {
      label: 'Choose Platform',
      description: 'Pick Instagram or TikTok above',
      done: !!platform,
    },
    {
      label: 'Review Settings',
      description: 'Check daily limits & config below',
      done: true, // defaults are always set
    },
    {
      label: 'Start Session',
      description: 'Hit the green button to begin',
      done: isRunning || hasStartedOnce,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  return (
    <div className="relative rounded-xl border border-primary/20 bg-card p-5 space-y-4 animate-fade-in">
      <button
        onClick={() => {
          setDismissed(true);
          localStorage.setItem(STORAGE_KEY, 'true');
        }}
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss guide"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Rocket className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Quick Start</h2>
          <p className="text-xs text-muted-foreground">
            {completedCount}/{steps.length} steps complete
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {steps.map((step, i) => (
          <div
            key={i}
            className={`flex items-start gap-3 rounded-lg p-3 transition-colors ${
              step.done
                ? 'bg-primary/5 border border-primary/20'
                : 'bg-muted/30 border border-border'
            }`}
          >
            <div className="mt-0.5">
              {step.done ? (
                <CheckCircle2 className="w-5 h-5 text-primary" />
              ) : (
                <Circle className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium">
                <span className="text-muted-foreground mr-1.5">{i + 1}.</span>
                {step.label}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
