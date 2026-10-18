import { useState, useRef, useEffect } from 'react';
import { LocationAutocomplete } from '@/components/LocationAutocomplete';
import { HashtagAutocomplete } from '@/components/HashtagAutocomplete';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Upload,
  Sparkles,
  Send,
  Loader2,
  Image as ImageIcon,
  X,
  Target,
  MessageSquare,
  Tags,
  Search,
  AtSign,
  Instagram,
  CheckCircle2,
  AlertCircle,
  Wand2,
  Copy,
  RefreshCw,
  PenLine,
  Trash2,
  Pencil,
  Check,
  Hash,
  MapPin,
  User,
  FileText,
} from 'lucide-react';

interface AIAnalysis {
  description: string;
  content_tags: string[];
  search_keywords: string[];
  target_audience: string;
  suggested_message: string;
}

interface OutreachProfile {
  id: string;
  image_url: string;
  ai_description: string | null;
  content_tags: string[];
  custom_message: string;
  is_active: boolean;
  platform?: string;
}

export function OutreachPanel({ platform = 'instagram' }: { platform?: 'instagram' | 'tiktok' }) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [customMessage, setCustomMessage] = useState("");
  const [profiles, setProfiles] = useState<OutreachProfile[]>([]);
  const [username, setUsername] = useState('');
  const [searchingUsername, setSearchingUsername] = useState(false);
  const [igConnected, setIgConnected] = useState(false);
  const [dmVariations, setDmVariations] = useState<string[]>([]);
  const [generatingVariations, setGeneratingVariations] = useState(false);
  const [dmMode, setDmMode] = useState<'write' | 'generate'>('generate');
  const [dmTips, setDmTips] = useState('');
  const [personalize, setPersonalize] = useState(true);
  const [hashtags, setHashtags] = useState('');
  const [location, setLocation] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const usernameFileRef = useRef<HTMLInputElement>(null);
  const [uploadedUsernames, setUploadedUsernames] = useState<string[]>([]);

  // Profile management state
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editProfileMessage, setEditProfileMessage] = useState('');
  // Track whether the profile being edited stores its message as a JSON array (DM scripts).
  // If true the textarea shows one variation per line and we save back as JSON array.
  const [editingIsScripts, setEditingIsScripts] = useState(false);

  // Check Instagram connection via Chrome extension
  useEffect(() => {
    loadProfiles();
    loadSavedScripts();
    checkInstagramConnection();
  }, [platform]);

  const checkInstagramConnection = () => {
    const w = window as any;
    if (typeof w.chrome !== 'undefined' && w.chrome?.runtime?.sendMessage) {
      try {
        w.chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state: any) => {
          if (w.chrome.runtime.lastError) {
            setIgConnected(false);
            return;
          }
          setIgConnected(!!state);
        });
      } catch {
        setIgConnected(false);
      }
    } else {
      setIgConnected(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => setPreviewUrl(ev.target?.result as string);
    reader.readAsDataURL(file);

    setUploading(true);
    try {
      const fileName = `${Date.now()}-${file.name}`;
      const { data, error } = await supabase.storage
        .from('reference-images')
        .upload(fileName, file);

      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('reference-images')
        .getPublicUrl(data.path);

      setAnalyzing(true);
      setUploading(false);

      const { data: analysisData, error: analysisError } = await supabase.functions
        .invoke('analyze-image', {
          body: { imageUrl: urlData.publicUrl },
        });

      if (analysisError) throw analysisError;

      const result = analysisData.analysis as AIAnalysis;
      setAnalysis(result);
      setCustomMessage(result.suggested_message || customMessage);

      toast.success('Image analyzed successfully!');
    } catch (err: any) {
      console.error('Upload/analyze error:', err);
      toast.error(err.message || 'Failed to process image');
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  };

  const handleUsernameSearch = async () => {
    const cleaned = username.trim().replace(/^@/, '');
    if (!cleaned) {
      toast.error('Please enter a username');
      return;
    }

    setSearchingUsername(true);
    try {
      const { data: analysisData, error: analysisError } = await supabase.functions
        .invoke('analyze-image', {
          body: { username: cleaned },
        });

      if (analysisError) throw analysisError;

      const result = analysisData.analysis as AIAnalysis;
      setAnalysis(result);
      setCustomMessage(result.suggested_message || customMessage);
      setPreviewUrl(`https://instagram.com/${cleaned}`);

      toast.success(`Analyzed @${cleaned} — similar profiles identified!`);
    } catch (err: any) {
      console.error('Username search error:', err);
      toast.error(err.message || 'Failed to analyze username');
    } finally {
      setSearchingUsername(false);
    }
  };

  const generateVariations = async () => {
    setGeneratingVariations(true);
    try {
      const body: any = { personalize };
      if (dmMode === 'write' && customMessage.trim()) {
        body.script = customMessage.trim();
      } else {
        body.context = analysis?.target_audience || analysis?.description || 'Instagram users';
      }
      body.count = 7;

      // Add targeting
      const parsedHashtags = hashtags
        .split(/[,\s]+/)
        .map(h => h.replace(/^#/, '').trim())
        .filter(Boolean);
      if (parsedHashtags.length > 0) body.hashtags = parsedHashtags;
      if (location.trim()) body.location = location.trim();

      const { data, error } = await supabase.functions.invoke('generate-dm-variations', { body });
      if (error) throw error;

      setDmVariations(data.variations || []);
      setDmTips(data.tips || '');
      toast.success(`Generated ${data.variations?.length || 0} message variations!`);
    } catch (err: any) {
      console.error('Variation generation error:', err);
      toast.error(err.message || 'Failed to generate variations');
    } finally {
      setGeneratingVariations(false);
    }
  };

  const copyVariation = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const removeVariation = (index: number) => {
    setDmVariations(prev => prev.filter((_, i) => i !== index));
  };

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditText(dmVariations[index]);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    setDmVariations(prev => prev.map((msg, i) => i === editingIndex ? editText : msg));
    setEditingIndex(null);
    setEditText('');
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditText('');
  };

  const saveScripts = async () => {
    // If no variations generated yet but user typed a plain message, use it directly
    const scriptsToSave = dmVariations.length > 0
      ? dmVariations
      : customMessage.trim() ? [customMessage.trim()] : [];
    if (scriptsToSave.length === 0) return;
    try {
      // Tag must match what useBotSession looks for: 'comment-scripts' for TikTok, 'dm-scripts' for Instagram
      const scriptTag = platform === 'tiktok' ? 'comment-scripts' : 'dm-scripts';
      // Save as a special outreach profile entry for DM scripts
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error('You must be logged in'); return; }
      const { error } = await supabase.from('outreach_profiles').insert({
        image_url: '',
        ai_description: dmMode === 'write' ? `Variations of: "${customMessage.slice(0, 80)}"` : 'AI-generated outreach scripts',
        content_tags: [scriptTag],
        custom_message: JSON.stringify(scriptsToSave),
        is_active: true,
        platform,
        user_id: user.id,
      });
      if (error) throw error;

      // Also cache directly in localStorage so the extension bridge always has the latest
      // scripts even if the Supabase query fails at session-start time.
      try {
        const BOT_STATE_KEY = 'futnor_bot_state';
        const raw = localStorage.getItem(BOT_STATE_KEY);
        if (raw) {
          const state = JSON.parse(raw);
          state.config = { ...(state.config || {}), dmTemplates: scriptsToSave };
          localStorage.setItem(BOT_STATE_KEY, JSON.stringify(state));
        }
      } catch { /* non-critical */ }

      toast.success('DM scripts saved! They will be used during outreach.');
      loadProfiles();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save scripts');
    }
  };

  // Load saved scripts on mount
  const loadSavedScripts = async () => {
    const { data } = await supabase
      .from('outreach_profiles')
      .select('custom_message')
      .contains('content_tags', ['dm-scripts'])
      .eq('platform', platform)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (data?.[0]?.custom_message) {
      try {
        const saved = JSON.parse(data[0].custom_message);
        if (Array.isArray(saved) && saved.length > 0) {
          setDmVariations(saved);
        }
      } catch { /* not JSON, ignore */ }
    }
  };

  const saveProfile = async () => {
    if (!analysis) return;

    try {
      const messageToSave = dmVariations.length > 0 
        ? JSON.stringify(dmVariations) 
        : customMessage || analysis.suggested_message || 'Hey! Check your DMs 👀';
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) { toast.error('You must be logged in'); return; }
      const { error } = await supabase.from('outreach_profiles').insert({
        image_url: previewUrl || '',
        ai_description: analysis.description,
        content_tags: analysis.content_tags,
        custom_message: messageToSave,
        is_active: true,
        platform,
        user_id: currentUser.id,
      });

      if (error) throw error;

      toast.success('Outreach profile saved!');
      loadProfiles();
      clearUpload();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save profile');
    }
  };

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('outreach_profiles')
      .select('*')
      .eq('platform', platform)
      .order('created_at', { ascending: false });

    if (data) setProfiles(data as OutreachProfile[]);
  };

  const deleteProfile = async (id: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').delete().eq('id', id);
      if (error) throw error;
      toast.success('Profile deleted');
      setProfiles(prev => prev.filter(p => p.id !== id));
      if (expandedProfileId === id) setExpandedProfileId(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const renameProfile = async (id: string, newDesc: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').update({ ai_description: newDesc }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, ai_description: newDesc } : p));
      setRenamingProfileId(null);
      toast.success('Profile renamed');
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename');
    }
  };

  const updateProfileMessage = async (id: string, message: string, isScripts: boolean) => {
    try {
      // If the profile stores DM/comment scripts as a JSON array, split the textarea by blank
      // lines (user writes one variation per paragraph) and save as a JSON array so the bot
      // engine can still parse it correctly.
      const toSave = isScripts
        ? JSON.stringify(message.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean))
        : message;
      const { error } = await supabase.from('outreach_profiles').update({ custom_message: toSave }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, custom_message: toSave } : p));
      setEditingProfileId(null);
      toast.success('Message updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    }
  };

  const toggleProfileActive = async (id: string, active: boolean) => {
    try {
      const { error } = await supabase.from('outreach_profiles').update({ is_active: active }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, is_active: active } : p));
    } catch (err: any) {
      toast.error(err.message || 'Failed to toggle');
    }
  };

  const clearUpload = () => {
    setPreviewUrl(null);
    setAnalysis(null);
    setUsername('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUsernameFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let usernames: string[] = [];
    if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
      usernames = text.split(/[,\n\r]+/).map(u => u.trim().replace(/^@/, '')).filter(Boolean);
    } else {
      toast.error('Please upload a .txt or .csv file');
      return;
    }
    if (usernames.length === 0) { toast.error('No usernames found in file'); return; }
    try {
      const { data: { user: qUser } } = await supabase.auth.getUser();
      if (!qUser) { toast.error('You must be logged in'); return; }
      const rows = usernames.map(u => ({
        instagram_username: u, platform, status: 'pending' as const,
        match_reason: 'Uploaded from file', custom_message: customMessage || null,
        user_id: qUser.id,
      }));
      const { error } = await supabase.from('outreach_queue').insert(rows);
      if (error) throw error;
      setUploadedUsernames(prev => [...prev, ...usernames]);
      toast.success(`${usernames.length} usernames added to DM queue!`);
    } catch (err: any) { toast.error(err.message || 'Failed to save usernames'); }
    if (usernameFileRef.current) usernameFileRef.current.value = '';
  };

  const loadUploadedUsernames = async () => {
    const { data } = await supabase.from('outreach_queue')
      .select('instagram_username, status').eq('platform', platform)
      .eq('match_reason', 'Uploaded from file').order('created_at', { ascending: false }).limit(100);
    if (data) setUploadedUsernames(data.map(d => d.instagram_username || '').filter(Boolean));
  };

  useEffect(() => { if (platform === 'instagram') loadUploadedUsernames(); }, [platform]);

  const isTikTok = platform === 'tiktok';

  return (
    <Card className="glass p-6 space-y-5">
      {/* Sub-header */}
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-accent" />
        <span className="text-sm font-semibold text-foreground">{isTikTok ? 'AI Comment Scripts' : 'AI Outreach'}</span>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-primary/30 text-primary">Business+</Badge>
      </div>

      {/* Platform Connection Status */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${igConnected ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'}`}>
        {isTikTok ? (
          <svg className={`w-4 h-4 ${igConnected ? 'text-success' : 'text-warning'}`} viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.93a8.2 8.2 0 0 0 4.76 1.52V7a4.84 4.84 0 0 1-1-.31z"/></svg>
        ) : (
          <Instagram className={`w-4 h-4 ${igConnected ? 'text-success' : 'text-warning'}`} />
        )}
        <span className={`text-xs font-medium ${igConnected ? 'text-success' : 'text-warning'}`}>
          {igConnected ? `${isTikTok ? 'TikTok' : 'Instagram'} connected` : `Open ${isTikTok ? 'TikTok' : 'Instagram'} & install extension to connect`}
        </span>
        {igConnected ? <CheckCircle2 className="w-3.5 h-3.5 text-success ml-auto" /> : <AlertCircle className="w-3.5 h-3.5 text-warning ml-auto" />}
      </div>

      {/* ── TikTok: Comment scripts only ── */}
      {isTikTok ? (
        <div className="space-y-3 p-4 rounded-xl border border-border/50 bg-secondary/20">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">Comment Script Builder</span>
          </div>
          <p className="text-xs text-muted-foreground">TikTok doesn't support automated DMs. Create comment scripts below — the bot will post these as public comments on videos.</p>

          {/* Targeting */}
          <div className="space-y-2">
            <span className="text-[11px] font-medium text-foreground">Targeting (optional)</span>
            <div className="flex gap-2">
              <HashtagAutocomplete value={hashtags} onChange={setHashtags} />
              <LocationAutocomplete value={location} onChange={setLocation} />
            </div>
          </div>

          <div className="flex gap-1">
            <button onClick={() => setDmMode('write')} className={`text-[10px] px-2.5 py-1 rounded-md transition-colors ${dmMode === 'write' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}><PenLine className="w-3 h-3 inline mr-1" />Write</button>
            <button onClick={() => setDmMode('generate')} className={`text-[10px] px-2.5 py-1 rounded-md transition-colors ${dmMode === 'generate' ? 'bg-accent/20 text-accent' : 'text-muted-foreground hover:text-foreground'}`}><Wand2 className="w-3 h-3 inline mr-1" />AI Generate</button>
          </div>

          {dmMode === 'write' ? (
            <div className="space-y-2">
              <Textarea value={customMessage} onChange={(e) => setCustomMessage(e.target.value)} placeholder='e.g. "This is amazing! 🔥"' className="bg-input border-border text-sm resize-none" rows={3} />
              <p className="text-[10px] text-muted-foreground">Write a base comment and AI will generate natural variations</p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">AI will generate engaging, context-aware comments for TikTok videos</p>
          )}

          <Button onClick={generateVariations} disabled={generatingVariations || (dmMode === 'write' && !customMessage.trim())} size="sm" className="w-full gap-2 bg-gradient-to-r from-accent to-primary text-accent-foreground hover:opacity-90">
            {generatingVariations ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            {generatingVariations ? 'Generating...' : dmMode === 'write' ? 'Generate Comment Variations' : 'Create Comment Scripts'}
          </Button>

          {dmVariations.length > 0 && (
            <div className="space-y-2 animate-fade-in">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">{dmVariations.length} Comment Scripts</span>
                <button onClick={generateVariations} disabled={generatingVariations} className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"><RefreshCw className={`w-3 h-3 ${generatingVariations ? 'animate-spin' : ''}`} /> Regenerate</button>
              </div>
              <ScrollArea className="h-[200px]">
                <div className="space-y-1.5 pr-3">
                  {dmVariations.map((msg, i) => (
                    <div key={i} className="group flex items-start gap-2 p-2 rounded-md bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
                      <span className="text-[10px] text-muted-foreground font-mono mt-0.5 flex-shrink-0">{i + 1}.</span>
                      {editingIndex === i ? (
                        <div className="flex-1 space-y-1.5">
                          <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="bg-input border-border text-[11px] resize-none min-h-[40px]" rows={2} autoFocus />
                          <div className="flex gap-1">
                            <button onClick={saveEdit} className="text-[10px] px-2 py-0.5 rounded bg-success/20 text-success hover:bg-success/30 transition-colors flex items-center gap-1"><Check className="w-3 h-3" /> Save</button>
                            <button onClick={cancelEdit} className="text-[10px] px-2 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-[11px] text-foreground/80 flex-1 leading-relaxed">{msg}</p>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                            <button onClick={() => startEditing(i)} className="p-1 text-muted-foreground hover:text-primary transition-colors"><Pencil className="w-3 h-3" /></button>
                            <button onClick={() => copyVariation(msg)} className="p-1 text-muted-foreground hover:text-primary transition-colors"><Copy className="w-3 h-3" /></button>
                            <button onClick={() => removeVariation(i)} className="p-1 text-muted-foreground hover:text-destructive transition-colors"><Trash2 className="w-3 h-3" /></button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {dmTips && <p className="text-[10px] text-muted-foreground italic bg-secondary/30 rounded p-2">💡 {dmTips}</p>}
              <Button onClick={saveScripts} size="sm" variant="outline" className="w-full gap-2 border-success/30 text-success hover:bg-success/10"><CheckCircle2 className="w-4 h-4" /> Save Comment Scripts</Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* ── Instagram: Full DM outreach + file upload ── */}
          <Tabs defaultValue="upload" className="w-full">
            <TabsList className="grid w-full grid-cols-3 bg-secondary/50">
              <TabsTrigger value="upload" className="text-xs gap-1.5"><Upload className="w-3.5 h-3.5" /> Photo</TabsTrigger>
              <TabsTrigger value="username" className="text-xs gap-1.5"><AtSign className="w-3.5 h-3.5" /> Username</TabsTrigger>
              <TabsTrigger value="file" className="text-xs gap-1.5"><FileText className="w-3.5 h-3.5" /> Upload List</TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="mt-3">
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
              {!previewUrl ? (
                <button onClick={() => fileInputRef.current?.click()} className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-all duration-300" disabled={uploading}>
                  {uploading ? <Loader2 className="w-7 h-7 text-primary animate-spin" /> : <Upload className="w-7 h-7 text-muted-foreground" />}
                  <span className="text-xs text-muted-foreground">{uploading ? 'Uploading...' : 'Upload a reference photo'}</span>
                </button>
              ) : (
                <div className="relative">
                  <img src={previewUrl} alt="Reference" className="w-full h-40 object-cover rounded-xl border border-border" />
                  <button onClick={clearUpload} className="absolute top-2 right-2 w-7 h-7 rounded-full bg-background/80 backdrop-blur flex items-center justify-center hover:bg-destructive/20 transition-colors"><X className="w-3.5 h-3.5 text-foreground" /></button>
                  {analyzing && (
                    <div className="absolute inset-0 bg-background/60 backdrop-blur-sm rounded-xl flex items-center justify-center gap-2">
                      <Sparkles className="w-5 h-5 text-primary animate-pulse" /><span className="text-sm text-primary font-medium">Analyzing...</span>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="username" className="mt-3 space-y-3">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="instagram_username" className="pl-9 bg-input border-border text-sm" onKeyDown={(e) => e.key === 'Enter' && handleUsernameSearch()} />
                </div>
                <Button onClick={handleUsernameSearch} disabled={searchingUsername || !username.trim()} size="sm" className="gap-1.5 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
                  {searchingUsername ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Find
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">Enter a username to find accounts with similar content & aesthetic</p>
            </TabsContent>

            {/* File Upload Tab */}
            <TabsContent value="file" className="mt-3 space-y-3">
              <input ref={usernameFileRef} type="file" accept=".txt,.csv" onChange={handleUsernameFileUpload} className="hidden" />
              <button onClick={() => usernameFileRef.current?.click()} className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-all duration-300">
                <FileText className="w-7 h-7 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Upload .txt or .csv with usernames</span>
                <span className="text-[10px] text-muted-foreground">One username per line, or comma-separated</span>
              </button>
              {uploadedUsernames.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">{uploadedUsernames.length} usernames in DM queue</span>
                    <Badge variant="secondary" className="text-[10px]">Pending</Badge>
                  </div>
                  <ScrollArea className="h-[120px]">
                    <div className="flex flex-wrap gap-1.5">
                      {uploadedUsernames.map((u, i) => <Badge key={i} variant="outline" className="text-[10px]">@{u}</Badge>)}
                    </div>
                  </ScrollArea>
                  <p className="text-[10px] text-muted-foreground">The bot will navigate to each profile and send your DM script during the session.</p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* AI Analysis Results */}
          {analysis && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" /><span className="text-sm font-medium text-foreground">AI Analysis</span></div>
                <p className="text-xs text-muted-foreground leading-relaxed bg-secondary/50 rounded-lg p-3">{analysis.description}</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Tags className="w-4 h-4 text-accent" /><span className="text-sm font-medium text-foreground">Content Tags</span></div>
                <div className="flex flex-wrap gap-1.5">{analysis.content_tags.map((tag, i) => <Badge key={i} variant="secondary" className="text-[10px]">{tag}</Badge>)}</div>
              </div>
              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground">Search Keywords</span>
                <div className="flex flex-wrap gap-1.5">{analysis.search_keywords.map((kw, i) => <Badge key={i} variant="outline" className="text-[10px]">{kw}</Badge>)}</div>
              </div>
              {analysis.target_audience && (
                <div className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Target Audience</span>
                  <p className="text-[11px] text-muted-foreground bg-secondary/30 rounded-lg p-2.5">{analysis.target_audience}</p>
                </div>
              )}
              <Button onClick={saveProfile} className="w-full gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90"><Send className="w-4 h-4" /> Save Outreach Profile</Button>
            </div>
          )}

          {/* DM Script Builder */}
          <div className="space-y-3 p-4 rounded-xl border border-border/50 bg-secondary/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><MessageSquare className="w-4 h-4 text-success" /><span className="text-sm font-semibold text-foreground">DM Script Builder</span></div>
              <div className="flex gap-1">
                <button onClick={() => setDmMode('write')} className={`text-[10px] px-2.5 py-1 rounded-md transition-colors ${dmMode === 'write' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}><PenLine className="w-3 h-3 inline mr-1" />Write</button>
                <button onClick={() => setDmMode('generate')} className={`text-[10px] px-2.5 py-1 rounded-md transition-colors ${dmMode === 'generate' ? 'bg-accent/20 text-accent' : 'text-muted-foreground hover:text-foreground'}`}><Wand2 className="w-3 h-3 inline mr-1" />AI Generate</button>
              </div>
            </div>

            <div className="flex items-center justify-between p-2 rounded-lg bg-background/50 border border-border/30">
              <div className="flex items-center gap-2"><User className="w-3.5 h-3.5 text-primary" /><span className="text-[11px] font-medium text-foreground">Use {'{name}'} placeholder</span></div>
              <Switch checked={personalize} onCheckedChange={setPersonalize} />
            </div>
            {personalize && <p className="text-[10px] text-muted-foreground -mt-1">Messages will include {'{name}'} — replaced with the recipient's actual name at send time</p>}

            <div className="space-y-2">
              <span className="text-[11px] font-medium text-foreground">Targeting (optional)</span>
              <div className="flex gap-2">
                <HashtagAutocomplete value={hashtags} onChange={setHashtags} />
                <LocationAutocomplete value={location} onChange={setLocation} />
              </div>
              <p className="text-[10px] text-muted-foreground">Add hashtags or location to tailor messages for specific audiences</p>
            </div>

            {dmMode === 'write' ? (
              <div className="space-y-2">
                <Textarea value={customMessage} onChange={(e) => setCustomMessage(e.target.value)} placeholder='e.g. "Hey {name}! Loved your latest post — wanted to reach out 👋"' className="bg-input border-border text-sm resize-none" rows={3} />
                <p className="text-[10px] text-muted-foreground">Use <span className="font-mono text-primary">{'{name}'}</span> where you want the recipient's first name — it gets swapped automatically at send time. AI will generate variations.</p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{analysis ? 'AI will create personalized messages based on your target audience analysis' : 'AI will generate natural outreach messages — upload a photo or search a username above for more personalized results'}</p>
            )}

            <Button onClick={generateVariations} disabled={generatingVariations || (dmMode === 'write' && !customMessage.trim())} size="sm" className="w-full gap-2 bg-gradient-to-r from-accent to-primary text-accent-foreground hover:opacity-90">
              {generatingVariations ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {generatingVariations ? 'Generating...' : dmMode === 'write' ? 'Generate Variations' : 'Create DM Messages'}
            </Button>

            {dmVariations.length > 0 && (
              <div className="space-y-2 animate-fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{dmVariations.length} Variations</span>
                  <button onClick={generateVariations} disabled={generatingVariations} className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"><RefreshCw className={`w-3 h-3 ${generatingVariations ? 'animate-spin' : ''}`} /> Regenerate</button>
                </div>
                <ScrollArea className="h-[200px]">
                  <div className="space-y-1.5 pr-3">
                    {dmVariations.map((msg, i) => (
                      <div key={i} className="group flex items-start gap-2 p-2 rounded-md bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
                        <span className="text-[10px] text-muted-foreground font-mono mt-0.5 flex-shrink-0">{i + 1}.</span>
                        {editingIndex === i ? (
                          <div className="flex-1 space-y-1.5">
                            <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="bg-input border-border text-[11px] resize-none min-h-[40px]" rows={2} autoFocus />
                            <div className="flex gap-1">
                              <button onClick={saveEdit} className="text-[10px] px-2 py-0.5 rounded bg-success/20 text-success hover:bg-success/30 transition-colors flex items-center gap-1"><Check className="w-3 h-3" /> Save</button>
                              <button onClick={cancelEdit} className="text-[10px] px-2 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="text-[11px] text-foreground/80 flex-1 leading-relaxed">{msg}</p>
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                              <button onClick={() => startEditing(i)} className="p-1 text-muted-foreground hover:text-primary transition-colors"><Pencil className="w-3 h-3" /></button>
                              <button onClick={() => copyVariation(msg)} className="p-1 text-muted-foreground hover:text-primary transition-colors"><Copy className="w-3 h-3" /></button>
                              <button onClick={() => removeVariation(i)} className="p-1 text-muted-foreground hover:text-destructive transition-colors"><Trash2 className="w-3 h-3" /></button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                {dmTips && <p className="text-[10px] text-muted-foreground italic bg-secondary/30 rounded p-2">💡 {dmTips}</p>}
                <Button onClick={saveScripts} size="sm" variant="outline" className="w-full gap-2 border-success/30 text-success hover:bg-success/10"><CheckCircle2 className="w-4 h-4" /> Save DM Scripts</Button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Saved Profiles */}
      {profiles.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">Saved Profiles ({profiles.length})</h3>
          <ScrollArea className="h-[400px]">
            <div className="space-y-2 pr-3">
              {profiles.map((profile) => {
                const isExpanded = expandedProfileId === profile.id;
                const isRenaming = renamingProfileId === profile.id;
                const isEditingMsg = editingProfileId === profile.id;
                let displayMessage = profile.custom_message;
                let parsedVariations: string[] = [];
                try { const parsed = JSON.parse(profile.custom_message); if (Array.isArray(parsed)) { parsedVariations = parsed; displayMessage = parsed[0] || ''; } } catch { /* not JSON */ }

                return (
                  <div key={profile.id} className="rounded-lg bg-secondary/30 border border-border/50 overflow-hidden">
                    <div className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-secondary/50 transition-colors" onClick={() => setExpandedProfileId(isExpanded ? null : profile.id)}>
                      <ImageIcon className="w-6 h-6 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        {isRenaming ? (
                          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                            <Input value={renameText} onChange={e => setRenameText(e.target.value)} className="h-6 text-[11px] py-0" autoFocus onKeyDown={e => { if (e.key === 'Enter') renameProfile(profile.id, renameText); if (e.key === 'Escape') setRenamingProfileId(null); }} />
                            <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => renameProfile(profile.id, renameText)}><Check className="w-3 h-3" /></Button>
                          </div>
                        ) : (
                          <p className="text-[11px] text-muted-foreground truncate">{profile.ai_description?.slice(0, 60) || 'Untitled profile'}</p>
                        )}
                        <div className="flex items-center gap-1.5 mt-1">
                          {profile.content_tags?.filter(t => t !== 'dm-scripts').slice(0, 3).map((tag, i) => <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{tag}</Badge>)}
                          {parsedVariations.length > 0 && (
                            <span className="text-[9px] text-muted-foreground">• {parsedVariations.length} scripts</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <Switch checked={profile.is_active ?? true} onCheckedChange={(v) => toggleProfileActive(profile.id, v)} className="scale-75" />
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border/30 space-y-3">
                        <div className="space-y-1.5">
                          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                            {isTikTok ? 'Comment' : 'Message'} {parsedVariations.length > 0 ? `Scripts (${parsedVariations.length})` : ''}
                          </span>
                          {isEditingMsg ? (
                            <div className="space-y-2">
                              <Textarea
                                value={editProfileMessage}
                                onChange={e => setEditProfileMessage(e.target.value)}
                                className="text-xs min-h-[60px]"
                                autoFocus
                                placeholder={editingIsScripts ? 'One variation per paragraph (separate with a blank line)' : 'Enter message...'}
                              />
                              {editingIsScripts && (
                                <p className="text-[9px] text-muted-foreground">Each paragraph (separated by a blank line) becomes one script variation.</p>
                              )}
                              <div className="flex gap-1.5">
                                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => updateProfileMessage(profile.id, editProfileMessage, editingIsScripts)}><Check className="w-3 h-3" /> Save</Button>
                                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setEditingProfileId(null)}>Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <ScrollArea className={parsedVariations.length > 4 ? 'h-[200px]' : ''}>
                              <div className="space-y-1 pr-2">
                                {parsedVariations.length > 0 
                                  ? parsedVariations.map((v, i) => (
                                    <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-background/50 border border-border/30 group">
                                      <span className="text-[10px] text-muted-foreground font-mono mt-0.5 flex-shrink-0">{i + 1}.</span>
                                      <p className="text-[11px] text-foreground/80 flex-1 leading-relaxed break-words">{v}</p>
                                      <button onClick={() => copyVariation(v)} className="p-1 text-muted-foreground hover:text-primary transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"><Copy className="w-3 h-3" /></button>
                                    </div>
                                  ))
                                  : <p className="text-[11px] text-foreground/80 bg-background/50 rounded p-2 break-words">{displayMessage}</p>
                                }
                              </div>
                            </ScrollArea>
                          )}
                        </div>
                        <div className="flex gap-1.5 pt-1">
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground" onClick={() => { setRenamingProfileId(profile.id); setRenameText(profile.ai_description || ''); }}><PenLine className="w-3 h-3" /> Rename</Button>
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground" onClick={() => {
                            // Convert JSON arrays to one-variation-per-line so users see plain text, not raw JSON.
                            let editableMsg = profile.custom_message;
                            let isScripts = false;
                            try {
                              const parsed = JSON.parse(profile.custom_message);
                              if (Array.isArray(parsed) && parsed.length > 0) {
                                editableMsg = parsed.join('\n\n');
                                isScripts = true;
                              }
                            } catch { /* not JSON – edit as plain text */ }
                            setEditingProfileId(profile.id);
                            setEditProfileMessage(editableMsg);
                            setEditingIsScripts(isScripts);
                          }}><Pencil className="w-3 h-3" /> Edit {isTikTok ? 'Comment' : 'Message'}</Button>
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => deleteProfile(profile.id)}><Trash2 className="w-3 h-3" /> Delete</Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      )}
    </Card>
  );
}


