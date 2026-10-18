import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_EMAILS } from "@/lib/subscriptionTiers";
import { ArrowRight } from "lucide-react";
import { MobileDesktopNotice } from "@/components/MobileDesktopNotice";
import logo from "@/assets/logo.png";

export default function Home() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      const email = session?.user?.email ?? "";
      setIsAdmin(!!email && ADMIN_EMAILS.includes(email));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user?.email ?? "";
      setIsAdmin(!!email && ADMIN_EMAILS.includes(email));
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto">
        <div className="flex items-center gap-2">
          <img src={logo} alt="Client Engine logo" className="h-8 w-auto" />
          <span className="font-bold text-lg">Client Engine</span>
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Link
              to="/app"
              className="px-4 py-2 rounded-xl border border-border bg-card text-foreground font-semibold text-sm hover:bg-muted transition"
            >
              Bot Dashboard
            </Link>
          </div>
        ) : (
          <Link
            to="/login"
            className="px-5 py-2 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition"
          >
            Sign In
          </Link>
        )}
      </header>

      {/* Hero */}
      <main className="max-w-3xl mx-auto px-6 py-10 sm:py-16 md:py-20 text-center space-y-5 sm:space-y-6">
        <h1 className="text-[28px] sm:text-4xl md:text-5xl font-bold leading-[1.15] sm:leading-tight">
          Find Customers and Send DMs on Autopilot
        </h1>
        <p className="text-muted-foreground text-sm sm:text-base md:text-lg max-w-xl mx-auto leading-relaxed">
          Client Engine is your AI-powered client acquisition bot. It finds your
          ideal customers on Instagram &amp; TikTok and sends personalised DMs
          using a system engineered to drive the highest possible response rate
          — so more conversations turn into real opportunities.
        </p>

        {/* CTA — bigger, gradient, glowing, with arrow */}
        <div className="pt-2 sm:pt-3">
          <Link
            to="/login"
            className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-8 py-4 sm:py-3.5 rounded-2xl bg-gradient-to-r from-primary to-accent text-primary-foreground font-bold text-base sm:text-lg shadow-lg shadow-primary/40 hover:shadow-xl hover:shadow-primary/50 hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            Start Acquiring Clients
            <ArrowRight className="w-5 h-5" />
          </Link>
          <p className="text-xs text-muted-foreground mt-3">
            Free to sign up · No credit card required
          </p>
        </div>

        {/* Mobile-only "Use desktop" friendly notice — placed BELOW the CTA so it
            doesn't visually block them from clicking. Encouraging tone: still
            sign up now, save progress for desktop. */}
        <div className="mt-6">
          <MobileDesktopNotice variant="landing" />
        </div>
      </main>

      {/* How It Works */}
      <section className="max-w-4xl mx-auto px-6 pb-12">
        <h2 className="text-2xl font-bold text-center mb-8 text-foreground">How It Works</h2>
        <div className="grid md:grid-cols-3 gap-8 text-center">
          {[
            { step: "1", title: "Find Customers", desc: "Target by hashtags, locations, competitors' followers, or let AI discover ideal clients for you." },
            { step: "2", title: "Send Personalised DMs", desc: "Craft your script once — Client Engine personalises and delivers it to every customer automatically." },
            { step: "3", title: "Maximise Response Rate", desc: "Smart pacing, personalisation and dedupe rules engineered to drive the highest reply rate from your outreach." },
          ].map((f) => (
            <div key={f.step} className="p-6 rounded-2xl bg-card border border-border space-y-3">
              <div className="w-10 h-10 rounded-full bg-primary/20 text-primary font-bold flex items-center justify-center mx-auto">{f.step}</div>
              <h3 className="font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-4xl mx-auto px-6 pb-20 grid md:grid-cols-3 gap-8 text-center">
        {[
          { title: "Smart Outreach", desc: "Automated, personalised DMs that sound human — not spammy." },
          { title: "AI-Powered Targeting", desc: "Find clients by niche, location, or engagement level in seconds." },
          { title: "Built-In Safety", desc: "Warm-up mode and daily limits protect your accounts from restrictions." },
        ].map((f) => (
          <div key={f.title} className="p-6 rounded-2xl bg-card border border-border space-y-2">
            <h3 className="font-semibold text-foreground">{f.title}</h3>
            <p className="text-sm text-muted-foreground">{f.desc}</p>
          </div>
        ))}
      </section>

      {/* FAQ — mirrors JSON-LD for AI/Google answer extraction */}
      <section className="max-w-3xl mx-auto px-6 pb-20" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="text-2xl font-bold text-center mb-8 text-foreground">
          Client Acquisition Automation — FAQ
        </h2>
        <div className="space-y-6">
          <article className="p-6 rounded-2xl bg-card border border-border">
            <h3 className="font-semibold text-foreground mb-2">How do I get customers on autopilot?</h3>
            <p className="text-sm text-muted-foreground">
              Client Engine automates client acquisition by using AI to find your ideal customers on Instagram and TikTok and send them personalised DMs 24/7, so you get customers without manual outreach.
            </p>
          </article>
          <article className="p-6 rounded-2xl bg-card border border-border">
            <h3 className="font-semibold text-foreground mb-2">What is client acquisition automation?</h3>
            <p className="text-sm text-muted-foreground">
              Client acquisition automation uses AI to handle customer discovery, outreach, and follow-up at scale. Client Engine targets ideal customers, personalises every message, and uses human-like pacing to keep accounts safe while maximising response rates.
            </p>
          </article>
          <article className="p-6 rounded-2xl bg-card border border-border">
            <h3 className="font-semibold text-foreground mb-2">Is Client Engine safe for my Instagram and TikTok accounts?</h3>
            <p className="text-sm text-muted-foreground">
              Yes. Client Engine uses warm-up sessions, randomised human-like delays, daily limits, and a live account health score to protect your accounts from restrictions.
            </p>
          </article>
        </div>
      </section>

      {/* Founder credit */}
      <section className="border-t border-border py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Client Engine is built by{" "}
          <span className="font-medium text-foreground">Sizo Gugushe</span>,
          {" "}founder of{" "}
          <a
            href="https://futnor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary hover:underline"
          >
            Futnor
          </a>
          .
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground space-x-4">
        <Link to="/privacy-policy" className="hover:underline">Privacy Policy</Link>
        <Link to="/terms" className="hover:underline">Terms of Service</Link>
        <Link to="/support" className="hover:underline">Support</Link>
        <span>© {new Date().getFullYear()} Client Engine</span>
      </footer>
    </div>
  );
}
