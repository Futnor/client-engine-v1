import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invokeFunction';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MessageCircle, TrendingUp, RefreshCw, CheckCircle, XCircle, BarChart3, UserPlus, Reply
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ChartContainer,
  ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

interface DailyBreakdown {
  [date: string]: { sent: number; responded: number };
}

interface RecentDM {
  id: string;
  recipient_username: string;
  platform: string;
  instagram_account_username: string | null;
  sent_at: string;
  responded: boolean;
  responded_at: string | null;
  was_first_contact: boolean | null;
}

interface BucketStats {
  total: number;
  responded: number;
  responseRate: number;
}

interface ResponseStats {
  total: number;
  responded: number;
  responseRate: number;
  windowDays: number;
  dailyBreakdown: DailyBreakdown;
  recentDMs: RecentDM[];
  firstContact?: BucketStats;
  followUp?: BucketStats;
  unclassified?: BucketStats;
}

const chartConfig: ChartConfig = {
  sent: { label: 'DMs Sent', color: 'hsl(var(--primary))' },
  responded: { label: 'Responded', color: 'hsl(var(--success, 142 71% 45%))' },
};

const RANGE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Today' },
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 60, label: 'Last 60 days' },
  { value: 90, label: 'Last 90 days' },
];

const STORAGE_KEY = 'futnor_response_rate_window_days';

function loadInitialDays(): number {
  if (typeof window === 'undefined') return 14;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const parsed = Number(raw);
  if (RANGE_OPTIONS.some((o) => o.value === parsed)) return parsed;
  return 14;
}

export function ResponseRateTracker() {
  const [stats, setStats] = useState<ResponseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(loadInitialDays);

  const fetchStats = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      // Normalize the active account the same way background.js does before
      // it writes `instagram_account_username` to dm_tracking. Without this,
      // a stray "@" prefix or mixed-case value in localStorage causes the
      // server-side `.eq('instagram_account_username', ...)` filter to miss
      // every row and the panel shows 0 DMs / 0 responses.
      const activeAccount = ((localStorage.getItem('futnor_active_account') || '')
        .toLowerCase()
        .replace(/^@/, '')
        .trim()) || null;
      // Use invokeFunction so the real server-side error (e.g. "relation
      // dm_tracking does not exist", "permission denied", "auth error")
      // surfaces in the UI instead of the opaque "Edge Function returned
      // a non-2xx status code" generic from supabase-js.
      const { data, error: fnErr } = await invokeFunction<any>('dm-response-tracking', {
        action: 'stats',
        platform: 'instagram',
        instagramAccount: activeAccount || undefined,
        days: windowDays,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      });
      if (fnErr) throw new Error(fnErr);
      if (data?.error) throw new Error(data.error);
      setStats(data);
    } catch (err: any) {
      console.error('dm-response-tracking stats failed:', err);
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  // Trigger the extension to scan the IG inbox and mark replies as
  // responded, then refetch stats. Without this, the response-rate panel
  // only updated when the Sales Agent loop happened to run an inbox scan,
  // so users who never enabled Sales Agent saw stale 0% rates even after
  // receiving real replies.
  const scanThenRefresh = useCallback(async (windowDays: number) => {
    setScanning(true);
    try {
      window.postMessage(
        { source: 'futnor-web', command: { type: 'SCAN_INBOX_RESPONSES', _ts: Date.now() } },
        '*',
      );
      // Give the extension a moment to navigate IG to /direct/inbox/, scan,
      // and POST the check-responses update before we re-query stats.
      await new Promise((r) => setTimeout(r, 6000));
    } catch {}
    setScanning(false);
    await fetchStats(windowDays);
  }, [fetchStats]);

  useEffect(() => {
    fetchStats(days);
    const interval = setInterval(() => fetchStats(days), 60000);
    return () => clearInterval(interval);
  }, [fetchStats, days]);

  const handleRangeChange = (value: string) => {
    const n = Number(value);
    if (!RANGE_OPTIONS.some((o) => o.value === n)) return;
    setDays(n);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(n));
    } catch {}
  };

  const chartData = useMemo(() => {
    if (!stats?.dailyBreakdown) return [];
    return Object.entries(stats.dailyBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => {
        // date is a local YYYY-MM-DD bucket — parse as local midnight (not UTC).
        const [y, m, d] = date.split('-').map(Number);
        const local = new Date(y, (m || 1) - 1, d || 1);
        return {
          date: local.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          sent: data.sent,
          responded: data.responded,
        };
      });
  }, [stats]);

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const rangeLabel = useMemo(
    () => RANGE_OPTIONS.find((o) => o.value === days)?.label ?? `Last ${days} days`,
    [days],
  );

  return (
    <div className="space-y-4">
      {/* Range selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-muted-foreground">Showing data from</p>
          <p className="text-sm font-medium">{rangeLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={handleRangeChange}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="Select range" />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => scanThenRefresh(days)}
            className="h-9"
            aria-label="Scan inbox for new responses"
            disabled={scanning || loading}
          >
            <RefreshCw className={cn('w-4 h-4 mr-1.5', (scanning || loading) && 'animate-spin')} />
            {scanning ? 'Scanning…' : 'Scan inbox'}
          </Button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <MessageCircle className="w-5 h-5 text-primary shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">DMs Sent</p>
              <p className="text-2xl font-bold font-mono text-primary">
                {loading ? '—' : stats?.total ?? 0}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-success shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Responded</p>
              <p className="text-2xl font-bold font-mono text-success">
                {loading ? '—' : stats?.responded ?? 0}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingUp className="w-5 h-5 text-warning shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Response Rate</p>
              <p className="text-2xl font-bold font-mono text-warning">
                {loading ? '—' : `${stats?.responseRate ?? 0}%`}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {/* New outreach vs follow-up breakdown */}
      {!loading && stats && ((stats.firstContact?.total ?? 0) > 0 || (stats.followUp?.total ?? 0) > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Outreach vs Follow-ups</CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <p className="text-xs font-medium">New outreach</p>
                </div>
                <p className="text-lg font-bold font-mono">
                  {stats.firstContact?.responded ?? 0}/{stats.firstContact?.total ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats.firstContact?.responseRate ?? 0}% reply rate
                </p>
              </div>
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Reply className="w-4 h-4 text-success" />
                  <p className="text-xs font-medium">Follow-ups</p>
                </div>
                <p className="text-lg font-bold font-mono">
                  {stats.followUp?.responded ?? 0}/{stats.followUp?.total ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats.followUp?.responseRate ?? 0}% reply rate
                </p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              "New outreach" counts DMs sent into empty threads. "Follow-ups" counts DMs sent into threads
              that already had messages — these almost always have replies, so combining them inflates your
              true cold-outreach response rate.
              {(stats.unclassified?.total ?? 0) > 0 && (
                <> {stats.unclassified?.total} older DM{(stats.unclassified?.total ?? 0) === 1 ? '' : 's'} not yet classified.</>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              DM Response Trend — {rangeLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <ChartContainer config={chartConfig} className="h-[180px] w-full">
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="responded" fill="var(--color-responded)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
            <p className="text-[10px] text-muted-foreground mt-2">
              Each bar represents DMs sent on that day in your local timezone. A "Responded"
              count is attributed to the day the DM was sent, even if the reply came later.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Recent DMs Table */}
      {stats?.recentDMs && stats.recentDMs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent DMs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[220px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Recipient</TableHead>
                    <TableHead className="text-xs">Sent</TableHead>
                    <TableHead className="text-xs text-center">Status</TableHead>
                    <TableHead className="text-xs">Responded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.recentDMs.map((dm) => (
                    <TableRow key={dm.id}>
                      <TableCell className="text-xs font-medium">@{dm.recipient_username}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(dm.sent_at)}
                      </TableCell>
                      <TableCell className="text-center">
                        {dm.responded ? (
                          <Badge variant="default" className="text-[10px] bg-success text-success-foreground">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            Replied
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            <XCircle className="w-3 h-3 mr-1" />
                            No Reply
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {dm.responded_at ? formatDate(dm.responded_at) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {!loading && stats?.total === 0 && (
        <div className="text-center py-6 text-muted-foreground text-sm">
          <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>No DMs tracked in {rangeLabel.toLowerCase()}. Try a longer range or start a session.</p>
        </div>
      )}
    </div>
  );
}
