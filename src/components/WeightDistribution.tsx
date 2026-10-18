import { Slider } from '@/components/ui/slider';
import { BotConfig } from '@/lib/botEngine';
import { Eye, Heart, MessageCircle, PieChart } from 'lucide-react';

interface WeightDistributionProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
}

export function WeightDistribution({ config, onChange, disabled }: WeightDistributionProps) {
  const isTikTok = config.platform === 'tiktok';
  const total = config.scrollWeight + config.likeWeight + config.dmWeight;
  
  const scrollPct = Math.round((config.scrollWeight / total) * 100);
  const likePct = Math.round((config.likeWeight / total) * 100);
  const dmPct = Math.round((config.dmWeight / total) * 100);

  const updateWeight = (key: 'scrollWeight' | 'likeWeight' | 'dmWeight', value: number) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="glass rounded-xl p-6 space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <PieChart className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">Action Distribution</h3>
      </div>

      {/* Visual Bar */}
      <div className="h-4 rounded-full overflow-hidden flex">
        <div 
          className="bg-primary transition-all duration-300"
          style={{ width: `${scrollPct}%` }}
        />
        <div 
          className="bg-success transition-all duration-300"
          style={{ width: `${likePct}%` }}
        />
        <div 
          className="bg-accent transition-all duration-300"
          style={{ width: `${dmPct}%` }}
        />
      </div>

      {/* Scroll/View */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" />
            <span className="text-sm">Scroll / View</span>
          </div>
          <span className="font-mono text-primary font-medium">{scrollPct}%</span>
        </div>
        <Slider
          value={[config.scrollWeight]}
          onValueChange={([v]) => updateWeight('scrollWeight', v)}
          min={10}
          max={90}
          step={5}
          disabled={disabled}
        />
      </div>

      {/* Like/Follow */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Heart className="w-4 h-4 text-success" />
            <span className="text-sm">Like / Follow</span>
          </div>
          <span className="font-mono text-success font-medium">{likePct}%</span>
        </div>
        <Slider
          value={[config.likeWeight]}
          onValueChange={([v]) => updateWeight('likeWeight', v)}
          min={5}
          max={50}
          step={5}
          disabled={disabled}
        />
      </div>

      {/* Comment (TikTok) / DM (Instagram) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-accent" />
            <span className="text-sm">{isTikTok ? 'Comment' : 'Direct Message'}</span>
          </div>
          <span className="font-mono text-accent font-medium">{dmPct}%</span>
        </div>
        <Slider
          value={[config.dmWeight]}
          onValueChange={([v]) => updateWeight('dmWeight', v)}
          min={0}
          max={30}
          step={5}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
