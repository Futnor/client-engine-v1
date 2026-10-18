import { LogEntry } from '@/lib/botEngine';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ActivityLogExport } from '@/components/ActivityLogExport';
import { 
  Eye, 
  Heart, 
  UserPlus, 
  MessageCircle, 
  XCircle,
  Play,
  Square,
  Terminal
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ActivityLogProps {
  logs: LogEntry[];
}

const actionConfig = {
  scroll: { icon: Eye, color: 'text-primary', bg: 'bg-primary/10' },
  like: { icon: Heart, color: 'text-success', bg: 'bg-success/10' },
  follow: { icon: UserPlus, color: 'text-warning', bg: 'bg-warning/10' },
  dm: { icon: MessageCircle, color: 'text-accent', bg: 'bg-accent/10' },
  dm_skipped: { icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted/50' },
  session_start: { icon: Play, color: 'text-success', bg: 'bg-success/10' },
  session_end: { icon: Square, color: 'text-destructive', bg: 'bg-destructive/10' },
};

export function ActivityLog({ logs }: ActivityLogProps) {
  if (logs.length === 0) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
        <Terminal className="w-3.5 h-3.5" />
        <span>No activity yet. Start a session to see logs.</span>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-4 space-y-3 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Activity Log</h3>
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
            {logs.length}
          </span>
        </div>
        <ActivityLogExport logs={logs} />
      </div>

      <ScrollArea className="h-[300px] pr-2">
        <div className="space-y-1.5">
          {logs.map((log, index) => {
            const config = actionConfig[log.action];
            const Icon = config.icon;
            return (
              <div 
                key={log.id}
                className={cn(
                  "flex items-start gap-2 p-2 rounded-lg transition-all",
                  config.bg,
                  index === 0 && "animate-slide-in"
                )}
              >
                <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", config.color)} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs">{log.message}</p>
                  <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    {log.timestamp.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
