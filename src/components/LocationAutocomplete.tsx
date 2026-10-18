import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

const POPULAR_LOCATIONS = [
  'New York, USA', 'Los Angeles, USA', 'Chicago, USA', 'Houston, USA', 'Miami, USA',
  'San Francisco, USA', 'Seattle, USA', 'Austin, USA', 'Denver, USA', 'Atlanta, USA',
  'Dallas, USA', 'Boston, USA', 'Nashville, USA', 'San Diego, USA', 'Phoenix, USA',
  'Portland, USA', 'Las Vegas, USA', 'Philadelphia, USA', 'Detroit, USA', 'Minneapolis, USA',
  'London, UK', 'Manchester, UK', 'Birmingham, UK', 'Edinburgh, UK', 'Dublin, Ireland',
  'Toronto, Canada', 'Vancouver, Canada', 'Montreal, Canada', 'Calgary, Canada',
  'Sydney, Australia', 'Melbourne, Australia', 'Brisbane, Australia', 'Perth, Australia',
  'Paris, France', 'Berlin, Germany', 'Munich, Germany', 'Amsterdam, Netherlands',
  'Barcelona, Spain', 'Madrid, Spain', 'Rome, Italy', 'Milan, Italy',
  'Tokyo, Japan', 'Seoul, South Korea', 'Singapore', 'Hong Kong',
  'Dubai, UAE', 'Mumbai, India', 'Delhi, India', 'Bangalore, India',
  'São Paulo, Brazil', 'Mexico City, Mexico', 'Buenos Aires, Argentina',
  'Lagos, Nigeria', 'Cape Town, South Africa', 'Johannesburg, South Africa',
  'Durban, South Africa', 'Pretoria, South Africa', 'Soweto, South Africa',
  'Port Elizabeth, South Africa', 'Bloemfontein, South Africa', 'Sandton, South Africa',
  'Stellenbosch, South Africa', 'Centurion, South Africa', 'Pietermaritzburg, South Africa',
  'Stockholm, Sweden', 'Copenhagen, Denmark', 'Oslo, Norway', 'Helsinki, Finland',
  'Lisbon, Portugal', 'Vienna, Austria', 'Zurich, Switzerland', 'Brussels, Belgium',
  'Warsaw, Poland', 'Prague, Czech Republic', 'Budapest, Hungary',
  'Bangkok, Thailand', 'Jakarta, Indonesia', 'Kuala Lumpur, Malaysia',
  'Istanbul, Turkey', 'Tel Aviv, Israel', 'Cairo, Egypt',
];

interface LocationAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function LocationAutocomplete({ value, onChange, className, disabled }: LocationAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    const q = value.toLowerCase();
    const filtered = POPULAR_LOCATIONS.filter(loc => loc.toLowerCase().includes(q)).slice(0, 6);
    setSuggestions(filtered);
  }, [value]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={wrapperRef} className="relative flex-1">
      <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground z-10" />
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="New York, LA..."
        className={cn("pl-8 bg-input border-border text-[11px] h-8", className)}
        disabled={disabled}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border border-border bg-popover shadow-md overflow-hidden animate-in fade-in-0 zoom-in-95">
          {suggestions.map((loc) => (
            <button
              key={loc}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-foreground hover:bg-accent/10 transition-colors text-left"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(loc); setOpen(false); }}
            >
              <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
              {loc}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
