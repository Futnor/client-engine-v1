import { LogEntry } from '@/lib/botEngine';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

interface ActivityLogExportProps {
  logs: LogEntry[];
}

export function ActivityLogExport({ logs }: ActivityLogExportProps) {
  if (logs.length === 0) return null;

  const exportCSV = () => {
    const header = 'Timestamp,Action,Message\n';
    const rows = logs.map((l) =>
      `"${l.timestamp.toISOString()}","${l.action}","${l.message.replace(/"/g, '""')}"`
    ).join('\n');
    download(header + rows, 'futnor-activity-log.csv', 'text/csv');
    toast.success('Activity log exported as CSV');
  };

  const exportJSON = () => {
    const data = logs.map((l) => ({
      timestamp: l.timestamp.toISOString(),
      action: l.action,
      message: l.message,
    }));
    download(JSON.stringify(data, null, 2), 'futnor-activity-log.json', 'application/json');
    toast.success('Activity log exported as JSON');
  };

  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button variant="ghost" size="sm" onClick={exportCSV} className="h-7 text-xs gap-1">
        <Download className="w-3 h-3" /> CSV
      </Button>
      <Button variant="ghost" size="sm" onClick={exportJSON} className="h-7 text-xs gap-1">
        <Download className="w-3 h-3" /> JSON
      </Button>
    </div>
  );
}
