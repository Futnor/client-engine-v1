/**
 * © 2024–2026 Client Engine. All rights reserved.
 * Unauthorized reproduction, distribution, or use of this software is strictly prohibited.
 * This software is proprietary and confidential.
 */

const ALLOWED_ORIGINS = [
  'futnor-dm-bot.lovable.app',
  'clientengine.ai',
  'www.clientengine.ai',
  'futnormarketing.com',
  'www.futnormarketing.com',
  'localhost',
  '127.0.0.1',
  'id-preview--19359686-a7ef-40e1-bf43-2fcfc1e04ed3.lovable.app',
];

export function checkDomainAuthorization(): boolean {
  try {
    const hostname = window.location.hostname;
    
    // Allow Lovable preview/published domains
    if (hostname.endsWith('.lovable.app')) return true;
    if (hostname.endsWith('.lovableproject.com')) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    
    return ALLOWED_ORIGINS.includes(hostname);
  } catch {
    return false;
  }
}

export function enforceDomainLock(): void {
  if (!checkDomainAuthorization()) {
    // Clear the page and show unauthorized message
    document.documentElement.innerHTML = '';
    document.title = 'Unauthorized';
    
    const body = document.createElement('body');
    body.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#ef4444;font-family:system-ui;text-align:center;margin:0;';
    body.innerHTML = `
      <div>
        <h1 style="font-size:2rem;margin-bottom:1rem">⛔ Unauthorized</h1>
        <p style="color:#888;max-width:400px">This software is licensed exclusively to Client Engine.<br/>Running it on unauthorized domains is prohibited.</p>
        <p style="color:#555;font-size:0.75rem;margin-top:2rem">© 2024–2026 Client Engine. All rights reserved.</p>
      </div>
    `;
    document.documentElement.appendChild(body);
    
    // Prevent any further JS execution
    throw new Error('[Client Engine] Unauthorized domain detected. Execution halted.');
  }
}
