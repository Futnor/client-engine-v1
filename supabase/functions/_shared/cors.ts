/**
 * © 2024–2026 Client Engine. All rights reserved.
 * Shared CORS origin validation for all edge functions.
 */

const ALLOWED_ORIGINS = [
  'https://futnor-dm-bot.lovable.app',
  'https://clientengine.ai',
  'https://www.clientengine.ai',
  'https://futnormarketing.com',
  'https://www.futnormarketing.com',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://localhost:3000',
];

const LOVABLE_PREVIEW_PATTERN = /^https:\/\/.*\.(lovable\.app|lovableproject\.com)$/;
const CHROME_EXTENSION_PATTERN = /^chrome-extension:\/\/[a-z]{32}$/;

function isKnownOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (LOVABLE_PREVIEW_PATTERN.test(origin)) return true;
  if (CHROME_EXTENSION_PATTERN.test(origin)) return true;
  return false;
}

export function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') || '';
  if (isKnownOrigin(origin)) return origin;
  // Extension / server-to-server requests may omit the Origin header.
  if (!origin) return '*';
  return '';
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const allowedOrigin = getAllowedOrigin(req);
  return {
    'Access-Control-Allow-Origin': allowedOrigin || 'https://clientengine.ai',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  };
}

export function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get('origin') || '';
  if (!origin) return true; // extension / server-to-server
  return isKnownOrigin(origin);
}
