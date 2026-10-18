import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const WHATSAPP_URL = 'https://wa.me/message/7HADS3XGBRTPL1';

export default function Support() {
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      window.location.href = WHATSAPP_URL;
    }, 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen p-6 md:p-8 lg:p-10">
      <div className="max-w-xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-3xl font-bold">Contact Support</h1>
        </div>

        <Card>
          <CardContent className="p-8 text-center space-y-5">
            <div className="w-16 h-16 rounded-full bg-[#25D366]/15 text-[#25D366] mx-auto flex items-center justify-center">
              <MessageCircle className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">Chat with us on WhatsApp</h2>
              <p className="text-sm text-muted-foreground mt-2">
                The fastest way to reach support. We reply during business hours.
              </p>
            </div>
            <Button
              asChild
              size="lg"
              className="w-full bg-[#25D366] hover:bg-[#1ebe57] text-white"
            >
              <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-4 h-4 mr-2" />
                Open WhatsApp chat
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              Redirecting you automatically… or{' '}
              <Link to="/" className="underline hover:text-foreground">
                go back home
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
