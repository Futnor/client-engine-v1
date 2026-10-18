# Supabase Auth Redirect URL allowlist

If users get this error during sign-up or Google login:

> Authorization request is invalid: redirect_uri is not allowed
> Error code: invalid_request

…it means the URL the frontend sent in `emailRedirectTo` (or
`redirect_uri` for OAuth) is not listed in the project's
**Auth → URL Configuration → Redirect URLs** allowlist.

## How to fix (one-time admin task)

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → your project →
   **Authentication** → **URL Configuration**.

2. Set **Site URL** to:

   ```
   https://futnormarketing.com
   ```

3. Under **Redirect URLs**, add ALL of the following entries, one per line.
   Each origin × path combination the frontend can possibly send must be
   present, otherwise that specific path returns the error.

   ```
   https://futnormarketing.com
   https://futnormarketing.com/app
   https://futnormarketing.com/reset-password
   https://www.futnormarketing.com
   https://www.futnormarketing.com/app
   https://www.futnormarketing.com/reset-password
   https://futnor-dm-bot.lovable.app
   https://futnor-dm-bot.lovable.app/app
   https://futnor-dm-bot.lovable.app/reset-password
   https://*.lovable.app/*
   https://*.lovableproject.com/*
   http://localhost:5173
   http://localhost:5173/app
   http://localhost:5173/reset-password
   http://localhost:8080
   http://localhost:8080/app
   http://localhost:8080/reset-password
   http://localhost:3000
   http://localhost:3000/app
   http://localhost:3000/reset-password
   ```

4. Click **Save**.

## How to verify

- Open `futnormarketing.com/login` in an incognito window.
- Sign up with a fresh email address. The page should show
  *"Check your email to confirm your account!"* with no toast error.
- Click the confirmation link in the email — it should land you on
  `https://futnormarketing.com/app` and you should be signed in.
- Try **Continue with Google** as well. After the Google consent screen
  you should land back on `/app` signed in.

## Why these specific URLs

The frontend code (after commit a6cb714 / this fix) uses:

| Flow | URL it asks Supabase to redirect to |
|---|---|
| Email sign-up confirmation | `${window.location.origin}/app` |
| Google OAuth login | `${window.location.origin}/app` |
| Password reset link | `${window.location.origin}/reset-password` |

`window.location.origin` is whichever domain the user signed up FROM —
production (`futnormarketing.com`), the Lovable preview, or localhost
during development. Every origin you ship from must be whitelisted.

The wildcard `https://*.lovable.app/*` covers all Lovable preview
deploys (each PR gets its own subdomain) so you don't have to add new
entries every time.

## If you change the production domain

Update the list above (and the constants in
`supabase/functions/_shared/cors.ts`) to match. The two files together
are the canonical list of "places this app can run".
