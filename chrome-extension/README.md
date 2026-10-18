# Client Engine — Chrome Extension

AI-powered client acquisition bot for Instagram & TikTok.

## Installation

1. Download the extension ZIP from your Client Engine dashboard
2. Open Chrome → navigate to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the extracted folder

## Usage

1. Navigate to `https://www.instagram.com/` or `https://www.tiktok.com/` and log in
2. Open your Client Engine dashboard
3. Configure targeting, session duration, and daily limits
4. Click **Start** to begin the session
5. The bot will scroll, like, follow, and send DMs/comments with human-like timing

## Platform Differences

| Feature | Instagram | TikTok |
|---------|-----------|--------|
| Scrolling | Feed browsing | Video feed browsing |
| Liking | Like posts | Like videos |
| Following | Follow users | Follow creators |
| Engagement | Send DMs | Post comments on videos |

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration (Manifest V3) |
| `background.js` | Service worker — session orchestration |
| `instagram/content.js` | Instagram DOM interactions |
| `tiktok/content.js` | TikTok DOM interactions |
| `dashboard/content.js` | Dashboard ↔ extension bridge |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup logic |
