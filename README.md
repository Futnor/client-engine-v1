# Client Engine (v1)

The first product I built: a Chrome extension plus web app that finds a business's ideal customers on Instagram and TikTok and sends them personalised DMs from the owner's own logged-in account. It was published on the Chrome Web Store.

- **Chrome Web Store:** https://chromewebstore.google.com/detail/client-engine/eicljdnooilphfgibigncfkiohlhddck
- **Website:** https://futnormarketing.com

## What it does

- Finds prospects by hashtag or from a list you paste in
- Writes a personalised first message for each one with AI
- Sends DMs and comments like a human: random delays, a slow warm-up for new accounts, hourly and daily limits, and rest periods instead of hard stops
- Tracks every conversation and reply in a dashboard
- Plans and subscriptions with Stripe

## How it's built

- **Chrome extension** (Manifest V3): `chrome-extension/` runs inside Instagram, TikTok and WhatsApp Web
- **Web app:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui (`src/`)
- **Backend:** Supabase (Postgres, auth, edge functions in `supabase/functions/`)
- **AI:** writes the opening messages and post comments
- Built with AI coding tools (Lovable, then Claude Code)

## What I learned

The extension worked, but Instagram suspends accounts that send automated DMs. So I stopped building against the platforms and moved to the way Meta officially allows. That became my current company: **Client Engine Reply** (https://futnor.com), an AI assistant that answers a business's customers on WhatsApp through Meta's approved WhatsApp Business Platform.

## Running it yourself

Copy `.env.example` to `.env` and fill in your own Supabase project. This copy has no keys, accounts or customer data in it.

## License

Proprietary. The source is shared here to show my work. See `LICENSE`.

Built by Sizo Gugushe, founder of Futnor.
