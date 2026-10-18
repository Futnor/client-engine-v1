import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Upload,
  Sparkles,
  Send,
  Loader2,
  Image as ImageIcon,
  X,
  Tags,
  Search,
  AtSign,
  Instagram,
  CheckCircle2,
  AlertCircle,
  Copy,
  PenLine,
  Trash2,
  Pencil,
  Check,
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

export function AITargetingPanel({ platform = 'instagram', onAITargetingChange }: { platform?: 'instagram' | 'tiktok'; onAITargetingChange?: (data: { enabled: boolean; keywords: string[]; contentTags: string[]; targetAudience: string; searchTerms: string[] }) => void }) {
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [customMessage, setCustomMessage] = useState('');
  const [profiles, setProfiles] = useState<OutreachProfile[]>([]);
  const [username, setUsername] = useState('');
  const [searchingUsername, setSearchingUsername] = useState(false);
  const [igConnected, setIgConnected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const usernameFileRef = useRef<HTMLInputElement>(null);
  const [uploadedUsernames, setUploadedUsernames] = useState<string[]>([]);

  // Profile management
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editProfileMessage, setEditProfileMessage] = useState('');
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());
  const isTikTok = platform === 'tiktok';

  useEffect(() => {
    loadProfiles();
    checkConnection();
    if (platform === 'instagram') loadUploadedUsernames();
  }, [platform]);

  const checkConnection = () => {
    const w = window as any;
    if (typeof w.chrome !== 'undefined' && w.chrome?.runtime?.sendMessage) {
      try {
        w.chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state: any) => {
          if (w.chrome.runtime.lastError) { setIgConnected(false); return; }
          setIgConnected(!!state);
        });
      } catch { setIgConnected(false); }
    } else { setIgConnected(false); }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image file'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => setPreviewUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
    setUploading(true);
    try {
      const fileName = `${Date.now()}-${file.name}`;
      const { data, error } = await supabase.storage.from('reference-images').upload(fileName, file);
      if (error) throw error;
      const { data: urlData } = supabase.storage.from('reference-images').getPublicUrl(data.path);
      setAnalyzing(true);
      setUploading(false);
      const { data: analysisData, error: analysisError } = await supabase.functions.invoke('analyze-image', { body: { imageUrl: urlData.publicUrl } });
      if (analysisError) throw analysisError;
      const result = analysisData.analysis as AIAnalysis;
      setAnalysis(result);
      setCustomMessage(result.suggested_message || customMessage);
      toast.success('Image analyzed successfully!');
      // Sync AI targeting data
      onAITargetingChange?.({
        enabled: true,
        keywords: result.search_keywords || [],
        contentTags: result.content_tags || [],
        targetAudience: result.target_audience || '',
        searchTerms: [...(result.search_keywords || []).slice(0, 5), ...(result.content_tags || []).slice(0, 3)],
      });
    } catch (err: any) {
      toast.error(err.message || 'Failed to process image');
    } finally { setUploading(false); setAnalyzing(false); }
  };

  const handleUsernameSearch = async () => {
    const cleaned = username.trim().replace(/^@/, '');
    if (!cleaned) { toast.error('Please enter a username'); return; }
    setSearchingUsername(true);
    try {
      const { data: analysisData, error } = await supabase.functions.invoke('analyze-image', { body: { username: cleaned } });
      if (error) throw error;
      const result = analysisData.analysis as AIAnalysis;
      setAnalysis(result);
      setCustomMessage(result.suggested_message || customMessage);
      setPreviewUrl(`https://instagram.com/${cleaned}`);
      toast.success(`Analyzed @${cleaned} — similar profiles identified!`);
      // Sync AI targeting data
      onAITargetingChange?.({
        enabled: true,
        keywords: result.search_keywords || [],
        contentTags: result.content_tags || [],
        targetAudience: result.target_audience || '',
        searchTerms: [cleaned, ...(result.search_keywords || []).slice(0, 4), ...(result.content_tags || []).slice(0, 3)],
      });
    } catch (err: any) {
      toast.error(err.message || 'Failed to analyze username');
    } finally { setSearchingUsername(false); }
  };

  const handleUsernameFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let usernames: string[] = [];
    if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
      usernames = text.split(/[,\n\r]+/).map(u => u.trim().replace(/^@/, '')).filter(Boolean);
    } else { toast.error('Please upload a .txt or .csv file'); return; }
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

  const saveProfile = async () => {
    if (!analysis) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error('You must be logged in'); return; }
      const { error } = await supabase.from('outreach_profiles').insert({
        image_url: previewUrl || '',
        ai_description: analysis.description,
        content_tags: analysis.content_tags,
        custom_message: customMessage || analysis.suggested_message || '',
        is_active: true,
        platform,
        user_id: user.id,
      });
      if (error) throw error;
      toast.success('Outreach profile saved!');
      loadProfiles();
      clearUpload();
    } catch (err: any) { toast.error(err.message || 'Failed to save profile'); }
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('outreach_profiles').select('*').eq('platform', platform).order('created_at', { ascending: false });
    if (data) setProfiles(data as OutreachProfile[]);
  };

  const deleteProfile = async (id: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').delete().eq('id', id);
      if (error) throw error;
      toast.success('Profile deleted');
      setProfiles(prev => prev.filter(p => p.id !== id));
      setSelectedProfileIds(prev => { const next = new Set(prev); next.delete(id); return next; });
      if (expandedProfileId === id) setExpandedProfileId(null);
    } catch (err: any) { toast.error(err.message || 'Failed to delete'); }
  };

  const deleteSelectedProfiles = async () => {
    if (selectedProfileIds.size === 0) return;
    try {
      const ids = Array.from(selectedProfileIds);
      const { error } = await supabase.from('outreach_profiles').delete().in('id', ids);
      if (error) throw error;
      toast.success(`Deleted ${ids.length} profile(s)`);
      setProfiles(prev => prev.filter(p => !selectedProfileIds.has(p.id)));
      setSelectedProfileIds(new Set());
      if (expandedProfileId && selectedProfileIds.has(expandedProfileId)) setExpandedProfileId(null);
    } catch (err: any) { toast.error(err.message || 'Failed to delete'); }
  };

  const toggleSelectProfile = (id: string) => {
    setSelectedProfileIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedProfileIds.size === profiles.length) {
      setSelectedProfileIds(new Set());
    } else {
      setSelectedProfileIds(new Set(profiles.map(p => p.id)));
    }
  };

  const renameProfile = async (id: string, newDesc: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').update({ ai_description: newDesc }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, ai_description: newDesc } : p));
      setRenamingProfileId(null);
      toast.success('Profile renamed');
    } catch (err: any) { toast.error(err.message || 'Failed to rename'); }
  };

  const updateProfileMessage = async (id: string, message: string) => {
    try {
      const { error } = await supabase.from('outreach_profiles').update({ custom_message: message }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, custom_message: message } : p));
      setEditingProfileId(null);
      toast.success('Message updated');
    } catch (err: any) { toast.error(err.message || 'Failed to update'); }
  };

  const toggleProfileActive = async (id: string, active: boolean) => {
    try {
      const { error } = await supabase.from('outreach_profiles').update({ is_active: active }).eq('id', id);
      if (error) throw error;
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, is_active: active } : p));
    } catch (err: any) { toast.error(err.message || 'Failed to toggle'); }
  };

  const copyVariation = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const clearUpload = () => {
    setPreviewUrl(null);
    setAnalysis(null);
    setUsername('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Sub-header */}
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-accent" />
        <span className="text-sm font-semibold text-foreground">AI Targeting</span>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-primary/30 text-primary">Business+</Badge>
      </div>

      {/* Platform Connection Status — only show when NOT connected */}
      {!igConnected && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-warning/30 bg-warning/5">
          {isTikTok ? (
            <svg className="w-4 h-4 text-warning" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 0 0-.79-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.93a8.2 8.2 0 0 0 4.76 1.52V7a4.84 4.84 0 0 1-1-.31z"/></svg>
          ) : (
            <Instagram className="w-4 h-4 text-warning" />
          )}
          <span className="text-xs font-medium text-warning">
            Open {isTikTok ? 'TikTok' : 'Instagram'} & install extension to connect
          </span>
          <AlertCircle className="w-3.5 h-3.5 text-warning ml-auto" />
        </div>
      )}

      {/* Tabs: Photo / Username / Upload List */}
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
                <span className="text-xs font-medium text-foreground">{uploadedUsernames.length} usernames in queue</span>
                <Badge variant="secondary" className="text-[10px]">Pending</Badge>
              </div>
              <ScrollArea className="h-[120px]">
                <div className="flex flex-wrap gap-1.5">
                  {uploadedUsernames.map((u, i) => <Badge key={i} variant="outline" className="text-[10px]">@{u}</Badge>)}
                </div>
              </ScrollArea>
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

      {/* Saved Profiles */}
      {profiles.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">Saved Profiles ({profiles.length})</h3>
            <div className="flex items-center gap-2">
              <button onClick={toggleSelectAll} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                {selectedProfileIds.size === profiles.length ? 'Deselect all' : 'Select all'}
              </button>
              {selectedProfileIds.size > 0 && (
                <Button size="sm" variant="destructive" className="h-6 text-[10px] gap-1" onClick={deleteSelectedProfiles}>
                  <Trash2 className="w-3 h-3" /> Delete ({selectedProfileIds.size})
                </Button>
              )}
            </div>
          </div>
          <ScrollArea className="h-[400px]">
            <div className="space-y-2 pr-3">
              {profiles.map((profile) => {
                const isExpanded = expandedProfileId === profile.id;
                const isRenaming = renamingProfileId === profile.id;
                const isEditingMsg = editingProfileId === profile.id;
                const isSelected = selectedProfileIds.has(profile.id);
                let displayMessage = profile.custom_message;
                let parsedVariations: string[] = [];
                try { const parsed = JSON.parse(profile.custom_message); if (Array.isArray(parsed)) { parsedVariations = parsed; displayMessage = parsed[0] || ''; } } catch { /* not JSON */ }

                return (
                  <div key={profile.id} className={`rounded-lg bg-secondary/30 border overflow-hidden transition-colors ${isSelected ? 'border-primary/50 bg-primary/5' : 'border-border/50'}`}>
                    <div className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-secondary/50 transition-colors">
                      {/* Checkbox */}
                      <div className="flex-shrink-0" onClick={e => { e.stopPropagation(); toggleSelectProfile(profile.id); }}>
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40 hover:border-muted-foreground'}`}>
                          {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0" onClick={() => setExpandedProfileId(isExpanded ? null : profile.id)}>
                        <ImageIcon className="w-5 h-5 text-muted-foreground inline-block mr-2 align-middle" />
                        {isRenaming ? (
                          <div className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
                            <Input value={renameText} onChange={e => setRenameText(e.target.value)} className="h-6 text-[11px] py-0 w-40" autoFocus onKeyDown={e => { if (e.key === 'Enter') renameProfile(profile.id, renameText); if (e.key === 'Escape') setRenamingProfileId(null); }} />
                            <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => renameProfile(profile.id, renameText)}><Check className="w-3 h-3" /></Button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">{profile.ai_description?.slice(0, 60) || 'Untitled profile'}</span>
                        )}
                        <div className="flex items-center gap-1.5 mt-1">
                          {profile.content_tags?.filter(t => t !== 'dm-scripts' && t !== 'comment-scripts').slice(0, 3).map((tag, i) => <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{tag}</Badge>)}
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
                              <Textarea value={editProfileMessage} onChange={e => setEditProfileMessage(e.target.value)} className="text-xs min-h-[60px]" autoFocus />
                              <div className="flex gap-1.5">
                                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => updateProfileMessage(profile.id, editProfileMessage)}><Check className="w-3 h-3" /> Save</Button>
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
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground" onClick={() => { setEditingProfileId(profile.id); setEditProfileMessage(profile.custom_message); }}><Pencil className="w-3 h-3" /> Edit {isTikTok ? 'Comment' : 'Message'}</Button>
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
    </div>
  );
}
