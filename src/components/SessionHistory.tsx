import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Calendar, User, Clock, MessageSquare, Heart, UserPlus, MousePointerClick, TrendingUp, ChevronDown, ChevronUp } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

interface SessionRecord {
  id: string;
  platform: string;
  instagram_account_username: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  dms_sent: number;
  likes_sent: number;
  follows_sent: number;
  scrolls: number;
  targeting_mode: string;
}

function readActiveInstagramAccount() {
  try {
    const raw = localStorage.getItem('futnor_active_account') || '';
    const normalized = raw.toLowerCase().replace(/^@/, '').trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function SessionHistory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAccount, setActiveAccount] = useState<string | null>(() => readActiveInstagramAccount());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextAccount = readActiveInstagramAccount();
      setActiveAccount((current) => (current === nextAccount ? current : nextAccount));
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      if (!activeAccount) {
        setSessions([]);
        setLoading(false);
        return;
      }

      const { data } = await supabase
        .from('session_history')
        .select('*')
        .eq('platform', 'instagram')
        .eq('instagram_account_username', activeAccount)
        .order('started_at', { ascending: false })
        .limit(100);

      setSessions((data || []) as SessionRecord[]);
      setLoading(false);
    };
    load();
  }, [activeAccount]);

  if (loading) {
    return <div className="text-xs text-muted-foreground py-4">Loading session history...</div>;
  }

  if (!activeAccount) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
        <User className="w-3.5 h-3.5" />
        <span>No Instagram account detected. Open Instagram in your browser to see per-account history.</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <User className="w-3 h-3 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground font-mono">@{activeAccount}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
          <Calendar className="w-3.5 h-3.5" />
          <span>No sessions recorded yet for @{activeAccount}.</span>
        </div>
      </div>
    );
  }

  // Aggregate stats
  const totalDMs = sessions.reduce((a, s) => a + s.dms_sent, 0);
  const totalLikes = sessions.reduce((a, s) => a + s.likes_sent, 0);
  const totalFollows = sessions.reduce((a, s) => a + s.follows_sent, 0);
  const totalScrolls = sessions.reduce((a, s) => a + s.scrolls, 0);
  const totalTime = sessions.reduce((a, s) => a + s.duration_seconds, 0);
  const totalSessions = sessions.length;
  const avgDMsPerSession = totalSessions > 0 ? (totalDMs / totalSessions).toFixed(1) : '0';

  // Daily chart data
  const dailyData = sessions.reduce<Record<string, { date: string; dms: number; likes: number; follows: number; sessions: number; duration: number }>>((acc, s) => {
    const day = format(new Date(s.started_at), 'MMM dd');
    if (!acc[day]) acc[day] = { date: day, dms: 0, likes: 0, follows: 0, sessions: 0, duration: 0 };
    acc[day].dms += s.dms_sent;
    acc[day].likes += s.likes_sent;
    acc[day].follows += s.follows_sent;
    acc[day].sessions += 1;
    acc[day].duration += s.duration_seconds;
    return acc;
  }, {});

  const chartData = Object.values(dailyData).reverse().slice(-14);
  const visibleSessions = showAll ? sessions : sessions.slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Account label */}
      <div className="flex items-center gap-1.5">
        <User className="w-3 h-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground font-mono">@{activeAccount}</span>
      </div>

      {/* Summary stats grid */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-primary">{totalSessions}</p>
          <p className="text-[9px] text-muted-foreground">Sessions</p>
        </div>
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-accent">{totalDMs}</p>
          <p className="text-[9px] text-muted-foreground">DMs Sent</p>
        </div>
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-success">{totalLikes}</p>
          <p className="text-[9px] text-muted-foreground">Likes</p>
        </div>
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-warning">{totalFollows}</p>
          <p className="text-[9px] text-muted-foreground">Follows</p>
        </div>
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-foreground">{formatDuration(totalTime)}</p>
          <p className="text-[9px] text-muted-foreground">Total Time</p>
        </div>
        <div className="rounded-lg bg-secondary/50 p-2.5 text-center">
          <p className="text-lg font-bold font-mono text-primary">{avgDMsPerSession}</p>
          <p className="text-[9px] text-muted-foreground">Avg DM/Session</p>
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 1 && (
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
              <Bar dataKey="dms" name="DMs" fill="hsl(262, 83%, 58%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="likes" name="Likes" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="follows" name="Follows" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Detailed session list */}
      <div className="space-y-1.5 max-h-[340px] overflow-y-auto scrollbar-thin">
        {visibleSessions.map((s) => {
          const hasActivity = s.dms_sent > 0 || s.likes_sent > 0 || s.follows_sent > 0;
          return (
            <div
              key={s.id}
              className={`flex flex-col gap-1 p-2.5 rounded-lg text-xs transition-colors ${
                hasActivity ? 'bg-primary/5 border border-primary/10' : 'bg-secondary/30'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground font-mono">
                    {format(new Date(s.started_at), 'MMM dd, yyyy · HH:mm')}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    ({formatDistanceToNow(new Date(s.started_at), { addSuffix: true })})
                  </span>
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  <span className="font-mono">{formatDuration(s.duration_seconds)}</span>
                </div>
              </div>

              <div className="flex items-center gap-4 pl-5">
                <span className={`flex items-center gap-1 ${s.dms_sent > 0 ? 'text-accent font-medium' : 'text-muted-foreground/50'}`}>
                  <MessageSquare className="w-3 h-3" />
                  {s.dms_sent} DMs
                </span>
                <span className={`flex items-center gap-1 ${s.likes_sent > 0 ? 'text-success font-medium' : 'text-muted-foreground/50'}`}>
                  <Heart className="w-3 h-3" />
                  {s.likes_sent} likes
                </span>
                <span className={`flex items-center gap-1 ${s.follows_sent > 0 ? 'text-warning font-medium' : 'text-muted-foreground/50'}`}>
                  <UserPlus className="w-3 h-3" />
                  {s.follows_sent} follows
                </span>
                <span className="flex items-center gap-1 text-muted-foreground/50">
                  <MousePointerClick className="w-3 h-3" />
                  {s.scrolls} scrolls
                </span>
                {s.targeting_mode && s.targeting_mode !== 'manual' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                    {s.targeting_mode}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Show more / less toggle */}
      {sessions.length > 8 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto"
        >
          {showAll ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showAll ? 'Show less' : `Show all ${sessions.length} sessions`}
        </button>
      )}
    </div>
  );
}
