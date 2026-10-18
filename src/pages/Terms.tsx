import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Terms() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen p-6 md:p-8 lg:p-10">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-bold">Terms &amp; Conditions</h1>
        </div>

        <p className="text-sm text-muted-foreground">Last updated: April 11, 2026</p>

        <div className="glass rounded-2xl p-6 md:p-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Client Engine ("the Service"), you agree to be bound by these Terms &amp; Conditions. If you do not agree, you must not use the Service.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">2. Description of Service</h2>
            <p>
              Client Engine is an automation tool that assists users with outreach activities on social media platforms including Instagram and TikTok. The Service provides features such as automated direct messaging, liking, following, account warm-up, and prospect discovery.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">3. User Responsibility</h2>
            <p>
              You are solely responsible for how you use the Service. You agree to use Client Engine in a responsible, ethical, and lawful manner at all times. You must comply with the terms of service of any platform you use in conjunction with our Service.
            </p>
            <p>
              You shall not use the Service to engage in spam, harassment, fraud, phishing, distribution of malware, or any other illegal, harmful, or unethical activity. Any misuse of the Service is entirely your responsibility.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">4. Account Bans &amp; Suspensions — Disclaimer of Liability</h2>
            <p className="font-medium text-foreground">
              Client Engine is not responsible for any account bans, suspensions, restrictions, shadow-bans, or any other penalties imposed on your social media accounts as a result of using the Service.
            </p>
            <p>
              Social media platforms may restrict or terminate accounts that use automation tools. By using our Service, you acknowledge and accept this risk. We provide safety measures, account health monitoring, warm-up features, and usage guidelines to help minimize risk, but we cannot guarantee that your accounts will not be affected.
            </p>
            <p>
              If you choose to ignore warnings, bypass safety recommendations, exceed recommended daily limits, or otherwise use the Service in a manner that increases the risk of account penalties, we bear no responsibility for any consequences that may arise.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">5. No Liability for User Actions</h2>
            <p>
              Client Engine shall not be held liable for any actions performed by users through the Service. Any content sent, accounts targeted, or activities conducted using our tool are the sole responsibility of the user. We do not endorse, monitor, or control the messages or activities carried out through the Service.
            </p>
            <p>
              If you use the Service to perform any illegal, unethical, or harmful activities, you accept full legal and personal responsibility for such actions.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">6. Safety Measures &amp; Compliance</h2>
            <p>
              We provide built-in safety features including account health scoring, daily activity limits, warm-up schedules, and warning notifications. These measures are designed to help protect your accounts, but they are not foolproof.
            </p>
            <p>
              Users who fail to comply with recommended safety settings, ignore bot warnings, or override protective measures do so at their own risk. We strongly recommend following all safety guidelines provided within the Service.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">7. Subscriptions &amp; Payments</h2>
            <p>
              Paid subscriptions are billed on a recurring basis. Some plans feature an introductory price for the first billing period, after which the subscription renews at the standard rate. All fees are non-refundable unless otherwise required by law.
            </p>
            <p>
              You may cancel your subscription at any time through the subscription management portal. Cancellation takes effect at the end of the current billing period.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">8. Free Trial</h2>
            <p>
              We may offer a free trial period. Each user is entitled to one trial only. Abuse of the trial system (e.g., creating multiple accounts) may result in termination of access.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">9. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Client Engine and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, business opportunities, or account access, arising from or related to your use of the Service.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">10. Modifications to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">11. Contact</h2>
            <p>
              For questions about these Terms, please contact us at <span className="text-primary">admin@futnor.com</span>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
