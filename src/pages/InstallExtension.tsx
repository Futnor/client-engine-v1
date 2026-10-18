import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Chrome } from 'lucide-react';
import { ExtensionInstallGuide } from '@/components/ExtensionInstallGuide';

export default function InstallExtension() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/app')}
            className="gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Button>
          <Badge variant="outline" className="gap-1.5">
            <Chrome className="w-3 h-3" />
            Chrome Extension
          </Badge>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Install Chrome Extension</h1>
          <p className="text-muted-foreground">
            Install Client Engine from the Chrome Web Store to start automating your outreach.
          </p>
        </div>

        {/* Install CTA */}
        <ExtensionInstallGuide />

        {/* Footer back button */}
        <div className="pt-4 flex justify-center">
          <Button variant="outline" onClick={() => navigate('/app')} className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
