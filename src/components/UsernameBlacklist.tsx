import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, Plus, Ban } from 'lucide-react';
import { toast } from 'sonner';

const STORAGE_KEY = 'futnor_blacklist';

export function UsernameBlacklist() {
  const [usernames, setUsernames] = useState<string[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setUsernames(JSON.parse(saved));
    } catch {}
  }, []);

  const save = (list: string[]) => {
    setUsernames(list);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    // Sync to extension
    try {
      window.postMessage({ source: 'futnor-web', type: 'BLACKLIST_UPDATE', blacklist: list }, '*');
    } catch {}
  };

  const add = () => {
    const name = input.trim().replace('@', '').toLowerCase();
    if (!name) return;
    if (usernames.includes(name)) {
      toast.error(`@${name} is already blacklisted`);
      return;
    }
    save([...usernames, name]);
    setInput('');
    toast.success(`@${name} added to blacklist`);
  };

  const remove = (name: string) => {
    save(usernames.filter((u) => u !== name));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="@username"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="flex-1"
        />
        <Button onClick={add} size="sm" className="gap-1.5">
          <Plus className="w-4 h-4" /> Add
        </Button>
      </div>

      {usernames.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
          <Ban className="w-3.5 h-3.5" />
          <span>No blacklisted usernames. The bot will engage with everyone.</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {usernames.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive/10 text-destructive text-xs font-medium border border-destructive/20"
            >
              @{name}
              <button onClick={() => remove(name)} className="hover:text-destructive/80">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {usernames.length} username{usernames.length !== 1 ? 's' : ''} blacklisted — bot will skip these accounts
      </p>
    </div>
  );
}
