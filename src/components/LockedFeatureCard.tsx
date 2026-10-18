import { useNavigate } from "react-router-dom";
import { Lock, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Renders inside a CollapsibleSection (or any container) in place of the
 * real feature panel when the user's current tier doesn't entitle them
 * to that feature. Shows a brief description of what the feature does,
 * the required tier, and a CTA to /pricing.
 *
 * Used in Index.tsx to let free-tier users SEE the warm-up / engage-DM /
 * other Pro+ sections instead of having them hidden — better discovery
 * + clearer upgrade path.
 */
interface LockedFeatureCardProps {
  featureName: string;
  description: string;
  /** e.g. "Pro+", "Scale only". */
  requiredTier?: string;
}

export function LockedFeatureCard({ featureName, description, requiredTier = "Pro+" }: LockedFeatureCardProps) {
  const navigate = useNavigate();
  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-5 sm:p-6 text-center space-y-3">
      <div className="w-12 h-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center mx-auto">
        <Lock className="w-6 h-6" />
      </div>
      <div className="space-y-1">
        <h3 className="font-bold text-foreground text-base">
          {featureName} <span className="text-xs font-semibold text-primary ml-1">{requiredTier}</span>
        </h3>
        <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
          {description}
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => navigate("/pricing")}
        className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground"
      >
        <CreditCard className="w-4 h-4" />
        Upgrade to unlock
      </Button>
    </div>
  );
}
