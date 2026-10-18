import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const WHATSAPP_URL = 'https://wa.me/message/7HADS3XGBRTPL1';

export function SupportWidget() {
  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with support on WhatsApp"
      className={cn(
        'fixed bottom-5 right-5 z-40 flex items-center justify-center',
        'w-14 h-14 rounded-full shadow-lg transition-all duration-200',
        'bg-[#25D366] text-white hover:scale-105',
        'focus:outline-none focus:ring-2 focus:ring-[#25D366] focus:ring-offset-2 focus:ring-offset-background',
      )}
    >
      <MessageCircle className="w-6 h-6" />
    </a>
  );
}
