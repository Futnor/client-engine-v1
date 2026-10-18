import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Save, CheckCircle2 } from 'lucide-react';

interface BusinessProfile {
  agentName: string;
  businessName: string;
  product: string;
  targetCustomer: string;
  pricing: string;
  commonObjections: string;
  competitors: string;
  keyTransformation: string;
  currentPromos: string;
  whatsappPhoneNumberId: string;
  whatsappAccessToken: string;
  whatsappVerifyToken: string;
}

const EMPTY_PROFILE: BusinessProfile = {
  agentName: '',
  businessName: '',
  product: '',
  targetCustomer: '',
  pricing: '',
  commonObjections: '',
  competitors: '',
  keyTransformation: '',
  currentPromos: '',
  whatsappPhoneNumberId: '',
  whatsappAccessToken: '',
  whatsappVerifyToken: '',
};

export function SalesAgentOnboarding() {
  const [profile, setProfile] = useState<BusinessProfile>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const { data } = await supabase.functions.invoke('sales-agent', {
        body: { action: 'get-profile' },
      });
      if (data?.profile) {
        const p = data.profile;
        setProfile({
          agentName: p.agent_name || '',
          businessName: p.business_name || '',
          product: p.product || '',
          targetCustomer: p.target_customer || '',
          pricing: p.pricing || '',
          commonObjections: p.common_objections || '',
          competitors: p.competitors || '',
          keyTransformation: p.key_transformation || '',
          currentPromos: p.current_promos || '',
          whatsappPhoneNumberId: p.whatsapp_phone_number_id || '',
          whatsappAccessToken: p.whatsapp_access_token || '',
          whatsappVerifyToken: p.whatsapp_verify_token || '',
        });
        setSaved(true);
      }
    } catch {}
  }

  async function handleSave() {
    if (!profile.businessName) {
      toast.error('Business name is required');
      return;
    }
    if (!profile.product) {
      toast.error('Describe what you sell');
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('sales-agent', {
        body: { action: 'onboard', ...profile },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'Failed to save');
      }

      toast.success('Sales agent configured! It will use this to close sales for you.');
      setSaved(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const update = (key: keyof BusinessProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tell us about your business. The AI agent will use this to have natural sales conversations, handle objections, and close deals on your behalf.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Your Name / Rep Name</Label>
          <Input
            placeholder="e.g. Sarah, Alex"
            value={profile.agentName}
            onChange={(e) => update('agentName', e.target.value)}
            className="text-xs h-8"
          />
          <p className="text-[10px] text-muted-foreground">The name the agent will use when chatting</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Business Name *</Label>
          <Input
            placeholder="e.g. FitLife Coaching"
            value={profile.businessName}
            onChange={(e) => update('businessName', e.target.value)}
            className="text-xs h-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">What do you sell? *</Label>
        <Textarea
          placeholder="Describe your product or service in detail. The more context, the better the agent sells it..."
          value={profile.product}
          onChange={(e) => update('product', e.target.value)}
          className="text-xs min-h-[70px]"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Who is your ideal customer?</Label>
          <Input
            placeholder="e.g. Women 25-40 interested in fitness"
            value={profile.targetCustomer}
            onChange={(e) => update('targetCustomer', e.target.value)}
            className="text-xs h-8"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Pricing</Label>
          <Input
            placeholder="e.g. $97/month or $497 one-time"
            value={profile.pricing}
            onChange={(e) => update('pricing', e.target.value)}
            className="text-xs h-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">What do customers usually hesitate about?</Label>
        <Textarea
          placeholder='e.g. "Is it worth the price?" → Highlight the 90-day money-back guarantee and show testimonials...'
          value={profile.commonObjections}
          onChange={(e) => update('commonObjections', e.target.value)}
          className="text-xs min-h-[60px]"
        />
        <p className="text-[10px] text-muted-foreground">List common objections and how you want the agent to handle them</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Competitors</Label>
          <Input
            placeholder="e.g. Noom, MyFitnessPal"
            value={profile.competitors}
            onChange={(e) => update('competitors', e.target.value)}
            className="text-xs h-8"
          />
          <p className="text-[10px] text-muted-foreground">So the agent knows how to differentiate you</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Key result you deliver</Label>
          <Input
            placeholder="e.g. Lose 20 lbs in 90 days"
            value={profile.keyTransformation}
            onChange={(e) => update('keyTransformation', e.target.value)}
            className="text-xs h-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Any active promotions?</Label>
        <Input
          placeholder="e.g. 50% off first month, ends Friday"
          value={profile.currentPromos}
          onChange={(e) => update('currentPromos', e.target.value)}
          className="text-xs h-8"
        />
        <p className="text-[10px] text-muted-foreground">The agent will use urgency and scarcity to close deals</p>
      </div>

      {/* WhatsApp Business API Connection */}
      <div className="border-t border-border pt-4 mt-4 space-y-3">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          📱 Connect WhatsApp Business API (Optional)
        </h4>
        <p className="text-[10px] text-muted-foreground">
          For always-on WhatsApp auto-replies without keeping a browser tab open. Get these from your Meta Developer dashboard → WhatsApp → API Setup.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Phone Number ID</Label>
            <Input
              placeholder="e.g. 123456789012345"
              value={profile.whatsappPhoneNumberId}
              onChange={(e) => update('whatsappPhoneNumberId', e.target.value)}
              className="text-xs h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Verify Token</Label>
            <Input
              placeholder="Any secret phrase you choose"
              value={profile.whatsappVerifyToken}
              onChange={(e) => update('whatsappVerifyToken', e.target.value)}
              className="text-xs h-8"
            />
            <p className="text-[10px] text-muted-foreground">You'll enter this same phrase in Meta's webhook config</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Access Token</Label>
          <Input
            type="password"
            placeholder="Your WhatsApp Business API access token"
            value={profile.whatsappAccessToken}
            onChange={(e) => update('whatsappAccessToken', e.target.value)}
            className="text-xs h-8"
          />
        </div>
        {profile.whatsappPhoneNumberId && (
          <div className="bg-muted/50 rounded-lg p-3 space-y-1">
            <p className="text-[10px] font-medium">Webhook URL (paste this in Meta):</p>
            <code className="text-[10px] text-primary break-all select-all block">
              {`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`}
            </code>
          </div>
        )}
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
        {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save & Activate Agent'}
      </Button>
    </div>
  );
}
