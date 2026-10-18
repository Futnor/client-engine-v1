import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function PrivacyPolicy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen p-6 md:p-8 lg:p-10">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-bold">Privacy Policy</h1>
        </div>

        <p className="text-sm text-muted-foreground">Last updated: April 27, 2026</p>

        <div className="glass rounded-2xl p-6 md:p-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 className="text-lg font-semibold text-foreground">Prominent Disclosure — Chrome Extension Data Handling</h2>
            <p>
              The Client Engine Chrome extension reads <strong className="text-foreground">public page content</strong> on
              Instagram, TikTok, and WhatsApp Web — including profile information,
              post content, usernames, follower counts, and captions — from inside
              your already-logged-in browser session. It then sends DMs and posts
              comments on your behalf using the scripts you configure. The
              extension does <strong className="text-foreground">not</strong> collect, store, or transmit your
              private message inbox or conversation history. You must explicitly
              consent on first launch before the extension performs any action,
              and we never sell your data.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">1. Information We Collect</h2>
            <p>
              We collect information you provide when creating an account, including your email address, display name, and social media usernames. We also collect usage data such as session history, activity logs, and subscription status. When you run the Chrome extension, it additionally processes public page content (profiles, posts, usernames, captions) from the social platforms you actively run it on so it can perform the automation you configure. The extension does not read your private message inbox or conversation threads.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">2. How We Use Your Information</h2>
            <p>We use your information to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Provide, maintain, and improve the Service</li>
              <li>Process subscriptions and payments</li>
              <li>Monitor account health and provide safety warnings</li>
              <li>Communicate with you about updates and support</li>
              <li>Prevent fraud and abuse of the Service</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">3. Data Storage &amp; Security</h2>
            <p>
              Your data is stored securely using industry-standard encryption and security practices. We use trusted third-party services for authentication, database management, and payment processing.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">4. Third-Party Services</h2>
            <p>We use the following third-party services:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Stripe</strong> — for payment processing</li>
              <li><strong>Authentication providers</strong> — for secure login (email, Google)</li>
            </ul>
            <p>These services have their own privacy policies governing the use of your information.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">5. Data We Do Not Collect</h2>
            <p>
              We do not store your social media passwords. The bot operates through a browser extension that runs locally in your browser. We do not have access to your social media login credentials.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">6. Data Sharing</h2>
            <p>
              We do not sell, trade, or rent your personal information to third parties. We may share anonymized, aggregated data for analytical purposes.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">7. Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Access the personal data we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your account and associated data</li>
              <li>Withdraw consent for data processing</li>
            </ul>
            <p>To exercise any of these rights, contact us at <span className="text-primary">admin@futnor.com</span>.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">8. Cookies &amp; Local Storage</h2>
            <p>
              We use local storage and session storage to maintain your login state and preferences. The browser extension stores configuration locally on your device.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Continued use of the Service after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">10. Contact</h2>
            <p>
              For privacy-related inquiries, contact us at <span className="text-primary">admin@futnor.com</span>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
