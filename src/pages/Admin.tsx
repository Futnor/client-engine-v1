import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { ADMIN_EMAILS } from '@/lib/subscriptionTiers';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Users, Activity, MessageCircle, Heart, UserPlus, Clock, Bot,
  Shield, Key, ArrowLeft, RefreshCw, TrendingUp, BarChart3, DollarSign,
  Mail, Search, AlertTriangle, Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ExtensionBuildsTab } from '@/components/admin/ExtensionBuildsTab';

interface AdminStats {
  totalUsers: number;
  usersLast24h: number;
  usersLast7d: number;
  usersLast30d: number;
  activeUsersLast7d: number;
  totalSessions: number;
  sessionsLast24h: number;
  sessionsLast7d: number;
  totalDMs: number;
  totalLikes: number;
  totalFollows: number;
  totalSessionTimeHours: number;
  totalBusinessProfiles: number;
  totalAgentConversations: number;
  totalTrialClaims: number;
  totalApiKeys: number;
  totalOutreachProfiles: number;
  paidSubscribers: number;
  activeTrials: number;
  expiredTrials: number;
  trialConversionRate: number;
  trialAvgLength: number;
  mtdRevenue: number;
  yearRevenue: number;
  planBreakdown: Record<string, { count: number; revenue: number; price: number }>;
}

interface UserDetail {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  display_name: string | null;
  instagram_username: string | null;
  tiktok_username: string | null;
  total_sessions: number;
  total_dms: number;
  total_likes: number;
  total_follows: number;
  has_business_profile: boolean;
  agent_conversations: number;
  has_trial: boolean;
  status: 'paid' | 'trial' | 'expired' | 'free';
  /** 'stripe' = chose a plan in Checkout. 'manual' = claimed free trial without picking a plan. */
  trial_source: 'stripe' | 'manual' | null;
  plan: string | null;
  plan_price: number | null;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  trial_days_left: number | null;
}

interface RecentSession {
  id: string;
  user_id: string;
  platform: string;
  instagram_account_username: string | null;
  started_at: string;
  duration_seconds: number;
  dms_sent: number;
  likes_sent: number;
  follows_sent: number;
  scrolls: number;
  targeting_mode: string;
}

interface Transaction {
  description: string;
  date: number;
  amount: number;
  currency: string;
}

interface EmailLog {
  id: string;
  message_id: string | null;
  template_name: string;
  recipient_email: string;
  status: string;
  error_message: string | null;
  created_at: string;
}

const fmtCurrency = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
const fmtCompact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDuration = (s: number) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

export default function Admin() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<UserDetail[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([]);
  const [recentEmails, setRecentEmails] = useState<EmailLog[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // Email modal state
  const [emailTarget, setEmailTarget] = useState<UserDetail | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Bulk-email modal state (for abandoned-checkout retargeting)
  const [bulkRecipients, setBulkRecipients] = useState<UserDetail[]>([]);
  const [bulkSubject, setBulkSubject] = useState('Finish setting up your Client Engine free trial');
  const [bulkMessage, setBulkMessage] = useState(
    "Hi {{name}},\n\nLooks like you started your Client Engine free trial but didn't finish entering your card details — so your 7-day trial hasn't actually started yet.\n\nNo charge is made during the trial. We only ask for a card so the service continues seamlessly when day 8 hits — you can cancel anytime from your dashboard before then.\n\nFinish setting up here:\nhttps://futnormarketing.com/pricing\n\nIf you ran into anything weird on the Stripe page, just reply to this email and I'll help you sort it out.\n\nCheers,\nThe Client Engine team"
  );
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ sent: number; failed: number; total: number } | null>(null);

  const openBulkEmail = (recipients: UserDetail[]) => {
    setBulkRecipients(recipients);
    setBulkProgress(null);
  };

  const sendBulkEmail = async () => {
    if (bulkRecipients.length === 0) return;
    if (!bulkSubject.trim() || !bulkMessage.trim()) {
      toast.error('Subject and message are required');
      return;
    }
    setBulkSending(true);
    let sent = 0;
    let failed = 0;
    setBulkProgress({ sent: 0, failed: 0, total: bulkRecipients.length });

    // Loop sequentially so we don't slam the email queue / hit per-second
    // rate limits. {{name}} → recipient.display_name (or "there"). Each
    // failure is counted but doesn't abort the batch.
    for (const u of bulkRecipients) {
      const name = u.display_name?.split(' ')[0] || 'there';
      const personalisedMessage = bulkMessage.replace(/\{\{name\}\}/g, name);
      try {
        const { data, error } = await supabase.functions.invoke('admin-send-email', {
          body: {
            recipientEmail: u.email,
            recipientName: u.display_name || undefined,
            subject: bulkSubject.trim(),
            message: personalisedMessage.trim(),
          },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        sent++;
      } catch (e: any) {
        console.error(`Bulk-email failed for ${u.email}:`, e);
        failed++;
      }
      setBulkProgress({ sent, failed, total: bulkRecipients.length });
    }

    setBulkSending(false);
    toast.success(`Bulk email complete — ${sent} sent, ${failed} failed`);
    if (failed === 0) {
      setBulkRecipients([]);
      setTimeout(fetchData, 1500);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
        setIsAdmin(false);
        setLoading(false);
        return;
      }
      setIsAdmin(true);

      const { data, error: fnError } = await supabase.functions.invoke('admin-dashboard', {});
      if (fnError) {
        // supabase-js v2 wraps non-2xx responses in FunctionsHttpError. The
        // actual server error message is inside fnError.context (a Response
        // object). Extract it so admins see "Stripe API key missing" or
        // "relation email_send_log does not exist" instead of the useless
        // generic "Edge Function returned a non-2xx status code".
        let detail = fnError.message || 'Unknown error';
        try {
          const ctx: any = (fnError as any).context;
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json();
            if (body?.error) detail = body.error;
          } else if (ctx && typeof ctx.text === 'function') {
            const text = await ctx.text();
            if (text) detail = text;
          }
        } catch (parseErr) {
          console.warn('Could not parse edge function error body:', parseErr);
        }
        console.error('admin-dashboard error:', fnError, 'detail:', detail);
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);

      setStats(data.stats);
      setUsers(data.users);
      setRecentSessions(data.recentSessions);
      setRecentTransactions(data.recentTransactions || []);
      setRecentEmails(data.recentEmails || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const openEmail = (u: UserDetail) => {
    setEmailTarget(u);
    setEmailSubject('');
    setEmailMessage('');
  };

  const sendEmail = async () => {
    if (!emailTarget) return;
    if (!emailSubject.trim() || !emailMessage.trim()) {
      toast.error('Subject and message are required');
      return;
    }
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-send-email', {
        body: {
          recipientEmail: emailTarget.email,
          recipientName: emailTarget.display_name || undefined,
          subject: emailSubject.trim(),
          message: emailMessage.trim(),
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Email queued to ${emailTarget.email}`);
      setEmailTarget(null);
      // Refresh email logs after a brief delay
      setTimeout(fetchData, 1500);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading admin panel...</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <Shield className="w-12 h-12 text-destructive mx-auto" />
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground">You don't have admin access.</p>
            <Button onClick={() => navigate('/')}>Go to Dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Shield className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-bold">Admin Panel</h1>
          </div>
          <Button variant="outline" size="sm" onClick={fetchData} className="gap-2">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 py-6 space-y-6">
        {error && (
          <Card className="border-destructive">
            <CardContent className="p-4 text-destructive text-sm">{error}</CardContent>
          </Card>
        )}

        <Tabs defaultValue="overview">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="users">Users ({users.length})</TabsTrigger>
            <TabsTrigger value="trials">Free Trials</TabsTrigger>
            <TabsTrigger value="sales">Sales</TabsTrigger>
            <TabsTrigger value="email">Email</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="builds">Builds</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab stats={stats} />
          </TabsContent>

          <TabsContent value="users">
            <UsersTab users={users} onEmail={openEmail} />
          </TabsContent>

          <TabsContent value="trials">
            <TrialsTab users={users} stats={stats} onEmail={openEmail} onBulkEmail={openBulkEmail} />
          </TabsContent>

          <TabsContent value="sales">
            <SalesTab stats={stats} transactions={recentTransactions} />
          </TabsContent>

          <TabsContent value="email">
            <EmailTab users={users} emails={recentEmails} onRefresh={fetchData} />
          </TabsContent>

          <TabsContent value="sessions">
            <SessionsTab sessions={recentSessions} />
          </TabsContent>

          <TabsContent value="builds">
            <ExtensionBuildsTab />
          </TabsContent>
        </Tabs>
      </main>

      {/* Per-user email modal */}
      <Dialog open={!!emailTarget} onOpenChange={(o) => !o && setEmailTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email user</DialogTitle>
            <DialogDescription>
              Send a one-to-one message to {emailTarget?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="es">Subject</Label>
              <Input id="es" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} maxLength={200} placeholder="Subject..." />
            </div>
            <div>
              <Label htmlFor="em">Message</Label>
              <Textarea id="em" value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} maxLength={5000} rows={8} placeholder="Write your message..." />
              <p className="text-xs text-muted-foreground mt-1">{emailMessage.length}/5000</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailTarget(null)} disabled={sending}>Cancel</Button>
            <Button onClick={sendEmail} disabled={sending} className="gap-2">
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Sending...' : 'Send email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk-email modal — used by Trials → Without Plan */}
      <Dialog
        open={bulkRecipients.length > 0}
        onOpenChange={(o) => { if (!o && !bulkSending) setBulkRecipients([]); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bulk email · {bulkRecipients.length} recipients</DialogTitle>
            <DialogDescription>
              Each user gets a personalised copy. Use <code className="bg-muted px-1 rounded text-xs">{'{{name}}'}</code> in the message to insert their first name (falls back to "there").
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            <div>
              <Label htmlFor="bes">Subject</Label>
              <Input id="bes" value={bulkSubject} onChange={(e) => setBulkSubject(e.target.value)} maxLength={200} disabled={bulkSending} />
            </div>
            <div>
              <Label htmlFor="bem">Message</Label>
              <Textarea id="bem" value={bulkMessage} onChange={(e) => setBulkMessage(e.target.value)} maxLength={5000} rows={10} disabled={bulkSending} />
              <p className="text-xs text-muted-foreground mt-1">{bulkMessage.length}/5000</p>
            </div>

            {/* Recipient preview */}
            <details className="rounded-md border bg-muted/30 px-3 py-2">
              <summary className="text-xs cursor-pointer text-muted-foreground hover:text-foreground">
                Preview recipient list ({bulkRecipients.length})
              </summary>
              <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                {bulkRecipients.map(u => (
                  <p key={u.id} className="text-xs text-muted-foreground font-mono">
                    {u.display_name ? `${u.display_name} <${u.email}>` : u.email}
                  </p>
                ))}
              </div>
            </details>

            {/* Live progress while sending */}
            {bulkProgress && (
              <div className="rounded-md border bg-card px-3 py-2 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">Progress</span>
                  <span className="font-mono">
                    {bulkProgress.sent + bulkProgress.failed} / {bulkProgress.total}
                  </span>
                </div>
                <Progress value={((bulkProgress.sent + bulkProgress.failed) / bulkProgress.total) * 100} />
                <div className="flex gap-3 text-[11px] text-muted-foreground">
                  <span>✅ Sent: {bulkProgress.sent}</span>
                  {bulkProgress.failed > 0 && <span className="text-destructive">❌ Failed: {bulkProgress.failed}</span>}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkRecipients([])} disabled={bulkSending}>
              {bulkSending ? 'Sending...' : 'Cancel'}
            </Button>
            <Button onClick={sendBulkEmail} disabled={bulkSending || bulkRecipients.length === 0} className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground">
              <Send className="w-3.5 h-3.5" />
              {bulkSending ? `Sending ${bulkProgress?.sent ?? 0}/${bulkRecipients.length}...` : `Send to ${bulkRecipients.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ===== Overview Tab =====
function OverviewTab({ stats }: { stats: AdminStats | null }) {
  if (!stats) return null;
  const planTotal = Object.values(stats.planBreakdown).reduce((s, p) => s + p.count, 0) || 1;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Total Users" value={stats.totalUsers.toLocaleString()} />
        <KpiCard icon={DollarSign} label="Paid Subscribers" value={stats.paidSubscribers.toLocaleString()} accent />
        <KpiCard icon={Clock} label="Active Free Trials" value={stats.activeTrials.toLocaleString()} />
        <KpiCard icon={TrendingUp} label="Monthly Revenue" value={fmtCurrency(stats.mtdRevenue)} accent />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Subscription breakdown</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {Object.entries(stats.planBreakdown).map(([name, p]) => {
              const pct = Math.round((p.count / planTotal) * 100);
              return (
                <div key={name} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{name} plan</span>
                    <span className="text-muted-foreground font-mono">{p.count} ({pct}%)</span>
                  </div>
                  <Progress value={pct} />
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">This Month Activity</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <MiniStat label="New signups (30d)" value={`+${stats.usersLast30d}`} />
            <MiniStat label="Active users (7d)" value={String(stats.activeUsersLast7d)} />
            <MiniStat label="Trial conversion" value={`${stats.trialConversionRate}%`} />
            <MiniStat label="Total DMs sent" value={stats.totalDMs.toLocaleString()} />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatMini icon={TrendingUp} label="New (24h)" value={stats.usersLast24h} accent />
        <StatMini icon={TrendingUp} label="New (7d)" value={stats.usersLast7d} />
        <StatMini icon={Activity} label="Sessions (7d)" value={stats.sessionsLast7d} />
        <StatMini icon={MessageCircle} label="Total DMs" value={stats.totalDMs} accent />
        <StatMini icon={Heart} label="Total Likes" value={stats.totalLikes} />
        <StatMini icon={UserPlus} label="Total Follows" value={stats.totalFollows} />
        <StatMini icon={Bot} label="AI Conversations" value={stats.totalAgentConversations} />
        <StatMini icon={Key} label="API Keys" value={stats.totalApiKeys} />
        <StatMini icon={BarChart3} label="Total Sessions" value={stats.totalSessions} />
        <StatMini icon={Clock} label="Total Hours" value={stats.totalSessionTimeHours} />
        <StatMini icon={Shield} label="Trial Claims" value={stats.totalTrialClaims} />
        <StatMini icon={Activity} label="Outreach Profiles" value={stats.totalOutreachProfiles} />
      </div>
    </div>
  );
}

// ===== Users Tab =====
function UsersTab({ users, onEmail }: { users: UserDetail[]; onEmail: (u: UserDetail) => void }) {
  const [filter, setFilter] = useState<'all' | 'paid' | 'trial' | 'free'>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return users.filter(u => {
      if (filter !== 'all' && u.status !== filter) return false;
      if (q && !(u.email?.toLowerCase().includes(q) || u.display_name?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [users, filter, search]);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 space-y-0">
        <CardTitle className="text-base">User management</CardTitle>
        <div className="flex flex-col sm:flex-row gap-2">
          <Select value={filter} onValueChange={(v: any) => setFilter(v)}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              <SelectItem value="paid">Paid only</SelectItem>
              <SelectItem value="trial">Free trial</SelectItem>
              <SelectItem value="free">Free / no plan</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email..." className="pl-8 w-full sm:w-[260px]" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[600px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-center">Activity</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <p className="font-medium text-sm">{u.display_name || '—'}</p>
                    {u.instagram_username && (
                      <p className="text-[10px] text-primary">@{u.instagram_username}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{u.email}</TableCell>
                  <TableCell><StatusBadge u={u} /></TableCell>
                  <TableCell className="text-xs">
                    {u.plan ? (
                      u.plan
                    ) : u.has_trial && u.status === 'free' ? (
                      <span className="text-warning font-medium">Abandoned checkout</span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(u.created_at)}</TableCell>
                  <TableCell className="text-center text-xs font-mono">
                    {u.total_sessions}s · {u.total_dms}DM
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onEmail(u)}>
                      <Mail className="w-3 h-3" /> Email
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No users match.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ===== Trials Tab =====
function TrialsTab({
  users, stats, onEmail, onBulkEmail,
}: {
  users: UserDetail[];
  stats: AdminStats | null;
  onEmail: (u: UserDetail) => void;
  onBulkEmail: (recipients: UserDetail[]) => void;
}) {
  const active = users.filter(u => u.status === 'trial');
  const expired = users.filter(u => u.status === 'expired');
  // Abandoned-checkout users — started a free trial flow but didn't enter
  // card details on Stripe (so no subscription was ever created). With the
  // create-checkout fix that stopped the premature trial_claims insert,
  // future users won't have this state. Legacy rows (e.g. Ray Beauty Luxe)
  // still exist: their trial_claims row was inserted before the fix but no
  // Stripe sub followed. They're the highest-leverage email-back segment.
  // Detected as: has_trial=true (trial_claims row exists) AND status='free'
  // (no Stripe sub of any kind).
  const noPlan = users.filter(u => u.has_trial && u.status === 'free');

  // Selection state for the "Without Plan" bulk-email view.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = noPlan.length > 0 && noPlan.every(u => selected.has(u.id));
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(noPlan.map(u => u.id)));
  };
  const selectedUsers = noPlan.filter(u => selected.has(u.id));

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Clock} label="Active Trials" value={stats.activeTrials.toLocaleString()} accent />
        <KpiCard icon={AlertTriangle} label="Abandoned Checkout" value={noPlan.length.toLocaleString()} />
        <KpiCard icon={TrendingUp} label="Conversion Rate" value={`${stats.trialConversionRate}%`} accent />
        <KpiCard icon={Activity} label="Avg. Trial Length" value={`${stats.trialAvgLength} days`} />
      </div>

      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">Active ({active.length})</TabsTrigger>
          <TabsTrigger value="noplan">Abandoned ({noPlan.length})</TabsTrigger>
          <TabsTrigger value="expired">Expired ({expired.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active">
          <Card>
            <CardContent className="p-0">
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Days Left</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {active.map(u => {
                      const warn = (u.trial_days_left ?? 99) <= 3;
                      return (
                        <TableRow key={u.id}>
                          <TableCell className="text-sm">{u.display_name || '—'}</TableCell>
                          <TableCell className="text-xs">{u.email}</TableCell>
                          <TableCell className="text-xs">
                            {u.plan ? (
                              <span className="font-medium">{u.plan}</span>
                            ) : (
                              <span className="text-warning font-medium">No plan selected</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{fmtDate(u.trial_started_at)}</TableCell>
                          <TableCell className={cn('text-xs font-mono', warn && 'text-warning font-bold')}>
                            {u.trial_days_left}d {warn && '⚠'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onEmail(u)}>
                              <Mail className="w-3 h-3" /> Email
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {active.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No active trials.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Abandoned-checkout users: bulk-email-able list ─── */}
        <TabsContent value="noplan">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Abandoned checkout</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    Users who clicked "7-day free trial" but didn't enter card details on Stripe — so no subscription was ever created. Select them to bulk-email a come-back reminder.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5 bg-gradient-to-r from-primary to-accent text-primary-foreground"
                  disabled={selectedUsers.length === 0}
                  onClick={() => onBulkEmail(selectedUsers)}
                >
                  <Send className="w-3.5 h-3.5" />
                  Email selected ({selectedUsers.length})
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={toggleAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Started Checkout</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {noPlan.map(u => (
                      <TableRow key={u.id} data-state={selected.has(u.id) ? 'selected' : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(u.id)}
                            onCheckedChange={() => toggleOne(u.id)}
                            aria-label={`Select ${u.email}`}
                          />
                        </TableCell>
                        <TableCell className="text-sm">{u.display_name || '—'}</TableCell>
                        <TableCell className="text-xs">{u.email}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(u.trial_started_at)}</TableCell>
                        <TableCell className="text-xs">
                          <span className="text-warning font-medium">No card entered</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onEmail(u)}>
                            <Mail className="w-3 h-3" /> Email
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {noPlan.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No abandoned checkouts. 🎉</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expired">
          <Card>
            <CardContent className="p-0">
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Expired</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expired.map(u => (
                      <TableRow key={u.id} className="text-muted-foreground">
                        <TableCell className="text-sm">{u.display_name || '—'}</TableCell>
                        <TableCell className="text-xs">{u.email}</TableCell>
                        <TableCell className="text-xs">{fmtDate(u.trial_started_at)}</TableCell>
                        <TableCell className="text-xs">{fmtDate(u.trial_expires_at)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onEmail(u)}>
                            <Mail className="w-3 h-3" /> Email
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {expired.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No expired trials.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ===== Sales Tab =====
function SalesTab({ stats, transactions }: { stats: AdminStats | null; transactions: Transaction[] }) {
  if (!stats) return null;
  const totalMonthly = Object.values(stats.planBreakdown).reduce((s, p) => s + p.revenue, 0) || 1;
  const arpu = stats.paidSubscribers > 0 ? Math.round(totalMonthly / stats.paidSubscribers) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={DollarSign} label="Month to Date" value={fmtCurrency(stats.mtdRevenue)} accent />
        <KpiCard icon={TrendingUp} label="Year Revenue" value={fmtCurrency(stats.yearRevenue)} />
        <KpiCard icon={Users} label="ARPU" value={`${fmtCurrency(arpu)}/mo`} />
        <KpiCard icon={DollarSign} label="MRR (active)" value={fmtCurrency(totalMonthly)} accent />
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Revenue by Plan</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Subscribers</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Monthly Revenue</TableHead>
                <TableHead className="text-right">% of Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(stats.planBreakdown).map(([name, p]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell className="text-right font-mono">{p.count}</TableCell>
                  <TableCell className="text-right font-mono">${p.price}/mo</TableCell>
                  <TableCell className="text-right font-mono">{fmtCurrency(p.revenue)}</TableCell>
                  <TableCell className="text-right font-mono">{Math.round((p.revenue / totalMonthly) * 100)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Recent Transactions</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {transactions.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No recent transactions.</p>
          )}
          {transactions.map((t, i) => (
            <div key={i} className="flex items-center justify-between p-3 rounded-md bg-muted/40 border">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{t.description}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(new Date(t.date * 1000).toISOString())}</p>
              </div>
              <p className={cn('font-mono text-sm font-bold', t.amount >= 0 ? 'text-success' : 'text-destructive')}>
                {t.amount >= 0 ? '+' : ''}{fmtCurrency(t.amount, t.currency)}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Email Tab =====
type BulkAudience = 'free' | 'expired' | 'free_and_expired' | 'trial' | 'all_non_paid' | 'all';

function EmailTab({ users, emails, onRefresh }: { users: UserDetail[]; emails: EmailLog[]; onRefresh: () => void }) {
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Bulk state
  const [bulkSubject, setBulkSubject] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkAudience, setBulkAudience] = useState<BulkAudience>('all_non_paid');
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const audienceUsers = useMemo(() => {
    return users.filter(u => {
      if (!u.email) return false;
      switch (bulkAudience) {
        case 'free': return u.status === 'free';
        case 'expired': return u.status === 'expired';
        case 'trial': return u.status === 'trial';
        case 'free_and_expired': return u.status === 'free' || u.status === 'expired';
        case 'all_non_paid': return u.status !== 'paid';
        case 'all': return true;
      }
    });
  }, [users, bulkAudience]);

  const handleBulkSend = async () => {
    if (!bulkSubject.trim() || !bulkMessage.trim()) {
      toast.error('Subject and message are required');
      return;
    }
    if (audienceUsers.length === 0) {
      toast.error('No recipients in selected audience');
      return;
    }
    setBulkSending(true);
    setBulkConfirmOpen(false);
    try {
      const { data, error } = await supabase.functions.invoke('admin-send-email', {
        body: {
          subject: bulkSubject.trim(),
          message: bulkMessage.trim(),
          recipients: audienceUsers.map(u => ({ email: u.email, name: u.display_name || undefined })),
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Queued ${data?.queued ?? 0} of ${data?.total ?? audienceUsers.length} emails${data?.failed ? ` (${data.failed} failed)` : ''}`);
      setBulkSubject(''); setBulkMessage('');
      setTimeout(onRefresh, 2000);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send bulk email');
    } finally {
      setBulkSending(false);
    }
  };

  const handleSend = async () => {
    if (!recipient || !subject || !message) {
      toast.error('All fields are required');
      return;
    }
    setSending(true);
    try {
      const target = users.find(u => u.email?.toLowerCase() === recipient.trim().toLowerCase());
      const { data, error } = await supabase.functions.invoke('admin-send-email', {
        body: {
          recipientEmail: recipient.trim(),
          recipientName: target?.display_name || undefined,
          subject: subject.trim(),
          message: message.trim(),
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Email queued to ${recipient}`);
      setRecipient(''); setSubject(''); setMessage('');
      setTimeout(onRefresh, 1500);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const statusColor = (s: string) =>
    s === 'sent' ? 'bg-success/15 text-success border-success/30'
    : s === 'pending' ? 'bg-muted text-muted-foreground'
    : s === 'suppressed' ? 'bg-warning/15 text-warning border-warning/30'
    : 'bg-destructive/15 text-destructive border-destructive/30';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Email individual user</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="r">Recipient email</Label>
            <Input id="r" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="user@example.com" list="user-emails" />
            <datalist id="user-emails">
              {users.map(u => <option key={u.id} value={u.email} />)}
            </datalist>
          </div>
          <div>
            <Label htmlFor="s">Subject</Label>
            <Input id="s" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Email subject line..." />
          </div>
          <div>
            <Label htmlFor="m">Message</Label>
            <Textarea id="m" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} rows={6} placeholder="Write your message here..." />
            <p className="text-xs text-muted-foreground mt-1">{message.length}/5000</p>
          </div>
          <Button onClick={handleSend} disabled={sending} className="gap-2">
            <Send className="w-3.5 h-3.5" />
            {sending ? 'Sending...' : 'Send email'}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="w-4 h-4" /> Bulk marketing email
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Send to multiple users at once. Recipients on the unsubscribe / suppression list are automatically skipped, and every email includes a one-click unsubscribe link.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Audience</Label>
            <Select value={bulkAudience} onValueChange={(v) => setBulkAudience(v as BulkAudience)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all_non_paid">All non-paid users (free + trial + expired)</SelectItem>
                <SelectItem value="free_and_expired">Free + expired trials</SelectItem>
                <SelectItem value="free">Free users only</SelectItem>
                <SelectItem value="trial">Active trial users</SelectItem>
                <SelectItem value="expired">Expired trial users</SelectItem>
                <SelectItem value="all">Everyone (including paid)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {audienceUsers.length} recipient{audienceUsers.length === 1 ? '' : 's'} match this audience.
            </p>
          </div>
          <div>
            <Label htmlFor="bs">Subject</Label>
            <Input id="bs" value={bulkSubject} onChange={(e) => setBulkSubject(e.target.value)} maxLength={200} placeholder="e.g. Unlock your 7-day free trial..." />
          </div>
          <div>
            <Label htmlFor="bm">Message</Label>
            <Textarea id="bm" value={bulkMessage} onChange={(e) => setBulkMessage(e.target.value)} maxLength={5000} rows={8} placeholder="Write your marketing message..." />
            <p className="text-xs text-muted-foreground mt-1">{bulkMessage.length}/5000</p>
          </div>
          <Button
            onClick={() => setBulkConfirmOpen(true)}
            disabled={bulkSending || audienceUsers.length === 0 || !bulkSubject || !bulkMessage}
            className="gap-2"
          >
            <Send className="w-3.5 h-3.5" />
            {bulkSending ? 'Queuing...' : `Send to ${audienceUsers.length} user${audienceUsers.length === 1 ? '' : 's'}`}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send bulk email?</DialogTitle>
            <DialogDescription>
              You're about to queue <strong>{audienceUsers.length}</strong> email{audienceUsers.length === 1 ? '' : 's'} to the <strong>{bulkAudience.replace(/_/g, ' ')}</strong> audience. Suppressed/unsubscribed addresses are skipped automatically. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkSend} disabled={bulkSending}>Confirm & send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent emails ({emails.length})</CardTitle>
          <Button size="sm" variant="outline" onClick={onRefresh} className="gap-2"><RefreshCw className="w-3 h-3" />Refresh</Button>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[400px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emails.map(e => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{e.template_name}</TableCell>
                    <TableCell className="text-xs">{e.recipient_email}</TableCell>
                    <TableCell><span className={cn('text-[10px] px-2 py-0.5 rounded-full border', statusColor(e.status))}>{e.status}</span></TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(e.created_at)}</TableCell>
                    <TableCell className="text-xs text-destructive max-w-[200px] truncate">{e.error_message || '—'}</TableCell>
                  </TableRow>
                ))}
                {emails.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No emails sent yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Sessions Tab =====
function SessionsTab({ sessions }: { sessions: RecentSession[] }) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Recent Sessions</CardTitle></CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[600px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-center">DMs</TableHead>
                <TableHead className="text-center">Likes</TableHead>
                <TableHead className="text-center">Follows</TableHead>
                <TableHead>Mode</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map(s => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.user_id.slice(0, 8)}…</TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px]">{s.platform}</Badge></TableCell>
                  <TableCell className="text-xs">{s.instagram_account_username || '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(s.started_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{fmtDuration(s.duration_seconds)}</TableCell>
                  <TableCell className="text-center font-mono text-sm">{s.dms_sent}</TableCell>
                  <TableCell className="text-center font-mono text-sm">{s.likes_sent}</TableCell>
                  <TableCell className="text-center font-mono text-sm">{s.follows_sent}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-[10px]">{s.targeting_mode}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ===== UI bits =====
function StatusBadge({ u }: { u: UserDetail }) {
  if (u.status === 'paid') return <Badge className="bg-success/15 text-success hover:bg-success/20 border-success/30">Active</Badge>;
  if (u.status === 'trial') return <Badge className="bg-warning/15 text-warning hover:bg-warning/20 border-warning/30">Trial ({u.trial_days_left ?? '?'}d)</Badge>;
  if (u.status === 'expired') return <Badge variant="destructive" className="text-[10px]">Expired</Badge>;
  return <Badge variant="outline" className="text-[10px]">Free</Badge>;
}

function KpiCard({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground font-medium">{label}</span>
          <Icon className={cn('w-4 h-4', accent ? 'text-primary' : 'text-muted-foreground')} />
        </div>
        <p className={cn('text-2xl font-bold font-mono', accent && 'text-primary')}>{value}</p>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold font-mono">{value}</p>
    </div>
  );
}

function StatMini({ icon: Icon, label, value, accent }: { icon: any; label: string; value: number; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3 flex items-center gap-2">
        <Icon className={cn("w-4 h-4 shrink-0", accent ? "text-primary" : "text-muted-foreground")} />
        <div className="min-w-0">
          <p className="text-[10px] text-muted-foreground truncate">{label}</p>
          <p className={cn("text-base font-bold font-mono", accent && "text-primary")}>{fmtCompact(value)}</p>
        </div>
      </CardContent>
    </Card>
  );
}
