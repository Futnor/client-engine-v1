import { Slider } from '@/components/ui/slider';
import { BotConfig } from '@/lib/botEngine';
import { Clock, Zap, Settings2, Shield } from 'lucide-react';

interface ConfigPanelProps {
  config: BotConfig;
  onChange: (config: BotConfig) => void;
  disabled?: boolean;
  isHumanMode?: boolean;
}

export function ConfigPanel({ config, onChange, disabled, isHumanMode }: ConfigPanelProps) {
  const updateConfig = (key: keyof BotConfig, value: number) => {
    onChange({ ...config, [key]: value });
  };

  const handleDelayChange = (key: 'minActionDelay' | 'maxActionDelay', value: number) => {
    let clamped = value;
    if (disabled) {
      // Bot is running — only allow INCREASING the current value so a user
      // who hits "Pace elevated" can safely slow the bot down mid-session
      // without ever risking a smaller delay than the bot was already using.
      const current = config[key];
      clamped = Math.max(clamped, current);
    }
    updateConfig(key, clamped);
  };

  return (
    <div className="glass rounded-xl p-6 space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Settings2 className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">Configuration</h3>
      </div>

      {/* Session Duration — editable in both Human and Manual modes */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" />
          <span>Session Duration</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Min</span>
              <span className="font-mono text-primary">{config.sessionMin}m</span>
            </div>
            <Slider
              value={[config.sessionMin]}
              onValueChange={([v]) => updateConfig('sessionMin', v)}
              min={1}
              max={60}
              step={1}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Max</span>
              <span className="font-mono text-primary">{config.sessionMax}m</span>
            </div>
            <Slider
              value={[config.sessionMax]}
              onValueChange={([v]) => updateConfig('sessionMax', v)}
              min={Math.max(1, config.sessionMin)}
              max={120}
              step={1}
              disabled={disabled}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Each session randomly picks a duration in this range (1m–2h). Shorter sessions look more human.
        </p>
      </div>

      {/* Action Delays — always editable, including in Human mode. Range goes
          up to 5 / 10 minutes so users can set proper conservative pacing.
          Decreases are blocked while the bot is running (handleDelayChange clamps). */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Zap className="w-4 h-4" />
          <span>Action Delays</span>
          {disabled && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-green-500">
              <Shield className="w-3 h-3" />
              Increase only (running)
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Min</span>
              <span className="font-mono text-primary">
                {config.minActionDelay >= 60
                  ? `${(config.minActionDelay / 60).toFixed(config.minActionDelay % 60 === 0 ? 0 : 1)}m`
                  : `${config.minActionDelay}s`}
              </span>
            </div>
            <Slider
              value={[config.minActionDelay]}
              onValueChange={([v]) => handleDelayChange('minActionDelay', v)}
              min={disabled ? config.minActionDelay : 1}
              max={300}
              step={1}
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Max</span>
              <span className="font-mono text-primary">
                {config.maxActionDelay >= 60
                  ? `${(config.maxActionDelay / 60).toFixed(config.maxActionDelay % 60 === 0 ? 0 : 1)}m`
                  : `${config.maxActionDelay}s`}
              </span>
            </div>
            <Slider
              value={[config.maxActionDelay]}
              onValueChange={([v]) => handleDelayChange('maxActionDelay', v)}
              min={disabled ? config.maxActionDelay : 5}
              max={600}
              step={1}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Min/max delay between any two bot actions (scroll, like, DM, etc.). Range: 1s to 10min.
          The bot picks a random value in this range before each action — wider range = more human-like.
        </p>
      </div>
    </div>
  );
}
