import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LocationAutocomplete } from '@/components/LocationAutocomplete';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Sparkles, Hash, MapPin, Users, Search, Check, Copy } from 'lucide-react';
import { BotConfig, TargetingConfig } from '@/lib/botEngine';

interface ProspectResult {
  hashtags: string[];
  locationSearchTerms: string[];
  competitorAccounts: string[];
  searchTerms: string[];
  summary: string;
}

interface ProspectFinderProps {
  platform: 'instagram' | 'tiktok';
  config: BotConfig;
  onApplyTargeting: (config: BotConfig) => void;
  disabled?: boolean;
}

export function ProspectFinder({ platform, config, onApplyTargeting, disabled }: ProspectFinderProps) {
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProspectResult | null>(null);
  const [applied, setApplied] = useState(false);

  const handleFind = async () => {
    if (!description.trim()) {
      toast.error('Please describe your ideal customer');
      return;
    }
    setLoading(true);
    setResult(null);
    setApplied(false);

    try {
      const { data, error } = await supabase.functions.invoke('find-prospects', {
        body: { description: description.trim(), location: location.trim(), platform },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.prospects) throw new Error('No results returned');

      setResult(data.prospects);
      toast.success('Prospect plan generated!');
    } catch (e: any) {
      toast.error(e.message || 'Failed to find prospects');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!result) return;

    const newTargeting: Partial<TargetingConfig> = {};
    const newTargetTypes = [...config.targeting.targetTypes];

    // Apply hashtags
    if (result.hashtags.length > 0) {
      newTargeting.hashtags = result.hashtags.map(h => `#${h}`).join(', ');
      if (!newTargetTypes.includes('hashtags')) newTargetTypes.push('hashtags');
    }

    // Apply competitor accounts as custom usernames (for followers scraping)
    if (result.competitorAccounts.length > 0) {
      const existing = config.targeting.customUsernames || [];
      const merged = [...new Set([...existing, ...result.competitorAccounts])];
      newTargeting.customUsernames = merged;
      // Also set first competitor as target username for followers mode
      if (!config.targeting.targetUsername && result.competitorAccounts[0]) {
        newTargeting.targetUsername = result.competitorAccounts[0];
      }
      if (!newTargetTypes.includes('followers')) newTargetTypes.push('followers');
    }

    newTargeting.targetTypes = newTargetTypes;

    // Apply AI targeting search terms
    const newAITargeting = {
      ...config.aiTargeting,
      keywords: result.searchTerms,
      contentTags: result.hashtags.slice(0, 5),
      targetAudience: description.trim(),
      searchTerms: result.searchTerms,
    };

    onApplyTargeting({
      ...config,
      targeting: { ...config.targeting, ...newTargeting },
      aiTargeting: newAITargeting,
    });

    setApplied(true);
    toast.success('Targeting config updated with prospect data!');
  };

  const copyToClipboard = (items: string[], prefix = '') => {
    const text = items.map(i => `${prefix}${i}`).join(', ');
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  return (
    <div className="space-y-4">
      {/* Input form */}
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Describe your ideal customer
          </label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Fitness coaches looking for online clients, Real estate agents in luxury market, Small business owners selling handmade products..."
            className="bg-input border-border text-sm min-h-[70px] resize-none"
            disabled={disabled || loading}
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Location (optional)
          </label>
          <LocationAutocomplete
            value={location}
            onChange={setLocation}
            disabled={disabled || loading}
          />
        </div>

        <Button
          onClick={handleFind}
          disabled={disabled || loading || !description.trim()}
          className="w-full gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
          ) : (
            <><Sparkles className="w-4 h-4" /> Find Prospects</>
          )}
        </Button>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-3 pt-2 border-t border-border">
          {/* Summary */}
          <p className="text-xs text-muted-foreground italic">{result.summary}</p>

          {/* Hashtags */}
          {result.hashtags.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs font-medium">Hashtags to Target</span>
                </div>
                <button onClick={() => copyToClipboard(result.hashtags, '#')} className="text-muted-foreground hover:text-foreground">
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.hashtags.map((h) => (
                  <Badge key={h} variant="secondary" className="text-[10px] font-normal">#{h}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Location terms */}
          {result.locationSearchTerms.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-medium">Location Search Terms</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.locationSearchTerms.map((l) => (
                  <Badge key={l} variant="outline" className="text-[10px] font-normal">{l}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Competitor accounts */}
          {result.competitorAccounts.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs font-medium">Competitor Accounts</span>
                </div>
                <button onClick={() => copyToClipboard(result.competitorAccounts, '@')} className="text-muted-foreground hover:text-foreground">
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.competitorAccounts.map((a) => (
                  <Badge key={a} variant="secondary" className="text-[10px] font-normal">@{a}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Search terms */}
          {result.searchTerms.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-medium">AI Search Terms</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.searchTerms.map((s) => (
                  <Badge key={s} variant="outline" className="text-[10px] font-normal">{s}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Apply button */}
          <Button
            onClick={handleApply}
            disabled={applied || disabled}
            variant={applied ? 'outline' : 'default'}
            className="w-full gap-2"
          >
            {applied ? (
              <><Check className="w-4 h-4 text-success" /> Applied to Targeting</>
            ) : (
              <><Sparkles className="w-4 h-4" /> Apply to Targeting Config</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
