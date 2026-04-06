# Minimal Subscriptions

Text-first, chronological YouTube subscriptions feed.

No recommendations, no ranking model, no autoplay prompts.

## Features

- Dual import paths in V1:
  - Google OAuth import (`youtube.readonly`) to fetch your subscriptions list
  - OPML upload from YouTube-Subscriptions-RSS export
- Chronological feed only (newest first)
- No clickbait-oriented sorting logic
- YouTube open target by default
- Optional Invidious playback links
- Thumbnails off by default for a calmer reading flow
- Minimal serverless backend for RSS aggregation and CORS-safe fetching
- Local-first persistence (`localStorage`) for channels, settings, and cached feed

## Tech Stack

- Plain HTML5
- CSS3 (custom properties, flat zero-radius design)
- Vanilla JavaScript (ES6+)
- Vercel Serverless Function (`api/feed.js`) for YouTube RSS aggregation

## Project Structure

```text
minimalsubscriptions/
|- index.html
|- style.css
|- script.js
|- api/
|  |- feed.js
|- assets/
|  |- images/
|  |- fonts/
|- vercel.json
|- README.md
```

## Local Usage

For full functionality (frontend + API), run with Vercel dev:

```bash
vercel dev
```

Then open the local URL printed by Vercel.

## Google Import Setup

Google import needs a Web OAuth Client ID.

1. Create a Google Cloud project.
2. Enable YouTube Data API v3.
3. Create OAuth credentials of type Web application.
4. Add your local/dev origin to Authorized JavaScript origins.
5. Put the client id into this tag in `index.html`:

```html
<meta name="google-client-id" content="YOUR_CLIENT_ID.apps.googleusercontent.com">
```

Scope used:

- `https://www.googleapis.com/auth/youtube.readonly`

The app only imports your subscriptions list and does not post or modify YouTube data.

## OPML Import Setup

1. Go to `https://www.youtube.com/feed/channels` while logged in.
2. Run the script or bookmarklet from `jeb5/YouTube-Subscriptions-RSS`.
3. Export `youtube_subs.opml`.
4. Upload that file in Minimal Subscriptions.

## API Behavior

Endpoint: `POST /api/feed`

Request body:

```json
{
    "channelIds": ["UCxxxxxxxxxxxxxxxxxxxxxx"],
    "limitPerChannel": 8
}
```

Response includes:

- `videos`: normalized, deduplicated, chronologically sorted video items
- `failures`: per-channel fetch failures (partial success is allowed)
- `generatedAt`: feed generation timestamp

## Design Direction

This project follows Elouan's baseline:

- Dark-first stone palette
- Flat UI and zero border radius
- Monospace headings and clean sans body text
- Minimal, purposeful motion

It adds selective expressive accents through atmospheric background layering and restrained staged reveal animation.

## Privacy Model

- Subscriptions and UI preferences are stored locally in your browser.
- The backend fetches public channel RSS feeds.
- No recommendation profile or engagement scoring is created.

## Known Constraints

- YouTube RSS feed availability can change over time.
- OPML export script depends on YouTube page structure.
- Google OAuth import requires manual cloud setup.
- `yt-dlp` integration is intentionally out of scope for V1.

## Deployment

Deploy on Vercel:

```bash
vercel
```

## License

MIT
