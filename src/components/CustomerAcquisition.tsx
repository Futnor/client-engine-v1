import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { BotConfig } from '@/lib/botEngine';
import { SubscriptionTier, getTierLimits } from '@/lib/subscriptionTiers';
import {
  Search, Loader2, Download, Users, Check, Instagram, MessageCircle,
  UserPlus, Globe, Phone, Mail, ArrowRight, Sparkles,
} from 'lucide-react';

interface ProspectResult {
  name: string;
  phone: string | null;
  email: string | null;
  instagram_username: string | null;
  tiktok_username: string | null;
  website: string | null;
  description: string;
}

interface CustomerAcquisitionProps {
  platform: 'instagram' | 'tiktok';
  config: BotConfig;
  onApplyTargeting: (config: BotConfig) => void;
  disabled?: boolean;
  tier: SubscriptionTier;
}

export function CustomerAcquisition({ platform, config, onApplyTargeting, disabled, tier }: CustomerAcquisitionProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ProspectResult[]>([]);
  const [summary, setSummary] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const limits = getTierLimits(tier);

  // Deduplication helper: builds a unique key per prospect
  const prospectKey = (r: ProspectResult) => {
    if (r.instagram_username) return `ig:${r.instagram_username.toLowerCase()}`;
    if (r.tiktok_username) return `tk:${r.tiktok_username.toLowerCase()}`;
    if (r.email) return `em:${r.email.toLowerCase()}`;
    if (r.phone) return `ph:${r.phone}`;
    return `name:${r.name.toLowerCase().trim()}`;
  };

  const handleSearch = async () => {
    if (!query.trim()) {
      toast.error('Enter a search query');
      return;
    }
    if (limits.searchResultsLimit === 0) {
      toast.error('Upgrade your plan to use AI search');
      return;
    }

    setLoading(true);
    setSummary('');
    setSelectedRows(new Set());

    try {
      const { data, error } = await supabase.functions.invoke('customer-search', {
        body: {
          query: query.trim(),
          platform,
          maxResults: limits.searchResultsLimit,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const newResults: ProspectResult[] = data.results || [];

      // Merge with existing results, deduplicating by key
      setResults(prev => {
        const existing = new Map(prev.map(r => [prospectKey(r), r]));
        for (const r of newResults) {
          const key = prospectKey(r);
          if (!existing.has(key)) {
            existing.set(key, r);
          }
        }
        return Array.from(existing.values());
      });

      setSummary(data.summary || '');
      if (newResults.length > 0) {
        toast.success(`Found ${newResults.length} prospects`);
      } else {
        toast.info('No results found. Try a different query.');
      }
    } catch (e: any) {
      toast.error(e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleRow = (idx: number) => {
    const next = new Set(selectedRows);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelectedRows(next);
  };

  const toggleAll = () => {
    if (selectedRows.size === results.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(results.map((_, i) => i)));
    }
  };

  const getValidUsernames = (field: 'instagram_username' | 'tiktok_username') => {
    const indices = selectedRows.size > 0 ? [...selectedRows] : results.map((_, i) => i);
    return indices
      .map(i => results[i]?.[field])
      .filter((u): u is string => !!u);
  };

  const handleInjectToDM = () => {
    const field = platform === 'tiktok' ? 'tiktok_username' : 'instagram_username';
    const usernames = getValidUsernames(field);
    if (usernames.length === 0) {
      toast.error(`No valid ${platform} usernames to inject`);
      return;
    }

    const existing = config.targeting.customUsernames || [];
    const merged = [...new Set([...existing, ...usernames])];
    const newTargetTypes = [...config.targeting.targetTypes];
    if (!newTargetTypes.includes('custom')) newTargetTypes.push('custom');

    onApplyTargeting({
      ...config,
      targeting: {
        ...config.targeting,
        customUsernames: merged,
        targetTypes: newTargetTypes,
      },
    });

    toast.success(`${usernames.length} usernames injected into DM targeting`);
  };

  const handleInjectToFollowers = () => {
    const field = platform === 'tiktok' ? 'tiktok_username' : 'instagram_username';
    const usernames = getValidUsernames(field);
    if (usernames.length === 0) {
      toast.error(`No valid ${platform} usernames found`);
      return;
    }

    const newTargetTypes = [...config.targeting.targetTypes];
    if (!newTargetTypes.includes('followers')) newTargetTypes.push('followers');

    onApplyTargeting({
      ...config,
      targeting: {
        ...config.targeting,
        targetUsername: usernames[0],
        customUsernames: [...new Set([...(config.targeting.customUsernames || []), ...usernames])],
        targetTypes: newTargetTypes,
      },
    });

    toast.success(`${usernames.length} usernames added to followers targeting`);
  };

  const handleExport = (format: 'csv' | 'xlsx') => {
    if (!limits.canExport) {
      toast.error('Upgrade to Growth or Scale to export results');
      return;
    }

    const rows = selectedRows.size > 0 ? [...selectedRows].map(i => results[i]) : results;
    if (rows.length === 0) return;

    const headers = ['Name', 'Phone', 'Email', 'Instagram', 'TikTok', 'Website', 'Description'];
    const csvContent = [
      headers.join(','),
      ...rows.map(r => [
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${r.phone || ''}"`,
        `"${r.email || ''}"`,
        `"${r.instagram_username || ''}"`,
        `"${r.tiktok_username || ''}"`,
        `"${r.website || ''}"`,
        `"${(r.description || '').replace(/"/g, '""')}"`,
      ].join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prospects-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Export downloaded');
  };

  const igCount = results.filter(r => r.instagram_username).length;
  const tkCount = results.filter(r => r.tiktok_username).length;

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleSearch()}
            placeholder='e.g. "restaurants in Miami with low followers"'
            className="pl-9 bg-input border-border"
            disabled={disabled || loading}
          />
        </div>
        <Button
          onClick={handleSearch}
          disabled={disabled || loading || !query.trim()}
          className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground shrink-0"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Searching...</>
          ) : (
            <><Sparkles className="w-4 h-4" /> Search</>
          )}
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {limits.dailySearchLimit === 999 ? 'Unlimited' : limits.dailySearchLimit} search{limits.dailySearchLimit !== 1 ? 'es' : ''}/day
        {' · '}Up to {limits.searchResultsLimit} results per search
      </p>

      {/* Results */}
      {summary && <p className="text-xs text-muted-foreground italic">{summary}</p>}

      {results.length > 0 && (
        <div className="space-y-3">
          {/* Stats bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Users className="w-3 h-3" /> {results.length} results
            </Badge>
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Instagram className="w-3 h-3" /> {igCount} IG
            </Badge>
            <Badge variant="outline" className="gap-1 text-[10px]">
              {tkCount} TikTok
            </Badge>
            {selectedRows.size > 0 && (
              <Badge className="gap-1 text-[10px] bg-primary/20 text-primary">
                {selectedRows.size} selected
              </Badge>
            )}
          </div>

          {/* Table */}
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="max-h-[400px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={selectedRows.size === results.length && results.length > 0}
                        onChange={toggleAll}
                        className="rounded border-border"
                      />
                    </TableHead>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Contact</TableHead>
                    <TableHead className="text-xs">Instagram</TableHead>
                    <TableHead className="text-xs">TikTok</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((r, i) => (
                    <TableRow
                      key={i}
                      className={`cursor-pointer transition-colors ${selectedRows.has(i) ? 'bg-primary/5' : ''}`}
                      onClick={() => toggleRow(i)}
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedRows.has(i)}
                          onChange={() => toggleRow(i)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border-border"
                        />
                      </TableCell>
                      <TableCell className="text-xs font-medium max-w-[140px] truncate">
                        <div className="flex items-center gap-1.5">
                          {r.website ? (
                            <a href={r.website} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="hover:text-primary truncate">
                              {r.name}
                            </a>
                          ) : (
                            <span className="truncate">{r.name}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-col gap-0.5">
                          {r.phone && (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Phone className="w-3 h-3" /> {r.phone}
                            </span>
                          )}
                          {r.email && (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Mail className="w-3 h-3" /> {r.email}
                            </span>
                          )}
                          {!r.phone && !r.email && <span className="text-muted-foreground/50">—</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.instagram_username ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <Instagram className="w-3 h-3" /> @{r.instagram_username}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.tiktok_username ? (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            @{r.tiktok_username}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate hidden md:table-cell">
                        {r.description || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleInjectToDM} size="sm" className="gap-1.5 bg-gradient-to-r from-primary to-accent text-primary-foreground">
              <MessageCircle className="w-3.5 h-3.5" />
              Send to DM Campaign
            </Button>
            {limits.advancedTargeting && (
              <Button onClick={handleInjectToFollowers} size="sm" variant="outline" className="gap-1.5">
                <UserPlus className="w-3.5 h-3.5" />
                Add to Followers Targeting
              </Button>
            )}
            <Button
              onClick={() => handleExport('csv')}
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={!limits.canExport}
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
              {!limits.canExport && <span className="text-[9px] ml-1 text-muted-foreground">(Growth+)</span>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
