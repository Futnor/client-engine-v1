import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Hash } from 'lucide-react';
import { cn } from '@/lib/utils';

const POPULAR_HASHTAGS = [
  // General engagement
  'fyp', 'foryou', 'foryoupage', 'viral', 'trending', 'explore', 'reels', 'instadaily',
  // Lifestyle
  'lifestyle', 'motivation', 'inspiration', 'mindset', 'selfcare', 'wellness', 'mentalhealth',
  'dailyroutine', 'morningroutine', 'productivity', 'goals', 'success', 'hustle', 'grind',
  // Fitness & Health
  'fitness', 'gym', 'workout', 'fitfam', 'bodybuilding', 'yoga', 'crossfit', 'running',
  'healthylifestyle', 'nutrition', 'mealprep', 'weightloss', 'gains', 'personaltrainer',
  // Fashion & Beauty
  'fashion', 'style', 'ootd', 'outfitoftheday', 'streetstyle', 'beauty', 'makeup',
  'skincare', 'hairstyle', 'nails', 'fashionblogger', 'beautytips', 'grwm', 'getreadywithme',
  // Food & Cooking
  'food', 'foodie', 'cooking', 'recipe', 'foodporn', 'healthyfood', 'vegan', 'baking',
  'restaurant', 'foodblogger', 'homecooking', 'easyrecipe', 'mealideas',
  // Travel
  'travel', 'wanderlust', 'travelgram', 'adventure', 'explore', 'travelphotography',
  'vacation', 'roadtrip', 'backpacking', 'digitalnomad', 'travelblogger',
  // Business & Finance
  'business', 'entrepreneur', 'startup', 'smallbusiness', 'marketing', 'digitalmarketing',
  'socialmedia', 'branding', 'ecommerce', 'investing', 'crypto', 'realestate', 'finance',
  'passiveincome', 'sidehustle', 'dropshipping', 'affiliatemarketing',
  // Tech
  'tech', 'coding', 'programming', 'webdev', 'ai', 'software', 'gadgets', 'apple',
  // Photography & Art
  'photography', 'art', 'design', 'creative', 'graphicdesign', 'illustration', 'drawing',
  'photooftheday', 'photographer', 'digitalart', 'aesthetic',
  // Entertainment
  'music', 'dance', 'comedy', 'funny', 'memes', 'gaming', 'movie', 'netflix', 'anime',
  // Pets & Animals
  'pets', 'dogs', 'cats', 'puppy', 'kitten', 'dogsofinstagram', 'catsofinstagram',
  // Education
  'education', 'learning', 'studytips', 'studywithme', 'booktok', 'bookstagram',
  // Parenting & Family
  'parenting', 'momlife', 'family', 'kids', 'baby', 'newborn', 'motherhood',
  // South Africa specific
  'southafrica', 'capetown', 'johannesburg', 'durban', 'mzansi', 'proudlysa',
  'southafricanfood', 'safashion', 'exploreSA',
];

interface HashtagAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function HashtagAutocomplete({ value, onChange, className, disabled }: HashtagAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Get the last tag being typed (after last comma/space)
    const parts = value.split(/[,\s]+/);
    const current = parts[parts.length - 1]?.replace(/^#/, '').toLowerCase() || '';
    if (!current) { setSuggestions([]); return; }
    const filtered = POPULAR_HASHTAGS.filter(h => h.includes(current) && !parts.slice(0, -1).some(p => p.replace(/^#/, '').toLowerCase() === h)).slice(0, 6);
    setSuggestions(filtered);
  }, [value]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectTag = (tag: string) => {
    const parts = value.split(/[,\s]+/).filter(Boolean);
    parts[parts.length - 1] = tag;
    onChange(parts.join(', ') + ', ');
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative flex-1">
      <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground z-10" />
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="fitness, travel, food"
        className={cn("pl-8 bg-input border-border text-[11px] h-8", className)}
        disabled={disabled}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border border-border bg-popover shadow-md overflow-hidden animate-in fade-in-0 zoom-in-95">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-accent/10 transition-colors text-left"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectTag(tag)}
            >
              <Hash className="w-3 h-3 text-muted-foreground shrink-0" />
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
