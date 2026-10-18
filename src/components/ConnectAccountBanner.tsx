import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Instagram, AlertCircle } from 'lucide-react';
import type { Platform } from '@/lib/botEngine';

interface Props {
  platform: Platform;
  extensionConnected: boolean;
}

function readActiveAccount(): string {
  try {
    return (localStorage.getItem('futnor_active_account') || '')
      .toLowerCase()
      .replace(/^@/, '')
      .trim();
  } catch {
    return '';
  }
}

export function ConnectAccountBanner({ platform, extensionConnected }: Props) {
  const [activeAccount, setActiveAccount] = useState<string>(readActiveAccount);

  useEffect(() => {
    const refresh = () => setActiveAccount(readActiveAccount());
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'futnor_active_account') refresh();
    };
    window.addEventListener('storage', onStorage);
    const poll = window.setInterval(refresh, 1500);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.clearInterval(poll);
    };
  }, []);

  if (!extensionConnected || activeAccount) return null;

  const handleConnect = () => {
    const payload = {
      type: 'FOCUS_BOT_TAB',
      platform,
      processed: false,
      timestamp: Date.now(),
    };
    try {
      localStorage.setItem('futnor_command', JSON.stringify(payload));
      window.postMessage({ source: 'futnor-web', command: payload }, '*');
    } catch {
      const url = platform === 'tiktok' ? 'https://www.tiktok.com' : 'https://www.instagram.com';
      window.open(url, 'futnor_platform_tab');
    }
  };

  const platformName = platform === 'tiktok' ? 'TikTok' : 'Instagram';

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 flex items-start gap-3 animate-fade-in">
      <div className="w-9 h-9 rounded-lg bg-warning/15 flex items-center justify-center shrink-0">
        <AlertCircle className="w-5 h-5 text-warning" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div>
          <h3 className="text-sm font-semibold">No {platformName} account connected</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Open {platformName} so the extension can detect your logged-in account. Without
            this, script toggles, history, and DM sessions can't run on the right account.
          </p>
        </div>
        <Button size="sm" onClick={handleConnect} className="gap-2">
          <Instagram className="w-4 h-4" />
          Open {platformName} to Connect
        </Button>
      </div>
    </div>
  );
}
