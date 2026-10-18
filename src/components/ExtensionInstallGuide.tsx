import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Chrome, ExternalLink, CheckCircle2 } from 'lucide-react';
import { PUBLIC_EXTENSION_VERSION } from '@/lib/extensionVersions';

// Public Chrome Web Store listing for Client Engine.
// Update this constant if the listing URL changes.
const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/Client%20Engine/eicljdnooilphfgibigncfkiohlhddck';

// Display the version currently published on the Chrome Web Store — this is
// what real users would download. It comes from src/lib/extensionVersions.ts
// and only bumps after Google approves a new submission. Internal-only newer
// builds are visible to admins via /admin → Builds.
const EXTENSION_VERSION = PUBLIC_EXTENSION_VERSION;

export function ExtensionInstallGuide() {
  return (
    <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/5 to-accent/5 p-5 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
          <Chrome className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            Install Chrome Extension
            <Badge className="bg-primary/20 text-primary border-0 text-[10px]">Required</Badge>
            <Badge variant="outline" className="text-[10px]">v{EXTENSION_VERSION}</Badge>
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Install Client Engine directly from the Chrome Web Store — one click, no manual setup.
          </p>
        </div>
      </div>

      {/* Primary CTA */}
      <Button asChild size="lg" className="gap-2 w-full sm:w-auto">
        <a
          href={CHROME_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Install Client Engine from the Chrome Web Store (opens in a new tab)"
        >
          <Chrome className="w-4 h-4" />
          Install from Chrome Web Store
          <ExternalLink className="w-4 h-4" />
        </a>
      </Button>

      {/* Post-install note */}
      <div className="flex items-start gap-2 pt-1">
        <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Once installed, come back to this page — the status above will change to{' '}
          <span className="text-success font-medium">🔌 Extension connected</span> and you're
          ready to start.
        </p>
      </div>
    </div>
  );
}
