import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, CheckCircle2, AlertTriangle, Instagram, Chrome } from 'lucide-react';
import { Platform } from '@/lib/botEngine';

interface PlatformLoginGuideProps {
  platform: Platform;
}

export function PlatformLoginGuide({ platform }: PlatformLoginGuideProps) {
  const isInstagram = platform === 'instagram';
  const platformName = isInstagram ? 'Instagram' : 'TikTok';
  const platformUrl = isInstagram ? 'https://www.instagram.com' : 'https://www.tiktok.com';

  return (
    <div className="glass rounded-xl p-5 space-y-4 animate-fade-in border border-warning/30">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
          isInstagram
            ? 'bg-gradient-to-br from-pink-500/20 to-orange-500/20'
            : 'bg-gradient-to-br from-cyan-400/20 to-pink-500/20'
        }`}>
          {isInstagram
            ? <Instagram className="w-5 h-5 text-pink-400" />
            : <svg className="w-5 h-5 text-cyan-400" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.93a8.2 8.2 0 0 0 4.76 1.52V7a4.84 4.84 0 0 1-1-.31z"/></svg>
          }
        </div>
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            {platformName} Login Required
            <Badge variant="outline" className="border-warning text-warning text-[10px]">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Action needed
            </Badge>
          </h3>
          <p className="text-xs text-muted-foreground">Log into {platformName} in Chrome to use the bot</p>
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-xs font-bold text-primary">1</span>
          </div>
          <p className="text-muted-foreground">
            Open <span className="text-foreground font-medium">{platformName}</span> in your Chrome browser and sign in to your account
          </p>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-xs font-bold text-primary">2</span>
          </div>
          <p className="text-muted-foreground">
            Make sure the <span className="text-foreground font-medium">Futnor DM Bot</span> Chrome extension is installed and enabled
          </p>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-xs font-bold text-primary">3</span>
          </div>
          <p className="text-muted-foreground">
            Keep the {platformName} tab open while the bot runs — it interacts with the live page
          </p>
        </div>
      </div>

      <Button
        variant="outline"
        className="w-full gap-2 text-sm"
        onClick={() => window.open(platformUrl, '_blank')}
      >
        <Chrome className="w-4 h-4" />
        Open {platformName} in Chrome
        <ExternalLink className="w-3 h-3" />
      </Button>
    </div>
  );
}
