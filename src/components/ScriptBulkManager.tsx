import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Plus, Trash2, Copy, CheckCircle2, Pencil, Sparkles, Loader2,
  Layers, ChevronDown, ChevronUp, Power, User as UserIcon, AlertCircle,
} from 'lucide-react';

interface ScriptBulk {
  id: string;
  name: string;
  scripts: string[];
  /** Lower-cased handles this bulk is active for. */
  activeAccounts: string[];
  /** True if active for the currently-selected account. */
  isActiveForCurrent: boolean;
}

interface Props {
  platform: 'instagram' | 'tiktok';
  disabled?: boolean;
  personalize?: boolean;
}

const BULK_TAG = 'script-bulk';
const ACCOUNT_PREFIX = 'account:';

const normalizeHandle = (raw: string | null | undefined): string =>
  (raw || '').toLowerCase().replace(/^@/, '').trim();

const readActiveAccount = (): string =>
  typeof window !== 'undefined' ? normalizeHandle(localStorage.getItem('futnor_active_account')) : '';

/** Extract the list of `account:<handle>` handles from tags. */
const extractActiveAccounts = (tags: string[] | null): string[] =>
  (tags || [])
    .filter((t) => typeof t === 'string' && t.startsWith(ACCOUNT_PREFIX))
    .map((t) => normalizeHandle(t.slice(ACCOUNT_PREFIX.length)))
    .filter(Boolean);

/** Build the canonical tag set: base tags + one `account:<handle>` per active account. */
const buildTags = (isTikTok: boolean, activeAccounts: string[], extra: string[] = []): string[] => {
  const base = [BULK_TAG, isTikTok ? 'comment-scripts' : 'dm-scripts'];
  const accountTags = Array.from(new Set(activeAccounts.map(normalizeHandle).filter(Boolean)))
    .map((h) => `${ACCOUNT_PREFIX}${h}`);
  const safeExtras = extra.filter(
    (t) =>
      !!t &&
      !t.startsWith(ACCOUNT_PREFIX) &&
      t !== BULK_TAG &&
      t !== 'comment-scripts' &&
      t !== 'dm-scripts',
  );
  return [...base, ...accountTags, ...safeExtras];
};

export function ScriptBulkManager({ platform, disabled, personalize = true }: Props) {
  const [bulks, setBulks] = useState<ScriptBulk[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newBulkName, setNewBulkName] = useState('');
  const [newScript, setNewScript] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ bulkId: string; index: number } | null>(null);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [activeAccount, setActiveAccount] = useState<string>(() => readActiveAccount());

  const isTikTok = platform === 'tiktok';
  const label = isTikTok ? 'Comment' : 'DM';

  // Poll for active account changes from the extension bridge.
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = readActiveAccount();
      setActiveAccount((prev) => (prev !== next ? next : prev));
    }, 1000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'futnor_active_account') setActiveAccount(readActiveAccount());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const loadBulks = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('outreach_profiles')
        .select('id, ai_description, custom_message, content_tags, is_active')
        .contains('content_tags', [BULK_TAG])
        .eq('platform', platform)
        .order('created_at', { ascending: true });
      if (error) throw error;
      const current = readActiveAccount();
      const mapped: ScriptBulk[] = (data || []).map((row) => {
        let scripts: string[] = [];
        try {
          const parsed = JSON.parse(row.custom_message || '[]');
          if (Array.isArray(parsed)) scripts = parsed.filter((s) => typeof s === 'string');
        } catch { /* ignore */ }
        const activeAccounts = extractActiveAccounts(row.content_tags);
        return {
          id: row.id,
          name: row.ai_description || 'Untitled Bulk',
          scripts,
          activeAccounts,
          isActiveForCurrent: !!current && activeAccounts.includes(current),
        };
      });
      setBulks(mapped);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load script bulks');
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => { loadBulks(); }, [loadBulks, activeAccount]);

  const createBulk = async () => {
    const name = newBulkName.trim();
    if (!name) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error('You must be logged in'); return; }
      const { error } = await supabase.from('outreach_profiles').insert({
        user_id: user.id,
        platform,
        image_url: '',
        ai_description: name,
        custom_message: JSON.stringify([]),
        content_tags: buildTags(isTikTok, []),
        is_active: false,
      });
      if (error) throw error;
      setNewBulkName('');
      toast.success(`Bulk "${name}" created`);
      loadBulks();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create bulk');
    }
  };

  const deleteBulk = async (id: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').delete().eq('id', id);
      if (error) throw error;
      toast.success('Bulk deleted');
      loadBulks();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const renameBulk = async (id: string) => {
    const name = renameText.trim();
    if (!name) return;
    try {
      const { error } = await supabase.from('outreach_profiles').update({ ai_description: name }).eq('id', id);
      if (error) throw error;
      setRenaming(null);
      loadBulks();
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename');
    }
  };

  const updateScripts = async (bulkId: string, scripts: string[]) => {
    try {
      const { error } = await supabase
        .from('outreach_profiles')
        .update({ custom_message: JSON.stringify(scripts) })
        .eq('id', bulkId);
      if (error) throw error;
      setBulks((prev) => prev.map((b) => (b.id === bulkId ? { ...b, scripts } : b)));
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    }
  };

  const addScriptToBulk = (bulkId: string) => {
    const text = (newScript[bulkId] || '').trim();
    if (!text) return;
    const bulk = bulks.find((b) => b.id === bulkId);
    if (!bulk) return;
    if (bulk.scripts.length >= 10) { toast.error('Max 10 scripts per bulk'); return; }
    updateScripts(bulkId, [...bulk.scripts, text]);
    setNewScript((p) => ({ ...p, [bulkId]: '' }));
  };

  const removeScript = (bulkId: string, index: number) => {
    const bulk = bulks.find((b) => b.id === bulkId);
    if (!bulk) return;
    updateScripts(bulkId, bulk.scripts.filter((_, i) => i !== index));
  };

  const saveScriptEdit = () => {
    if (!editing) return;
    const bulk = bulks.find((b) => b.id === editing.bulkId);
    if (!bulk) return;
    const updated = bulk.scripts.map((s, i) => (i === editing.index ? editText.trim() : s));
    updateScripts(editing.bulkId, updated);
    setEditing(null);
    setEditText('');
  };

  const copyScript = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const generateAI = async (bulkId: string) => {
    const bulk = bulks.find((b) => b.id === bulkId);
    if (!bulk) return;
    const seed = (newScript[bulkId] || '').trim();
    setGenerating(bulkId);
    try {
      const { data, error } = await supabase.functions.invoke('generate-dm-variations', {
        body: {
          script: seed || undefined,
          platform,
          count: isTikTok ? 8 : 7,
          personalize,
        },
      });
      if (error) throw error;
      if (data?.variations?.length) {
        const merged = [...bulk.scripts, ...data.variations].slice(0, 10);
        await updateScripts(bulkId, merged);
        setNewScript((p) => ({ ...p, [bulkId]: '' }));
        toast.success(`${data.variations.length} ${label.toLowerCase()} scripts generated`);
        if (data.tips) toast.info(data.tips, { duration: 6000 });
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate');
    } finally {
      setGenerating(null);
    }
  };

  /**
   * Toggle a bulk's active state for the CURRENT connected account only.
   * Each account is independent: turning a bulk on for account A does not
   * affect account B (which can have its own active bulk).
   * Per (user, platform, account) only one bulk can be active — so when
   * activating, we remove this account from any other bulk's active list.
   */
  const toggleBulk = async (bulkId: string, turnOn: boolean) => {
    const current = readActiveAccount();
    if (!current) {
      toast.error('No active account detected. Open Instagram/TikTok in the extension first.');
      return;
    }
    const bulk = bulks.find((b) => b.id === bulkId);
    if (!bulk) return;
    if (turnOn && bulk.scripts.length === 0) {
      toast.error('Add at least 1 script before activating');
      return;
    }
    try {
      if (turnOn) {
        // Remove this account from any other bulks that currently have it active.
        const others = bulks.filter(
          (b) => b.id !== bulkId && b.activeAccounts.includes(current),
        );
        for (const o of others) {
          const nextAccounts = o.activeAccounts.filter((a) => a !== current);
          await supabase
            .from('outreach_profiles')
            .update({
              content_tags: buildTags(isTikTok, nextAccounts),
              is_active: nextAccounts.length > 0,
            })
            .eq('id', o.id);
        }
        // Add current account to this bulk's active list.
        const nextAccounts = Array.from(new Set([...bulk.activeAccounts, current]));
        const { error } = await supabase
          .from('outreach_profiles')
          .update({
            content_tags: buildTags(isTikTok, nextAccounts),
            is_active: true,
          })
          .eq('id', bulkId);
        if (error) throw error;
        toast.success(`"${bulk.name}" is now active for @${current}`);
      } else {
        // Remove current account from this bulk's active list.
        const nextAccounts = bulk.activeAccounts.filter((a) => a !== current);
        const { error } = await supabase
          .from('outreach_profiles')
          .update({
            content_tags: buildTags(isTikTok, nextAccounts),
            is_active: nextAccounts.length > 0,
          })
          .eq('id', bulkId);
        if (error) throw error;
        toast.success(`"${bulk.name}" deactivated for @${current}`);
      }
      loadBulks();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    }
  };

  return (
    <div className="space-y-3">
      {/* Per-account scoping banner */}
      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
        <UserIcon className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <div>
            Each connected account uses its <strong className="text-primary">own active bulk</strong>.
            Toggling a bulk only affects the account currently open — other accounts under the same API key keep their own choice.
          </div>
          {activeAccount ? (
            <div className="text-muted-foreground">
              Active account: <strong className="text-foreground">@{activeAccount}</strong>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-warning">
              <AlertCircle className="w-3 h-3" />
              <span>No account detected — open Instagram/TikTok in the extension to enable toggling.</span>
            </div>
          )}
        </div>
      </div>

      {/* Create new bulk */}
      <div className="flex gap-2">
        <Input
          placeholder="New bulk name (e.g. Friendly Intro)"
          value={newBulkName}
          onChange={(e) => setNewBulkName(e.target.value)}
          disabled={disabled}
          className="text-sm"
        />
        <Button size="sm" onClick={createBulk} disabled={disabled || !newBulkName.trim()} className="gap-1.5 shrink-0">
          <Plus className="w-3.5 h-3.5" />
          New Bulk
        </Button>
      </div>

      {loading && (
        <div className="text-center py-4 text-xs text-muted-foreground">Loading bulks…</div>
      )}

      {!loading && bulks.length === 0 && (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
          No script bulks yet — create your first one above
        </div>
      )}

      {/* Bulks list */}
      {!loading && bulks.map((bulk) => {
        const expanded = expandedId === bulk.id;
        const otherAccounts = bulk.activeAccounts.filter((a) => a !== activeAccount);
        return (
          <div
            key={bulk.id}
            className={`rounded-lg border ${
              bulk.isActiveForCurrent ? 'border-success/50 bg-success/5' : 'border-border bg-card/40'
            } overflow-hidden`}
          >
            {/* Bulk header */}
            <div className="flex items-center gap-2 p-3">
              <Layers className={`w-4 h-4 shrink-0 ${bulk.isActiveForCurrent ? 'text-success' : 'text-muted-foreground'}`} />
              {renaming === bulk.id ? (
                <div className="flex-1 flex gap-1.5">
                  <Input
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    className="h-7 text-sm"
                    autoFocus
                  />
                  <Button size="sm" onClick={() => renameBulk(bulk.id)} className="h-7">Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)} className="h-7">Cancel</Button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setExpandedId(expanded ? null : bulk.id)}
                    className="flex-1 flex items-center gap-2 text-left min-w-0"
                  >
                    <span className="text-sm font-semibold truncate">{bulk.name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {bulk.scripts.length}/10 scripts
                    </span>
                    {bulk.isActiveForCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 bg-success/20 text-success">
                        ACTIVE
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { setRenameText(bulk.name); setRenaming(bulk.id); }}
                      className="p-1 rounded hover:bg-muted"
                      title="Rename"
                    >
                      <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => deleteBulk(bulk.id)}
                      className="p-1 rounded hover:bg-muted"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </button>
                    <button
                      onClick={() => setExpandedId(expanded ? null : bulk.id)}
                      className="p-1 rounded hover:bg-muted"
                      title={expanded ? 'Collapse' : 'Expand'}
                    >
                      {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Activate switch (per-account) */}
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-background/30">
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Power className={`w-3.5 h-3.5 shrink-0 ${bulk.isActiveForCurrent ? 'text-success' : 'text-muted-foreground'}`} />
                  <span className="text-xs truncate">
                    {activeAccount
                      ? bulk.isActiveForCurrent
                        ? `Active for @${activeAccount}`
                        : `Use this bulk for @${activeAccount}`
                      : 'Use this bulk for the active account'}
                  </span>
                </div>
                {otherAccounts.length > 0 && (
                  <span className="text-[10px] text-muted-foreground pl-5">
                    Also active on: {otherAccounts.map((a) => `@${a}`).join(', ')}
                  </span>
                )}
              </div>
              <Switch
                checked={bulk.isActiveForCurrent}
                onCheckedChange={(v) => toggleBulk(bulk.id, v)}
                disabled={disabled || !activeAccount}
              />
            </div>

            {/* Expanded: scripts editor */}
            {expanded && (
              <div className="p-3 space-y-2 border-t border-border">
                {/* Add script */}
                <div className="space-y-1.5">
                  <Textarea
                    placeholder={isTikTok ? 'e.g. "Love this 🔥"' : 'e.g. "Hey {name}! Loved your latest post 👋"'}
                    value={newScript[bulk.id] || ''}
                    onChange={(e) => setNewScript((p) => ({ ...p, [bulk.id]: e.target.value }))}
                    className="min-h-[60px] text-sm"
                    disabled={disabled}
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => addScriptToBulk(bulk.id)}
                      disabled={disabled || !(newScript[bulk.id] || '').trim() || bulk.scripts.length >= 10}
                      className="gap-1.5 h-7"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => generateAI(bulk.id)}
                      disabled={disabled || generating === bulk.id || bulk.scripts.length >= 10}
                      className="gap-1.5 h-7"
                    >
                      {generating === bulk.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Sparkles className="w-3 h-3" />}
                      AI Fill
                    </Button>
                  </div>
                </div>

                {/* Scripts list */}
                {bulk.scripts.length > 0 && (
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {bulk.scripts.map((script, i) => {
                      const key = `${bulk.id}:${i}`;
                      const isEditing = editing?.bulkId === bulk.id && editing?.index === i;
                      return (
                        <div
                          key={i}
                          className="group flex items-start gap-2 p-2 rounded bg-secondary/30 border border-border text-xs"
                        >
                          {isEditing ? (
                            <div className="flex-1 space-y-1.5">
                              <Textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                className="min-h-[50px] text-xs"
                              />
                              <div className="flex gap-1.5">
                                <Button size="sm" onClick={saveScriptEdit} className="h-6 text-xs">Save</Button>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(null)} className="h-6 text-xs">Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <span className="flex-1 text-muted-foreground break-words">{script}</span>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <button onClick={() => copyScript(key, script)} className="p-1 rounded hover:bg-muted">
                                  {copied === key
                                    ? <CheckCircle2 className="w-3 h-3 text-success" />
                                    : <Copy className="w-3 h-3 text-muted-foreground" />}
                                </button>
                                <button
                                  onClick={() => { setEditing({ bulkId: bulk.id, index: i }); setEditText(script); }}
                                  className="p-1 rounded hover:bg-muted"
                                >
                                  <Pencil className="w-3 h-3 text-muted-foreground" />
                                </button>
                                <button onClick={() => removeScript(bulk.id, i)} className="p-1 rounded hover:bg-muted">
                                  <Trash2 className="w-3 h-3 text-destructive" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
