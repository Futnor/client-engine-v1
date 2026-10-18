import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { BotConfig, EngagementMonitorConfig } from '@/lib/botEngine';
import { MessageCircle, Heart, UserPlus, Plus, X, Zap, Eye, Play, Square, Loader2, Link, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { SubscriptionTier, getTierLimits } from '@/lib/subscriptionTiers';

const COMMAND_KEY = 'futnor_command';
const EXT_STATUS_KEY = 'futnor_ext_status';

function sendExtensionCommand(cmd: Record<string, unknown>) {
  try {
    const payload = { ...cmd, processed: false, timestamp: Date.now() };
    localStorage.setItem(COMMAND_KEY, JSON.stringify(payload));
    window.postMessage({ source: 'futnor-web', command: payload }, '*');
  } catch (error) {
    console.error('[Futnor Web] Error sending extension command:', error);
  }
}

interface EngagementMonitorProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
  tier?: SubscriptionTier;
}

export function EngagementMonitor({ config, onChange, disabled, tier = 'free' }: EngagementMonitorProps) {
  const limits = getTierLimits(tier);
  const engageDmLevel = limits.engageDm; // false | 'limited' | 'full'
  const isLimited = engageDmLevel === 'limited';
  const [keywordInput, setKeywordInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [starting, setStarting] = useState(false);
  const monitor = config.engagementMonitor || {
    enabled: false, postUrl: '', postUrls: [], triggerKeywords: [], commentToDm: true,
    likeToDm: false, followToDm: false, dmScript: '',
    fastMode: false, scanAllPosts: true,
  };

  // Sync monitoring state from extension status
  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const raw = localStorage.getItem(EXT_STATUS_KEY);
        if (!raw) return;
        const status = JSON.parse(raw);
        setIsMonitoring(!!status?.isRunning);
      } catch {}
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const update = (partial: Partial<EngagementMonitorConfig>) => {
    onChange({
      ...config,
      engagementMonitor: { ...monitor, ...partial },
    });
  };

  const postUrls = monitor.postUrls || (monitor.postUrl ? [monitor.postUrl] : []);

  const addUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/instagram\.com\/(p|reel)\//.test(url)) {
      toast.error('Please enter a valid Instagram post or reel URL');
      return;
    }
    if (postUrls.includes(url)) {
      toast.error('This URL is already added');
      return;
    }
    if (isLimited && postUrls.length >= 1) {
      toast.error('Launch plan is limited to 1 post URL. Upgrade to Growth for more.');
      return;
    }
    update({ postUrls: [...postUrls, url], postUrl: url });
    setUrlInput('');
  };

  const removeUrl = (url: string) => {
    const updated = postUrls.filter(u => u !== url);
    update({ postUrls: updated, postUrl: updated[0] || '' });
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addUrl();
    }
  };

  const addKeyword = () => {
    const kw = keywordInput.trim().toLowerCase();
    if (!kw || monitor.triggerKeywords.includes(kw)) return;
    update({ triggerKeywords: [...monitor.triggerKeywords, kw] });
    setKeywordInput('');
  };

  const removeKeyword = (kw: string) => {
    update({ triggerKeywords: monitor.triggerKeywords.filter(k => k !== kw) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKeyword();
    }
  };

  const startMonitor = () => {
    if (postUrls.length === 0) {
      toast.error('Please add at least one post URL to monitor');
      return;
    }
    if (!monitor.dmScript.trim()) {
      toast.error('Please enter a DM script');
      return;
    }
    if (!monitor.commentToDm && !monitor.likeToDm && !monitor.followToDm) {
      toast.error('Enable at least one trigger type');
      return;
    }

    setStarting(true);
    sendExtensionCommand({
      type: 'START_ENGAGEMENT_MONITOR',
      engagementMonitor: {
        postUrls: postUrls,
        triggerKeywords: monitor.triggerKeywords,
        commentToDm: monitor.commentToDm,
        likeToDm: monitor.likeToDm,
        followToDm: monitor.followToDm,
        dmScript: monitor.dmScript.trim(),
        // New v2.4.94 controls — forward to the extension
        fastMode: !!monitor.fastMode,
        scanAllPosts: monitor.scanAllPosts !== false,
      },
    });

    setTimeout(() => {
      setStarting(false);
      setIsMonitoring(true);
      toast.success('Engagement monitor started!');
    }, 2000);
  };

  const stopMonitor = () => {
    sendExtensionCommand({ type: 'STOP_ENGAGEMENT_MONITOR' });
    setIsMonitoring(false);
    toast.info('Engagement monitor stopped');
  };

  return (
    <div className="space-y-5">
      {/* Launch plan limitation banner */}
      {isLimited && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-200 text-xs">
          <Lock className="w-4 h-4 shrink-0" />
          <span><strong>Launch plan:</strong> Limited to 1 post URL, no keyword filters. Upgrade to Growth for full access.</span>
        </div>
      )}

      {/* Enable toggle */}
      <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center">
            <Zap className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Engagement Monitor</p>
            <p className="text-xs text-muted-foreground">Auto-DM users who engage with your post</p>
          </div>
        </div>
        <Switch
          checked={monitor.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          disabled={disabled || isMonitoring}
        />
      </div>

      {monitor.enabled && (
        <div className="space-y-4 animate-fade-in">
          {/* Post URLs */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Post / Reel URLs to Monitor
              <span className="text-[10px] text-muted-foreground/70 ml-1">({postUrls.length} added)</span>
            </label>
            <div className="flex gap-2">
              <Input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={handleUrlKeyDown}
                placeholder="https://www.instagram.com/p/ABC123..."
                className="bg-input border-border text-sm flex-1"
                disabled={disabled || isMonitoring}
              />
              <Button
                onClick={addUrl}
                size="sm"
                variant="outline"
                disabled={disabled || isMonitoring || !urlInput.trim()}
                className="gap-1"
              >
                <Plus className="w-3 h-3" /> Add
              </Button>
            </div>
            {postUrls.length > 0 && (
              <div className="space-y-1 mt-1.5">
                {postUrls.map((url, i) => (
                  <div key={url} className="flex items-center gap-1.5 p-1.5 rounded bg-background/50 border border-border text-[11px]">
                    <Link className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1 text-foreground">{url.replace('https://www.instagram.com', '')}</span>
                    <button
                      onClick={() => removeUrl(url)}
                      className="ml-auto rounded-full hover:bg-muted p-0.5 shrink-0"
                      disabled={disabled || isMonitoring}
                    >
                      <X className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">Add one or more Instagram post/reel links — bot will cycle through all of them</p>
          </div>

          {/* Trigger types */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">DM Triggers</label>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
                <div className="flex items-center gap-2.5">
                  <MessageCircle className="w-4 h-4 text-accent" />
                  <div>
                    <p className="text-xs font-medium text-foreground">Comment → DM</p>
                    <p className="text-[10px] text-muted-foreground">DM users who comment a trigger word</p>
                  </div>
                </div>
                <Switch
                  checked={monitor.commentToDm}
                  onCheckedChange={(commentToDm) => update({ commentToDm })}
                  disabled={disabled || isMonitoring}
                />
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
                <div className="flex items-center gap-2.5">
                  <Heart className="w-4 h-4 text-destructive" />
                  <div>
                    <p className="text-xs font-medium text-foreground">Like → DM</p>
                    <p className="text-[10px] text-muted-foreground">DM anyone who likes the post</p>
                  </div>
                </div>
                <Switch
                  checked={monitor.likeToDm}
                  onCheckedChange={(likeToDm) => update({ likeToDm })}
                  disabled={disabled || isMonitoring}
                />
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
                <div className="flex items-center gap-2.5">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <div>
                    <p className="text-xs font-medium text-foreground">Follow → DM</p>
                    <p className="text-[10px] text-muted-foreground">DM anyone who follows your account</p>
                  </div>
                </div>
                <Switch
                  checked={monitor.followToDm}
                  onCheckedChange={(followToDm) => update({ followToDm })}
                  disabled={disabled || isMonitoring}
                />
              </div>
            </div>
          </div>

          {/* Trigger keywords (for comment-to-dm) */}
          {monitor.commentToDm && !isLimited && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Trigger Keywords <span className="text-[10px] text-muted-foreground/70">(comment must contain one of these)</span>
              </label>
              <div className="flex gap-2">
                <Input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder='e.g. "boost", "info", "interested"'
                  className="bg-input border-border text-sm flex-1"
                  disabled={disabled || isMonitoring}
                />
                <Button
                  onClick={addKeyword}
                  size="sm"
                  variant="outline"
                  disabled={disabled || isMonitoring || !keywordInput.trim()}
                  className="gap-1"
                >
                  <Plus className="w-3 h-3" /> Add
                </Button>
              </div>
              {monitor.triggerKeywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {monitor.triggerKeywords.map((kw) => (
                    <Badge key={kw} variant="secondary" className="gap-1 text-[11px] pr-1">
                      {kw}
                      <button
                        onClick={() => removeKeyword(kw)}
                        className="ml-0.5 rounded-full hover:bg-muted p-0.5"
                        disabled={disabled || isMonitoring}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {monitor.triggerKeywords.length === 0 && (
                <p className="text-[10px] text-warning">
                  ⚠ No keywords set — all comments will trigger a DM
                </p>
              )}
            </div>
          )}

          {/* ── Speed / scan strategy ── */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Speed &amp; Scan Strategy</label>

            <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
              <div className="flex items-center gap-2.5">
                <Zap className="w-4 h-4 text-warning" />
                <div>
                  <p className="text-xs font-medium text-foreground">Fast mode (for ads)</p>
                  <p className="text-[10px] text-muted-foreground">
                    Scans every 3–6 s so ad commenters get DMed within seconds. Use only for paid ads / launches — too aggressive on organic posts.
                  </p>
                </div>
              </div>
              <Switch
                checked={!!monitor.fastMode}
                onCheckedChange={(fastMode) => update({ fastMode })}
                disabled={disabled || isMonitoring}
              />
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
              <div className="flex items-center gap-2.5">
                <Eye className="w-4 h-4 text-accent" />
                <div>
                  <p className="text-xs font-medium text-foreground">Scan all posts every cycle</p>
                  <p className="text-[10px] text-muted-foreground">
                    On (recommended): every post is checked each cycle. Off: round-robin one post per cycle (slower for multi-ad campaigns).
                  </p>
                </div>
              </div>
              <Switch
                checked={monitor.scanAllPosts !== false}
                onCheckedChange={(scanAllPosts) => update({ scanAllPosts })}
                disabled={disabled || isMonitoring}
              />
            </div>
          </div>

          {/* DM Script */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">DM Script</label>
            <Textarea
              value={monitor.dmScript}
              onChange={(e) => update({ dmScript: e.target.value })}
              placeholder={`Hey! Thanks for showing interest 🙌\n\nHere's the free marketing guide I mentioned...\n\nLet me know if you have any questions!`}
              className="bg-input border-border text-sm min-h-[100px] resize-none"
              disabled={disabled || isMonitoring}
            />
            <p className="text-[10px] text-muted-foreground">This message will be sent to users who trigger the DM</p>
          </div>

          {/* How it works */}
          <div className="rounded-lg border border-dashed border-accent/40 bg-accent/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Eye className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-semibold text-accent">How it works</span>
            </div>
            <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Bot cycles through your {postUrls.length || 'added'} post{postUrls.length !== 1 ? 's' : ''} and monitors each one</li>
              {monitor.commentToDm && (
                <li>
                  When someone comments{' '}
                  {monitor.triggerKeywords.length > 0
                    ? `"${monitor.triggerKeywords.join('" or "')}"` 
                    : '(any comment)'}
                  , bot opens their profile and sends the DM
                </li>
              )}
              {monitor.likeToDm && <li>When someone likes the post, bot opens their profile and sends the DM</li>}
              {monitor.followToDm && <li>When someone new follows you, bot opens their profile and sends the DM</li>}
              <li>Bot moves to the next post and repeats</li>
            </ol>
          </div>

          {/* Start / Stop */}
          <div className="flex gap-2">
            {isMonitoring ? (
              <Button
                onClick={stopMonitor}
                variant="destructive"
                className="w-full gap-2"
              >
                <Square className="w-4 h-4" /> Stop Monitoring
              </Button>
            ) : (
              <Button
                onClick={startMonitor}
                disabled={disabled || starting || postUrls.length === 0 || !monitor.dmScript.trim()}
                className="w-full gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground"
              >
                {starting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Starting...</>
                ) : (
                  <><Play className="w-4 h-4" /> Start Monitoring</>
                )}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
