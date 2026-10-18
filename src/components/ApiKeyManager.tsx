import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Key, Copy, Check, Trash2, Plus, Eye, EyeOff } from 'lucide-react';

interface ApiKeyRow {
  id: string;
  key_prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

export function ApiKeyManager() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState('');

  const fetchKeys = async () => {
    const { data } = await supabase
      .from('api_keys')
      .select('id, key_prefix, label, created_at, last_used_at, revoked')
      .eq('revoked', false)
      .order('created_at', { ascending: false });
    if (data) setKeys(data as ApiKeyRow[]);
  };

  useEffect(() => { fetchKeys(); }, []);

  const generateKey = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('api-key', {
        body: { action: 'generate', label: label || 'Default' },
      });
      if (error) throw error;
      setNewKey(data.key);
      setShowKey(true);
      setLabel('');
      toast.success('API key generated! Copy it now — it won\'t be shown again.');
      fetchKeys();
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate key');
    } finally {
      setLoading(false);
    }
  };

  const revokeKey = async (id: string) => {
    if (!confirm('Delete this User Key? Anyone using it will be signed out and unable to log in again.')) return;
    const { error } = await supabase.from('api_keys').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('User Key deleted — it can no longer be used to sign in');
    fetchKeys();
    setNewKey(null);
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      toast.success('Copied to clipboard!');
    }
  };

  return (
    <div className="glass rounded-xl p-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <Key className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">User Key</h3>
        <span className="text-xs text-muted-foreground">Connect other Instagram accounts</span>
      </div>

      <p className="text-xs text-muted-foreground">
        Generate a User Key and paste it into the dashboard on any other Chrome profile where a different Instagram account is logged in. That account will be linked to your Futnor subscription automatically.
      </p>

      {/* New key display */}
      {newKey && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
          <p className="text-xs font-medium text-primary">⚠️ Copy this key now — it won't be shown again!</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-background/50 rounded px-3 py-2 overflow-x-auto">
              {showKey ? newKey : '•'.repeat(40)}
            </code>
            <Button variant="ghost" size="icon" onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={copyKey}>
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Generate new key */}
      <div className="flex gap-2">
        <Input
          placeholder="Account label (optional, e.g. @myaccount2)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="flex-1"
        />
        <Button onClick={generateKey} disabled={loading} className="gap-2">
          <Plus className="w-4 h-4" />
          Generate User Key
        </Button>
      </div>

      {/* Existing keys */}
      {keys.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Active User Keys</p>
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{k.label}</span>
                  <code className="text-xs text-muted-foreground font-mono">{k.key_prefix}</code>
                </div>
                <p className="text-xs text-muted-foreground">
                  Created {new Date(k.created_at).toLocaleDateString()}
                  {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => revokeKey(k.id)} className="text-destructive hover:text-destructive">
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
