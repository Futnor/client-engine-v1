import { useState, useRef, useCallback } from 'react';
import { BotConfig, TargetType, TargetingConfig } from '@/lib/botEngine';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { HashtagAutocomplete } from '@/components/HashtagAutocomplete';

import {
  Users,
  UserPlus,
  Heart,
  MessageCircle,
  MessageSquare,
  Hash,
  MapPin,
  UserCheck,
  Upload,
  X,
  Target,
  Lock,
  Briefcase,
  Clock,
} from 'lucide-react';
import { toast } from 'sonner';

interface TargetingPanelProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
}

const TARGET_OPTIONS: { value: TargetType; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'followers', label: 'Followers', icon: Users, description: 'Target followers of specific accounts' },
  { value: 'following', label: 'Following', icon: UserPlus, description: 'Target accounts they follow' },
  { value: 'likers', label: 'Likers', icon: Heart, description: 'Target users who liked specific posts' },
  { value: 'commenters', label: 'Commenters', icon: MessageCircle, description: 'Target users who commented' },
  { value: 'hashtags', label: 'Hashtags', icon: Hash, description: 'Target users posting with hashtags' },
  { value: 'location', label: 'Location', icon: MapPin, description: 'Target users from a location' },
  { value: 'custom', label: 'Custom Users', icon: UserCheck, description: 'Provide a list of usernames' },
];

export function TargetingPanel({ config, onChange, disabled }: TargetingPanelProps) {
  const [usernameInput, setUsernameInput] = useState('');
  const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const targeting = config.targeting;

  const updateTargeting = (partial: Partial<TargetingConfig>) => {
    onChange({ ...config, targeting: { ...targeting, ...partial } });
  };

  const toggleTargetType = (type: TargetType) => {
    updateTargeting({ targetTypes: [type] });
  };

  const addUsernames = (names: string[]) => {
    const cleaned = names
      .map((n) => n.trim().replace(/^@/, ''))
      .filter((n) => n.length > 0 && !targeting.customUsernames.includes(n));
    if (cleaned.length === 0) return;
    updateTargeting({ customUsernames: [...targeting.customUsernames, ...cleaned] });
    toast.success(`${cleaned.length} username(s) added`);
  };

  const handleAddManual = () => {
    if (!usernameInput.trim()) return;
    const names = usernameInput.split(/[,\n\s]+/);
    addUsernames(names);
    setUsernameInput('');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const names = text.split(/[,\n\r]+/);
      addUsernames(names);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const removeUsername = (name: string) => {
    updateTargeting({ customUsernames: targeting.customUsernames.filter((n) => n !== name) });
    setSelectedUsernames((prev) => { const next = new Set(prev); next.delete(name); return next; });
  };

  const toggleSelectUsername = (name: string) => {
    setSelectedUsernames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const selectAll = () => setSelectedUsernames(new Set(targeting.customUsernames));
  const deselectAll = () => setSelectedUsernames(new Set());

  const removeSelected = () => {
    const remaining = targeting.customUsernames.filter((n) => !selectedUsernames.has(n));
    const count = selectedUsernames.size;
    updateTargeting({ customUsernames: remaining });
    setSelectedUsernames(new Set());
    toast.success(`${count} username(s) removed`);
  };

  const clearAllUsernames = () => {
    const count = targeting.customUsernames.length;
    updateTargeting({ customUsernames: [] });
    setSelectedUsernames(new Set());
    toast.success(`${count} username(s) cleared`);
  };

  const isSelected = (type: TargetType) => targeting.targetTypes.includes(type);

  return (
    <div className="glass rounded-xl p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <Target className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">Targeting</h3>
      </div>

      {/* Target Types */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Choose one targeting method</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {TARGET_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => !disabled && toggleTargetType(value)}
              disabled={disabled}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-left transition-all text-sm ${
                isSelected(value)
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Hashtags input (shown when hashtags selected) */}
      {isSelected('hashtags') && (
        <div className="space-y-1.5 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-primary" /> Target Hashtags
          </label>
          <HashtagAutocomplete
            value={targeting.hashtags}
            onChange={(v) => updateTargeting({ hashtags: v })}
            disabled={disabled}
          />
          <p className="text-[10px] text-muted-foreground">Separate with commas</p>
        </div>
      )}

      {/* Location input (shown when location selected) */}
      {isSelected('location') && (
        <div className="space-y-1.5 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-primary" /> Instagram Location Link
          </label>
          <Input
            value={targeting.location}
            onChange={(e) => updateTargeting({ location: e.target.value })}
            placeholder="Paste Instagram location URL (e.g. instagram.com/explore/locations/12345/)"
            className="text-xs h-8 bg-input border-border"
            disabled={disabled}
          />
          <p className="text-[10px] text-muted-foreground">
            Paste a location URL from Instagram (e.g. https://www.instagram.com/explore/locations/12345/new-york/)
          </p>
        </div>
      )}

      {/* Username input (shown when followers or following selected) */}
      {(isSelected('followers') || isSelected('following')) && (
        <div className="space-y-1.5 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-primary" />
            {isSelected('followers') ? 'DM Followers Of' : 'DM Following Of'}
          </label>
          <Input
            value={targeting.targetUsername}
            onChange={(e) => updateTargeting({ targetUsername: e.target.value.replace(/^@/, '') })}
            placeholder="Enter @username (e.g. nike)"
            className="text-xs h-8 bg-input border-border"
            disabled={disabled}
          />
          <p className="text-[10px] text-muted-foreground">
            Enter the username whose {isSelected('followers') ? 'followers' : 'following'} you want to target
          </p>
        </div>
      )}

      {/* Post link input (shown when likers or commenters selected) */}
      {(isSelected('likers') || isSelected('commenters')) && (
        <div className="space-y-1.5 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <label className="text-xs font-medium flex items-center gap-1.5">
            {isSelected('likers') ? <Heart className="w-3.5 h-3.5 text-primary" /> : <MessageCircle className="w-3.5 h-3.5 text-primary" />}
            {isSelected('likers') ? 'DM Likers From Post' : 'DM Commenters From Post'}
          </label>
          <Input
            value={targeting.targetPostLink}
            onChange={(e) => updateTargeting({ targetPostLink: e.target.value })}
            placeholder="Paste post link (e.g. instagram.com/p/ABC123)"
            className="text-xs h-8 bg-input border-border"
            disabled={disabled}
          />
          <p className="text-[10px] text-muted-foreground">
            Enter the post URL whose {isSelected('likers') ? 'likers' : 'commenters'} you want to target
          </p>
        </div>
      )}

      {/* Commenter Network Loop toggle (shown when commenters selected) */}
      {isSelected('commenters') && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-accent/5 border border-accent/20">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v3m0 12v3m-6.36-2.64l2.12-2.12m8.48-8.48l2.12-2.12M3 12h3m12 0h3M5.64 5.64l2.12 2.12m8.48 8.48l2.12 2.12" />
            </svg>
            <div>
              <span className="text-xs font-medium">Commenter Network Loop</span>
              <p className="text-[10px] text-muted-foreground">
                After DMing commenters, visit their profiles, find their recent posts, and DM those commenters too — expanding indefinitely through networks
              </p>
            </div>
          </div>
          <Switch
            checked={targeting.commenterNetworkLoop}
            onCheckedChange={(v) => updateTargeting({ commenterNetworkLoop: v })}
            disabled={disabled}
          />
        </div>
      )}

      {/* Custom users (shown when custom selected) */}
      {isSelected('custom') && (
        <div className="space-y-3 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <label className="text-xs font-medium flex items-center gap-1.5">
            <UserCheck className="w-3.5 h-3.5 text-primary" /> Custom Usernames
          </label>

          <div className="flex gap-2">
            <Input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddManual()}
              placeholder="Type or paste usernames..."
              className="text-xs h-8 bg-input border-border"
              disabled={disabled}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddManual}
              disabled={disabled || !usernameInput.trim()}
              className="h-8 px-3 text-xs shrink-0"
            >
              Add
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              className="h-7 px-2.5 text-[11px] gap-1.5"
            >
              <Upload className="w-3 h-3" /> Upload .txt / .csv
            </Button>
            <span className="text-[10px] text-muted-foreground">One username per line</span>
          </div>

          {/* Username chips with bulk actions */}
          {targeting.customUsernames.length > 0 && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {!disabled && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={selectedUsernames.size === targeting.customUsernames.length ? deselectAll : selectAll}
                    >
                      {selectedUsernames.size === targeting.customUsernames.length ? 'Deselect All' : 'Select All'}
                    </Button>
                    {selectedUsernames.size > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={removeSelected}
                      >
                        Remove Selected ({selectedUsernames.size})
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-destructive hover:text-destructive"
                      onClick={clearAllUsernames}
                    >
                      Clear All
                    </Button>
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                {targeting.customUsernames.map((name) => (
                  <span
                    key={name}
                    onClick={() => !disabled && toggleSelectUsername(name)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors ${
                      selectedUsernames.has(name)
                        ? 'bg-destructive/20 text-destructive ring-1 ring-destructive/30'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    @{name}
                    {!disabled && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeUsername(name); }}
                        className="hover:text-destructive transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </>
          )}
          <p className="text-[10px] text-muted-foreground">
            {targeting.customUsernames.length} username(s) loaded{selectedUsernames.size > 0 ? ` · ${selectedUsernames.size} selected` : ''}
          </p>
        </div>
      )}

      {/* ── Account Filters ── */}
      <div className="space-y-3 pt-2 border-t border-border">
        <p className="text-xs font-semibold text-foreground">Account Filters</p>
        <p className="text-[10px] text-muted-foreground">Only target accounts that meet these criteria</p>

        {/* Public accounts only */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <div>
              <span className="text-xs font-medium">Public Accounts Only</span>
              <p className="text-[10px] text-muted-foreground">Skip private accounts — only DM users with public profiles</p>
            </div>
          </div>
          <Switch
            checked={targeting.publicAccountsOnly}
            onCheckedChange={(v) => updateTargeting({ publicAccountsOnly: v, includePrivateAccounts: v ? false : targeting.includePrivateAccounts })}
            disabled={disabled}
          />
        </div>

        {/* Include Private Accounts */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-muted-foreground" />
            <div>
              <span className="text-xs font-medium">Include Private Accounts</span>
              <p className="text-[10px] text-muted-foreground">Also target users with private profiles</p>
            </div>
          </div>
          <Switch
            checked={targeting.includePrivateAccounts}
            onCheckedChange={(v) => updateTargeting({ includePrivateAccounts: v, publicAccountsOnly: v ? false : targeting.publicAccountsOnly })}
            disabled={disabled}
          />
        </div>

        {/* Include Business Accounts */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <Briefcase className="w-3.5 h-3.5 text-muted-foreground" />
            <div>
              <span className="text-xs font-medium">Include Business Accounts</span>
              <p className="text-[10px] text-muted-foreground">Also target creator and business profiles</p>
            </div>
          </div>
          <Switch
            checked={targeting.includeBusinessAccounts}
            onCheckedChange={(v) => updateTargeting({ includeBusinessAccounts: v })}
            disabled={disabled}
          />
        </div>

        {/* Include New Accounts */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <div>
              <span className="text-xs font-medium">Include New Accounts</span>
              <p className="text-[10px] text-muted-foreground">Target recently created accounts (less than 30 days old)</p>
            </div>
          </div>
          <Switch
            checked={targeting.includeNewAccounts}
            onCheckedChange={(v) => updateTargeting({ includeNewAccounts: v })}
            disabled={disabled}
          />
        </div>

        {/* Include Verified Accounts */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></svg>
            <div>
              <span className="text-xs font-medium">Include Verified Accounts</span>
              <p className="text-[10px] text-muted-foreground">Also target accounts with a verified blue check</p>
            </div>
          </div>
          <Switch
            checked={targeting.includeVerifiedAccounts}
            onCheckedChange={(v) => updateTargeting({ includeVerifiedAccounts: v })}
            disabled={disabled}
          />
        </div>

        {/* Allow DMs to Existing Chats */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
            <div>
              <span className="text-xs font-medium">Message Existing Chats</span>
              <p className="text-[10px] text-muted-foreground">Allow the bot to DM accounts you already have an existing conversation with (off = skip them)</p>
            </div>
          </div>
          <Switch
            checked={targeting.allowExistingChats}
            onCheckedChange={(v) => updateTargeting({ allowExistingChats: v })}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Follower Count</span>
            </div>
            <Switch
              checked={targeting.filterFollowersEnabled}
              onCheckedChange={(v) => updateTargeting({ filterFollowersEnabled: v })}
              disabled={disabled}
            />
          </div>
          {targeting.filterFollowersEnabled && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Min</span>
                  <input
                    type="number"
                    value={targeting.filterFollowersMin}
                    onChange={(e) => updateTargeting({ filterFollowersMin: Math.max(0, Number(e.target.value) || 0) })}
                    disabled={disabled}
                    className="w-20 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterFollowersMin]}
                  onValueChange={([v]) => updateTargeting({ filterFollowersMin: v })}
                  min={0}
                  max={100000}
                  step={100}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Max</span>
                  <input
                    type="number"
                    value={targeting.filterFollowersMax}
                    onChange={(e) => updateTargeting({ filterFollowersMax: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={disabled}
                    className="w-20 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterFollowersMax]}
                  onValueChange={([v]) => updateTargeting({ filterFollowersMax: v })}
                  min={100}
                  max={1000000}
                  step={500}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
        </div>

        {/* Posts filter */}
        <div className="space-y-2 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Post Count</span>
            </div>
            <Switch
              checked={targeting.filterPostsEnabled}
              onCheckedChange={(v) => updateTargeting({ filterPostsEnabled: v })}
              disabled={disabled}
            />
          </div>
          {targeting.filterPostsEnabled && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Min</span>
                  <input
                    type="number"
                    value={targeting.filterPostsMin}
                    onChange={(e) => updateTargeting({ filterPostsMin: Math.max(0, Number(e.target.value) || 0) })}
                    disabled={disabled}
                    className="w-20 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterPostsMin]}
                  onValueChange={([v]) => updateTargeting({ filterPostsMin: v })}
                  min={0}
                  max={1000}
                  step={1}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Max</span>
                  <input
                    type="number"
                    value={targeting.filterPostsMax}
                    onChange={(e) => updateTargeting({ filterPostsMax: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={disabled}
                    className="w-20 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterPostsMax]}
                  onValueChange={([v]) => updateTargeting({ filterPostsMax: v })}
                  min={1}
                  max={50000}
                  step={10}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
        </div>

        {/* Gender filter */}
        <div className="space-y-2 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Gender</span>
            </div>
            <Switch
              checked={targeting.filterGenderEnabled}
              onCheckedChange={(v) => updateTargeting({ filterGenderEnabled: v })}
              disabled={disabled}
            />
          </div>
          {targeting.filterGenderEnabled && (
            <div className="flex gap-2 pt-1">
              {(['any', 'male', 'female'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => !disabled && updateTargeting({ filterGender: g })}
                  disabled={disabled}
                  className={`flex-1 px-3 py-1.5 rounded-lg border-2 text-xs font-medium capitalize transition-all ${
                    targeting.filterGender === g
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/50'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Filter by estimated gender based on profile name & bio</p>
        </div>

        {/* Age filter */}
        <div className="space-y-2 p-3 rounded-lg bg-secondary/30 border border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Age Range</span>
            </div>
            <Switch
              checked={targeting.filterAgeEnabled}
              onCheckedChange={(v) => updateTargeting({ filterAgeEnabled: v })}
              disabled={disabled}
            />
          </div>
          {targeting.filterAgeEnabled && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Min Age</span>
                  <input
                    type="number"
                    value={targeting.filterAgeMin}
                    onChange={(e) => updateTargeting({ filterAgeMin: Math.max(13, Math.min(99, Number(e.target.value) || 13)) })}
                    disabled={disabled}
                    className="w-16 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterAgeMin]}
                  onValueChange={([v]) => updateTargeting({ filterAgeMin: v })}
                  min={13}
                  max={99}
                  step={1}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-muted-foreground">Max Age</span>
                  <input
                    type="number"
                    value={targeting.filterAgeMax}
                    onChange={(e) => updateTargeting({ filterAgeMax: Math.max(13, Math.min(99, Number(e.target.value) || 99)) })}
                    disabled={disabled}
                    className="w-16 text-right font-mono text-primary text-[11px] bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <Slider
                  value={[targeting.filterAgeMax]}
                  onValueChange={([v]) => updateTargeting({ filterAgeMax: v })}
                  min={13}
                  max={99}
                  step={1}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Filter by estimated age based on profile bio & content</p>
        </div>
      </div>
    </div>
  );
}
