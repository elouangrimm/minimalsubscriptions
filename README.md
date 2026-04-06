# Minimal Subscriptions

Minimal, no-clickbait YouTube subscriptions feed.

Main page is feed-first with one clear refresh action. Settings, imports, and subscription management live in a dedicated popup.

## What This Version Does

- Feed-first layout with uninterrupted timeline
- Clear primary action: Refresh Feed
- Separate settings popup for import, playback options, and subscription management
- Remove subscriptions from the settings popup (not from main feed)
- Shorts filtered out by default
- Batched loading by channel groups to reduce bandwidth and improve speed
- Optional thumbnail rendering (off by default)
- YouTube opens by default, optional Invidious links

## Tech Stack

- Plain HTML5
- CSS3 custom properties, dark flat stone palette, zero border radius
- Vanilla JavaScript (ES6+)
- Vercel serverless API for RSS fetching: `api/feed.js`

## Run Locally

Use Vercel dev so both static app and API route run together:

```bash
vercel dev
```

Then open the localhost URL printed by Vercel.

## Detailed Google Auth Setup

Google import uses browser OAuth and reads subscriptions with `youtube.readonly`.

### 1. Create Google Cloud project

1. Open Google Cloud Console.
2. Create a new project (or select an existing one).

### 2. Enable YouTube Data API v3

1. In APIs & Services, open Library.
2. Search for YouTube Data API v3.
3. Click Enable.

### 3. Configure OAuth consent screen

1. Open APIs & Services, then OAuth consent screen.
2. Choose External (or Internal for Workspace-only usage).
3. Fill required fields (app name, support email, developer contact).
4. Save.
5. Add test users if your app is not published.

### 4. Create OAuth client id (Web)

1. Open APIs & Services, then Credentials.
2. Click Create Credentials, OAuth client ID.
3. Application type: Web application.
4. Add Authorized JavaScript origins:
   - `http://localhost:3000`
   - Your deployed domain, for example `https://your-domain.vercel.app`
5. Create and copy the Client ID.

No redirect URI is required for this token-client flow.

### 5. Put client id into app

In `index.html`, set this meta tag:

```html
<meta name="google-client-id" content="YOUR_CLIENT_ID.apps.googleusercontent.com">
```

### 6. Verify import

1. Run `vercel dev`.
2. Open app.
3. Click Settings.
4. Use Import From Google.

### Common Google OAuth issues

- `origin_mismatch`: local or deployed origin missing from Authorized JavaScript origins.
- `access_denied`: user canceled consent or app is restricted to unlisted test users.
- no popup: browser popup blocker blocked Google auth window.

## OPML Import With Bookmarklet

This app supports OPML generated from the jeb5 tool.

Repository:

- [jeb5/YouTube-Subscriptions-RSS](https://github.com/jeb5/YouTube-Subscriptions-RSS)

### Option A: Drag bookmarklet from repo

1. Open the repository README.
2. Find the Bookmarklet section.
3. Drag the Bookmarklet link from that page into your bookmarks bar.
4. Go to `https://www.youtube.com/feed/channels` while logged in.
5. Click the saved bookmarklet.
6. Download `youtube_subs.opml`.

### Option B: Manual bookmark creation

1. Create a new browser bookmark.
2. Copy the `javascript:` code from the repository Bookmarklet section.
3. Paste it into the bookmark URL field.
4. Open `https://www.youtube.com/feed/channels` and click the bookmark.
5. Download `youtube_subs.opml`.

### Import into app

1. Open Settings.
2. Use Select OPML File.
3. Choose `youtube_subs.opml`.

## Feed Loading Model

The app loads feed data in batches by subscription channels.

- Refresh loads the first channel batch.
- Load More Channels fetches the next batch.
- This reduces initial bandwidth and keeps thumbnail mode from becoming too slow.

API endpoint: `POST /api/feed`

Request:

```json
{
    "channelIds": ["UCxxxxxxxxxxxxxxxxxxxxxx"],
    "limitPerChannel": 6,
    "cursor": 0,
    "batchSize": 20
}
```

Response fields include:

- `videos`
- `failures`
- `cursor`
- `nextCursor`
- `hasMore`
- `totalChannels`
- `loadedChannels`

## Privacy

- Imported subscriptions and UI settings are stored locally in browser storage.
- Serverless API fetches public RSS feeds.
- No recommendation profile or engagement ranking is generated.

## Deployment

Deploy with:

```bash
vercel
```

## License

MIT
