import { useEffect, useState } from "react";
import { PlayCircle, ChevronDown, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const VIDEO_ID = "unBlc2_ejL8";
const PLAYLIST_ID = "PLjdg3RPK0_y8NK17raQUObyxJonn9PsBA";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}&list=${PLAYLIST_ID}`;
// Privacy-enhanced (youtube-nocookie) embed so we don't drop tracking
// cookies on users who never click play.
const EMBED_URL = `https://www.youtube-nocookie.com/embed/${VIDEO_ID}?list=${PLAYLIST_ID}&rel=0&modestbranding=1`;

const DISMISS_KEY = "futnor_tutorial_dismissed";

interface VideoTutorialProps {
  /** Anchor id used by the "Learn how to use Client Engine" button to scroll here. */
  id?: string;
  /** Force-open the embed on mount (e.g. when the user clicked the CTA). */
  defaultOpen?: boolean;
}

/**
 * Tutorial video panel for the dashboard.
 *
 * Default state is a SLIM single-row bar — minimal visual noise for users
 * who've seen the video already. Click "Watch" to expand into the embed.
 * Click X to dismiss persistently (stored in localStorage). The inline
 * VideoTutorialButton stays visible regardless and resurfaces the panel
 * if the user wants to come back.
 */
export function VideoTutorial({ id, defaultOpen = false }: VideoTutorialProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [dismissed, setDismissed] = useState(false);

  // Read dismissed state on mount.
  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
    } catch {}
  }, []);

  // Auto-open + auto-undismiss when the inline pill button or any other CTA
  // dispatches the video-tutorial-open event. This makes the dismissed
  // state non-permanent — users can always come back.
  useEffect(() => {
    const handler = () => {
      setDismissed(false);
      setOpen(true);
      try { localStorage.removeItem(DISMISS_KEY); } catch {}
    };
    window.addEventListener("video-tutorial-open", handler);
    return () => window.removeEventListener("video-tutorial-open", handler);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    setOpen(false);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  };

  if (dismissed) return null;

  return (
    <section id={id} className="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {/* Slim header bar — single row. Click anywhere on the title area to expand. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition"
          aria-expanded={open}
        >
          <PlayCircle className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {open ? "Tutorial" : "Watch tutorial — how to use Client Engine"}
          </span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`} />
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Hide tutorial"
          title="Hide — you can reopen via the link above"
          className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Expanded content */}
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-primary/15 pt-3">
          <div className="rounded-lg overflow-hidden border border-border bg-black aspect-video">
            <iframe
              src={EMBED_URL}
              title="Client Engine tutorial"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              className="w-full h-full"
              loading="lazy"
            />
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <a
              href={WATCH_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition"
            >
              <ExternalLink className="w-3 h-3" />
              Open in YouTube
            </a>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleDismiss}
            >
              I've watched this — hide
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Tiny inline pill button used near AccountHealthScore (or anywhere else)
 * to scroll to the tutorial section, auto-open it, AND auto-undismiss it
 * if the user had previously hidden it. This is the always-visible
 * resurface link.
 */
export function VideoTutorialButton({ targetId = "section-tutorial" }: { targetId?: string }) {
  const handleClick = () => {
    // Dispatch FIRST so the section un-dismisses + opens before we scroll.
    window.dispatchEvent(new CustomEvent("video-tutorial-open"));
    // Defer scroll to next tick so the (possibly newly-rendered) section
    // exists in the DOM when scrollIntoView fires.
    requestAnimationFrame(() => {
      const el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition px-2.5 py-1 rounded-md hover:bg-primary/10 underline underline-offset-4"
    >
      <PlayCircle className="w-3.5 h-3.5" />
      Click here to learn how to use Client Engine
    </button>
  );
}
