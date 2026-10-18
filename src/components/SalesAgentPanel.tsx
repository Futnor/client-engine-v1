import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { SalesAgentOnboarding } from './SalesAgentOnboarding';
import logo from '@/assets/logo.png';
import type { SubscriptionTier } from '@/lib/subscriptionTiers';
import {
  MessageCircle, Clock, RefreshCw, ChevronDown, ChevronUp,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface AgentSession {
  id: string;
  customer_identifier: string;
  platform: string;
  message_count: number;
  last_message_at: string;
}

const SALES_AGENT_COMMAND_KEY = 'futnor_sales_agent_command';
const SALES_AGENT_STATUS_KEY = 'futnor_sales_agent_status';

function sendSalesAgentCommand(cmd: Record<string, any>) {
  try {
    const payload = { ...cmd, processed: false, timestamp: Date.now() };
    localStorage.setItem(SALES_AGENT_COMMAND_KEY, JSON.stringify(payload));
    window.postMessage({ source: 'futnor-web', salesAgent: payload }, '*');
  } catch {}
}

function getSalesAgentStatus(): { active: boolean; lastScan?: number; platform?: string } | null {
  try {
    const raw = localStorage.getItem(SALES_AGENT_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface SalesAgentPanelProps {
  extensionConnected: boolean;
  platform: 'instagram' | 'tiktok';
  tier?: SubscriptionTier;
}

type AgentPlatform = 'instagram' | 'tiktok' | 'whatsapp';

const PLATFORM_LABELS: Record<AgentPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  whatsapp: 'WhatsApp',
};

export function SalesAgentPanel({ extensionConnected, platform, tier = 'free' }: SalesAgentPanelProps) {
  const isUnlocked = tier === 'admin';
  const isScaleLocked = tier === 'scale';

  const [isActive, setIsActive] = useState(false);
  const [runningPlatform, setRunningPlatform] = useState<AgentPlatform | null>(null);
  const [activePlatform, setActivePlatform] = useState<AgentPlatform>(platform);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await supabase.functions.invoke('sales-agent', {
        body: { action: 'list-sessions' },
      });
      if (data?.sessions) setSessions(data.sessions);
    } catch {}
  }, []);

  const checkProfile = useCallback(async () => {
    try {
      const { data } = await supabase.functions.invoke('sales-agent', {
        body: { action: 'get-profile' },
      });
      setHasProfile(!!data?.profile);
      if (!data?.profile) setShowSetup(true);
    } catch {}
  }, []);

  useEffect(() => {
    checkProfile();
    loadSessions();
  }, [checkProfile, loadSessions]);

  // Poll extension status
  useEffect(() => {
    const poll = window.setInterval(() => {
      const status = getSalesAgentStatus();
      if (status) {
        setIsActive(status.active);
        if (status.active && status.platform) {
          setRunningPlatform(status.platform as AgentPlatform);
        } else if (!status.active) {
          setRunningPlatform(null);
        }
        if (status.lastScan) setLastScan(status.lastScan);
      }
    }, 1500);
    return () => window.clearInterval(poll);
  }, []);

  async function handleToggle(checked: boolean) {
    if (checked) {
      if (!extensionConnected) {
        toast.error('Extension not connected');
        return;
      }
      if (!hasProfile) {
        toast.error('Set up your business profile first');
        setShowSetup(true);
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      sendSalesAgentCommand({
        type: 'START_SALES_AGENT',
        platform: activePlatform,
        authToken: session?.access_token,
      });
      setIsActive(true);
      setRunningPlatform(activePlatform);
      toast.success('AI agent activated — scanning inbox for new DMs');
    } else {
      sendSalesAgentCommand({ type: 'STOP_SALES_AGENT' });
      setIsActive(false);
      setRunningPlatform(null);
      toast('AI agent paused');
    }
  }

  if (!isUnlocked) {
    return (
      <div className="space-y-3 text-center py-6">
        <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
          <MessageCircle className="w-6 h-6 text-muted-foreground" />
        </div>
        <h4 className="text-sm font-semibold">AI Sales Agent</h4>
        {isScaleLocked ? (
          <>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              The AI Sales Agent is currently <span className="font-semibold text-warning">under maintenance</span>. We're improving the experience and it will be back soon.
            </p>
            <Badge variant="outline" className="text-xs">🔧 Under Maintenance</Badge>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Auto-reply to incoming DMs with AI-powered sales messages. Available on the <span className="font-semibold text-primary">Scale</span> plan.
            </p>
            <Badge variant="outline" className="text-xs">Scale Plan Required</Badge>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={logo} alt="Client Engine" className="w-4 h-4" />
          <Label className="text-sm font-medium">Auto-Reply Sales Agent</Label>
        </div>
        <div className="flex items-center gap-3">
          {lastScan && (
            <span className="text-[10px] text-muted-foreground">
              Last scan: {formatDistanceToNow(lastScan, { addSuffix: true })}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
            <span className="text-xs text-muted-foreground">
              {isActive
                ? `Active${runningPlatform ? ` on ${PLATFORM_LABELS[runningPlatform]}` : ''}`
                : 'Off'}
            </span>
          </div>
          <Switch checked={isActive} onCheckedChange={handleToggle} />
        </div>
      </div>
      {/* Platform selector */}
      <div className="flex items-center gap-2">
        {(['instagram', 'tiktok', 'whatsapp'] as AgentPlatform[]).map((p) => (
          <button
            key={p}
            onClick={() => {
              setActivePlatform(p);
              if (isActive) {
                sendSalesAgentCommand({ type: 'STOP_SALES_AGENT' });
                setTimeout(async () => {
                  const { data: { session } } = await supabase.auth.getSession();
                  sendSalesAgentCommand({ type: 'START_SALES_AGENT', platform: p, authToken: session?.access_token });
                }, 500);
              }
            }}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              activePlatform === p
                ? 'bg-primary/20 border-primary text-primary font-medium'
                : 'border-border text-muted-foreground hover:border-primary/50'
            }`}
          >
            {PLATFORM_LABELS[p]}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        When active, the agent monitors your {PLATFORM_LABELS[activePlatform]} inbox every 30–60s and replies to new DMs automatically — handling objections, qualifying leads, and closing sales using your business context.
        {activePlatform === 'whatsapp' && (
          <span className="block mt-1 text-warning text-[10px]">
            💡 WhatsApp Web must be open in a browser tab. For always-on WhatsApp, the Business API integration is also available.
          </span>
        )}
      </p>

      {/* Recent conversations — filtered by selected platform */}
      {sessions.filter(s => s.platform === activePlatform).length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {PLATFORM_LABELS[activePlatform]} Conversations
            </h4>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={loadSessions}>
              <RefreshCw className="w-3 h-3" /> Refresh
            </Button>
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {sessions.filter(s => s.platform === activePlatform).slice(0, 10).map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-card/50 border border-border/50 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MessageCircle className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="font-medium truncate">@{s.customer_identifier}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                    {s.platform}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground shrink-0">
                  <span>{s.message_count} msgs</span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDistanceToNow(new Date(s.last_message_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Setup toggle */}
      <button
        onClick={() => setShowSetup(!showSetup)}
        className="flex items-center gap-1 text-xs text-primary hover:underline"
      >
        {showSetup ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {showSetup ? 'Hide' : hasProfile ? 'Edit' : '⚡ Set Up'} Business Profile
      </button>

      {showSetup && <SalesAgentOnboarding />}
    </div>
  );
}
