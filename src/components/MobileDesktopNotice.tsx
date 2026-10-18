import { useEffect, useState } from "react";
import { Monitor, Check, Mail, Chrome } from "lucide-react";

/**
 * Detect mobile via User-Agent. Used to render an informational card
 * explaining that Client Engine runs as a Chrome extension on desktop.
 *
 * We deliberately do NOT block the user from using the app — they can
 * sign up, browse, and configure from mobile. The bot itself needs a
 * computer because:
 *   • Chrome extensions don't exist on iOS Safari at all
 *   • Mobile Chrome on Android doesn't support extensions either
 *   • Instagram's mobile site behaves very differently from desktop
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

type Variant = "landing" | "dashboard";

interface MobileDesktopNoticeProps {
  /**
   * "landing": short version for the marketing Home page (pre-signup).
   *   Encouraging tone, doesn't assume they have an account.
   * "dashboard": longer version for /app (post-signup).
   *   Reassuring tone, explains the desktop steps in order.
   */
  variant?: Variant;
  className?: string;
}

export function MobileDesktopNotice({ variant = "landing", className = "" }: MobileDesktopNoticeProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setIsMobile(isMobileDevice());
  }, []);

  // Remember dismissal across reloads in this session so the user isn't
  // nagged every time they refresh. Cleared when they sign out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem("futnor_mobile_notice_dismissed") === "1") {
        setDismissed(true);
      }
    } catch {}
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem("futnor_mobile_notice_dismissed", "1"); } catch {}
  };

  if (!isMobile || dismissed) return null;

  // ── DASHBOARD VARIANT — for /app after signup ────────────────────────
  if (variant === "dashboard") {
    return (
      <div className={`rounded-2xl border-2 border-primary/40 bg-gradient-to-br from-primary/10 to-accent/5 p-5 space-y-4 shadow-lg ${className}`}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-primary/20 text-primary flex items-center justify-center flex-shrink-0">
            <Monitor className="w-6 h-6" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-bold text-foreground text-base leading-tight">
              You're signed in! Continue on your computer
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Client Engine runs as a Chrome extension — it needs a laptop or desktop with Google Chrome to send DMs. Your account, settings, and campaigns are all saved and waiting for you there.
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-background/60 border border-border p-3 space-y-2.5">
          <p className="text-xs font-semibold text-foreground uppercase tracking-wide">
            On your computer:
          </p>
          {[
            { icon: Chrome, text: "Open Google Chrome and visit futnormarketing.com" },
            { icon: Monitor, text: "Sign in with the same Google account" },
            { icon: Check, text: "Install the extension from your dashboard and start your first campaign" },
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <div className="w-6 h-6 rounded-md bg-primary/15 text-primary flex items-center justify-center flex-shrink-0 font-bold">
                {i + 1}
              </div>
              <div className="flex items-center gap-2 text-foreground/80 leading-relaxed pt-0.5">
                <step.icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <span>{step.text}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-2 text-[11px] text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
          <Mail className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="leading-relaxed">
            <strong className="text-foreground">Tip:</strong> Email yourself the link to <code className="text-foreground bg-background/60 px-1 rounded">futnormarketing.com</code> so it's one click to open on your computer.
          </span>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="w-full text-xs text-muted-foreground hover:text-foreground transition py-1.5 underline underline-offset-4"
        >
          Got it, hide this message
        </button>
      </div>
    );
  }

  // ── LANDING VARIANT — for marketing Home page ────────────────────────
  return (
    <div className={`mx-auto max-w-sm rounded-2xl border border-primary/30 bg-primary/5 px-5 py-4 text-left space-y-3 ${className}`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
          <Monitor className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <p className="font-bold text-foreground text-sm">
            Sign up now — launch from your computer
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Client Engine is a Chrome extension that runs on your laptop or desktop. Create your account from your phone today; when you're ready, open the dashboard on your computer to install the extension and start your first campaign.
          </p>
        </div>
      </div>
      <div className="space-y-1.5 pl-12">
        {[
          "Account saves instantly across devices",
          "Onboarding takes ~2 minutes on desktop",
          "Bot runs 24/7 once it's up",
        ].map((line) => (
          <div key={line} className="flex items-start gap-2 text-xs text-muted-foreground">
            <Check className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
