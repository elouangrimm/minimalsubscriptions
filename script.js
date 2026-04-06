const APP_CONFIG = window.MINIMAL_SUBS_CONFIG || {};
const CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;
const SHORTS_PATTERN = /(^|[\s\[\(])#?shorts\b/i;
const SHORTS_URL_PATTERN = /youtube\.com\/shorts\//i;
const FEED_CHANNEL_BATCH_SIZE = 20;
const FEED_LIMIT_PER_CHANNEL = 6;
const DEFAULT_MAX_VIDEO_AGE_DAYS = 14;
const DEFAULT_MAX_VISIBLE_VIDEOS = 60;

const STORAGE_KEYS = {
    channels: "minimalSubscriptions.channels",
    videos: "minimalSubscriptions.videos",
    settings: "minimalSubscriptions.settings",
    feedMeta: "minimalSubscriptions.feedMeta"
};

const DEFAULT_SETTINGS = {
    playbackProvider: "youtube",
    invidiousBase: "https://yewtu.be",
    showThumbnails: false,
    showShorts: false,
    maxAgeDays: DEFAULT_MAX_VIDEO_AGE_DAYS,
    maxVisibleVideos: DEFAULT_MAX_VISIBLE_VIDEOS
};

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const refreshFeedButton = document.querySelector("#refresh-feed-button");
const openSettingsButton = document.querySelector("#open-settings-button");
const closeSettingsButton = document.querySelector("#close-settings-button");
const settingsOverlay = document.querySelector("#settings-overlay");

const loadMoreButton = document.querySelector("#load-more-button");
const loadMoreStatus = document.querySelector("#load-more-status");
const feedStats = document.querySelector("#feed-stats");
const feedError = document.querySelector("#feed-error");
const feedList = document.querySelector("#feed-list");
const feedEmpty = document.querySelector("#feed-empty");
const channelCount = document.querySelector("#channel-count");

const googleImportButton = document.querySelector("#google-import-button");
const googleStatus = document.querySelector("#google-status");
const opmlInput = document.querySelector("#opml-input");
const opmlStatus = document.querySelector("#opml-status");

const playbackProvider = document.querySelector("#playback-provider");
const invidiousBase = document.querySelector("#invidious-base");
const showThumbnails = document.querySelector("#show-thumbnails");
const showShorts = document.querySelector("#show-shorts");

const subscriptionSearch = document.querySelector("#subscription-search");
const subscriptionList = document.querySelector("#subscription-list");
const subscriptionEmpty = document.querySelector("#subscription-empty");
const clearSubscriptionsButton = document.querySelector("#clear-subscriptions-button");

const state = {
    channels: [],
    videos: [],
    settings: { ...DEFAULT_SETTINGS },
    feedMeta: {
        lastUpdatedAt: null,
        failures: []
    },
    feedPager: {
        nextCursor: 0,
        hasMore: false,
        totalChannels: 0,
        loadedChannels: 0,
        isLoading: false
    },
    google: {
        tokenClient: null,
        pendingResolve: null,
        pendingReject: null,
        accessToken: ""
    },
    ui: {
        lastFocusedBeforeModal: null
    }
};

function readStorage(key, fallbackValue) {
    try {
        const rawValue = localStorage.getItem(key);
        if (!rawValue) {
            return fallbackValue;
        }
        return JSON.parse(rawValue);
    } catch {
        return fallbackValue;
    }
}

function writeStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function persistChannels() {
    writeStorage(STORAGE_KEYS.channels, state.channels);
}

function persistVideos() {
    writeStorage(STORAGE_KEYS.videos, state.videos);
}

function persistSettings() {
    writeStorage(STORAGE_KEYS.settings, state.settings);
}

function persistFeedMeta() {
    writeStorage(STORAGE_KEYS.feedMeta, state.feedMeta);
}

function resetFeedPager() {
    state.feedPager = {
        nextCursor: 0,
        hasMore: false,
        totalChannels: state.channels.length,
        loadedChannels: 0,
        isLoading: false
    };
}

function hydrateState() {
    state.channels = normalizeChannels(readStorage(STORAGE_KEYS.channels, []));
    state.videos = normalizeVideos(readStorage(STORAGE_KEYS.videos, []));
    state.settings = normalizeSettings(readStorage(STORAGE_KEYS.settings, {}));
    state.feedMeta = {
        lastUpdatedAt: null,
        failures: [],
        ...readStorage(STORAGE_KEYS.feedMeta, {})
    };
    resetFeedPager();
}

function getGoogleClientId() {
    const metaClientId = document.querySelector("meta[name='google-client-id']")?.content?.trim();
    if (APP_CONFIG.googleClientId && APP_CONFIG.googleClientId.trim()) {
        return APP_CONFIG.googleClientId.trim();
    }
    if (metaClientId) {
        return metaClientId;
    }
    return "";
}

function setStatus(target, message, tone) {
    target.textContent = message;
    target.classList.remove("status-success", "status-warning", "status-error");
    if (tone) {
        target.classList.add(`status-${tone}`);
    }
}

function setFeedError(message, tone) {
    if (!message) {
        feedError.textContent = "";
        feedError.classList.add("status-hidden");
        feedError.classList.remove("status-success", "status-warning", "status-error");
        return;
    }

    feedError.classList.remove("status-hidden", "status-success", "status-warning", "status-error");
    feedError.classList.add(`status-${tone || "warning"}`);
    feedError.textContent = message;
}

function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeInvidiousBase(value) {
    const trimmedValue = normalizeText(value);
    if (!trimmedValue) {
        return DEFAULT_SETTINGS.invidiousBase;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(trimmedValue.startsWith("http") ? trimmedValue : `https://${trimmedValue}`);
    } catch {
        return DEFAULT_SETTINGS.invidiousBase;
    }

    return parsedUrl.origin;
}

function clampInteger(value, fallback, min, max) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
}

function normalizeSettings(inputSettings) {
    const source = inputSettings && typeof inputSettings === "object" ? inputSettings : {};

    return {
        playbackProvider: source.playbackProvider === "invidious" ? "invidious" : "youtube",
        invidiousBase: normalizeInvidiousBase(source.invidiousBase),
        showThumbnails: Boolean(source.showThumbnails),
        showShorts: Boolean(source.showShorts),
        maxAgeDays: clampInteger(source.maxAgeDays, DEFAULT_SETTINGS.maxAgeDays, 1, 3650),
        maxVisibleVideos: clampInteger(source.maxVisibleVideos, DEFAULT_SETTINGS.maxVisibleVideos, 10, 1000)
    };
}

function extractChannelIdFromValue(value) {
    const normalizedValue = normalizeText(value).replace(/&amp;/g, "&");
    if (!normalizedValue) {
        return "";
    }

    if (CHANNEL_ID_PATTERN.test(normalizedValue)) {
        return normalizedValue;
    }

    const directMatch = normalizedValue.match(/channel_id=([a-zA-Z0-9_-]+)/i);
    if (directMatch && CHANNEL_ID_PATTERN.test(directMatch[1])) {
        return directMatch[1];
    }

    const pathMatch = normalizedValue.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
    if (pathMatch && CHANNEL_ID_PATTERN.test(pathMatch[1])) {
        return pathMatch[1];
    }

    try {
        const parsedUrl = new URL(normalizedValue);
        const channelId = parsedUrl.searchParams.get("channel_id") || parsedUrl.searchParams.get("channelId") || "";
        if (CHANNEL_ID_PATTERN.test(channelId)) {
            return channelId;
        }
    } catch {
        return "";
    }

    return "";
}

function normalizeChannel(inputChannel) {
    const channelId = extractChannelIdFromValue(inputChannel.channelId || inputChannel.xmlUrl || inputChannel.htmlUrl || "");
    if (!CHANNEL_ID_PATTERN.test(channelId)) {
        return null;
    }

    const title = normalizeText(inputChannel.title || inputChannel.text || `Channel ${channelId.slice(-6)}`);
    const xmlUrl = normalizeText(inputChannel.xmlUrl || `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const htmlUrl = normalizeText(inputChannel.htmlUrl || `https://www.youtube.com/channel/${channelId}`);
    const source = normalizeText(inputChannel.source || "manual") || "manual";
    const sourceTags = Array.isArray(inputChannel.sourceTags) ? inputChannel.sourceTags : [source];

    return {
        channelId,
        title,
        xmlUrl,
        htmlUrl,
        sourceTags: Array.from(new Set(sourceTags.map((tag) => normalizeText(tag)).filter(Boolean))).sort()
    };
}

function normalizeChannels(channels) {
    if (!Array.isArray(channels)) {
        return [];
    }

    const uniqueChannels = new Map();

    channels.forEach((channel) => {
        const normalized = normalizeChannel(channel);
        if (!normalized) {
            return;
        }

        if (!uniqueChannels.has(normalized.channelId)) {
            uniqueChannels.set(normalized.channelId, normalized);
            return;
        }

        const existing = uniqueChannels.get(normalized.channelId);
        const mergedTags = Array.from(new Set([...(existing.sourceTags || []), ...(normalized.sourceTags || [])])).sort();
        uniqueChannels.set(normalized.channelId, {
            ...existing,
            title: existing.title.startsWith("Channel ") && !normalized.title.startsWith("Channel ") ? normalized.title : existing.title,
            xmlUrl: existing.xmlUrl || normalized.xmlUrl,
            htmlUrl: existing.htmlUrl || normalized.htmlUrl,
            sourceTags: mergedTags
        });
    });

    return Array.from(uniqueChannels.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function normalizeVideo(video) {
    const videoId = normalizeText(video.videoId);
    if (!videoId) {
        return null;
    }

    const channelId = extractChannelIdFromValue(video.channelId || "");
    const youtubeUrl = normalizeText(video.youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`);
    const alternateUrl = normalizeText(video.alternateUrl || youtubeUrl);

    return {
        videoId,
        title: normalizeText(video.title || "Untitled video"),
        channelId,
        channelTitle: normalizeText(video.channelTitle || "Unknown channel"),
        publishedAt: normalizeText(video.publishedAt || ""),
        thumbnailUrl: normalizeText(video.thumbnailUrl || ""),
        youtubeUrl,
        alternateUrl,
        isShort: Boolean(video.isShort) || SHORTS_URL_PATTERN.test(youtubeUrl) || SHORTS_URL_PATTERN.test(alternateUrl)
    };
}

function normalizeVideos(videos) {
    if (!Array.isArray(videos)) {
        return [];
    }

    const normalizedVideos = videos.map(normalizeVideo).filter(Boolean);
    const uniqueVideos = new Map();

    normalizedVideos.forEach((video) => {
        if (!uniqueVideos.has(video.videoId)) {
            uniqueVideos.set(video.videoId, video);
            return;
        }

        const previousVideo = uniqueVideos.get(video.videoId);
        const previousTime = Date.parse(previousVideo.publishedAt || "") || 0;
        const nextTime = Date.parse(video.publishedAt || "") || 0;
        if (nextTime > previousTime) {
            uniqueVideos.set(video.videoId, video);
        }
    });

    return Array.from(uniqueVideos.values()).sort((a, b) => {
        const first = Date.parse(a.publishedAt || "") || 0;
        const second = Date.parse(b.publishedAt || "") || 0;
        return second - first;
    });
}

function isLikelyShort(video) {
    if (video.isShort) {
        return true;
    }

    if (SHORTS_URL_PATTERN.test(video.youtubeUrl || "") || SHORTS_URL_PATTERN.test(video.alternateUrl || "")) {
        return true;
    }

    return SHORTS_PATTERN.test(video.title || "");
}

function isWithinMaxAge(video, maxAgeDays) {
    if (!maxAgeDays || maxAgeDays <= 0) {
        return true;
    }

    const publishedAtMs = Date.parse(video.publishedAt || "");
    if (!publishedAtMs) {
        return false;
    }

    const ageMs = Date.now() - publishedAtMs;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    return ageMs <= maxAgeMs;
}

function mergeChannels(incomingChannels) {
    const nextChannels = normalizeChannels([...(state.channels || []), ...(incomingChannels || [])]);
    const before = new Set(state.channels.map((channel) => channel.channelId));
    const after = new Set(nextChannels.map((channel) => channel.channelId));

    state.channels = nextChannels;
    persistChannels();

    let addedCount = 0;
    after.forEach((channelId) => {
        if (!before.has(channelId)) {
            addedCount += 1;
        }
    });

    resetFeedPager();

    return {
        addedCount,
        totalCount: state.channels.length
    };
}

function parseOpmlChannels(opmlText) {
    const parsed = new DOMParser().parseFromString(opmlText, "application/xml");
    if (parsed.querySelector("parsererror")) {
        throw new Error("Could not parse OPML file.");
    }

    const allOutlines = Array.from(parsed.querySelectorAll("outline"));
    const extractedChannels = [];
    const skippedItems = [];

    allOutlines.forEach((outline) => {
        const xmlUrl = outline.getAttribute("xmlUrl") || outline.getAttribute("xmlurl") || "";
        const htmlUrl = outline.getAttribute("htmlUrl") || outline.getAttribute("htmlurl") || "";
        if (!xmlUrl && !htmlUrl) {
            return;
        }

        const channelId = extractChannelIdFromValue(xmlUrl) || extractChannelIdFromValue(htmlUrl);
        const title = outline.getAttribute("title") || outline.getAttribute("text") || "";

        if (!CHANNEL_ID_PATTERN.test(channelId)) {
            skippedItems.push({ xmlUrl, htmlUrl, title });
            return;
        }

        extractedChannels.push({
            channelId,
            title,
            xmlUrl,
            htmlUrl,
            source: "opml",
            sourceTags: ["opml"]
        });
    });

    return {
        channels: normalizeChannels(extractedChannels),
        skippedItems
    };
}

function ensureGoogleClient() {
    if (state.google.tokenClient) {
        return state.google.tokenClient;
    }

    const googleClientId = getGoogleClientId();
    if (!googleClientId) {
        throw new Error("Set a Google client id in the head meta tag google-client-id before using Google import.");
    }

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
        throw new Error("Google OAuth script did not load yet. Try again in a moment.");
    }

    state.google.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: googleClientId,
        scope: GOOGLE_SCOPE,
        callback: (response) => {
            if (!response || response.error || !response.access_token) {
                if (state.google.pendingReject) {
                    state.google.pendingReject(new Error(response?.error_description || response?.error || "Google authentication failed."));
                }
            } else if (state.google.pendingResolve) {
                state.google.accessToken = response.access_token;
                state.google.pendingResolve(response.access_token);
            }
            state.google.pendingResolve = null;
            state.google.pendingReject = null;
        }
    });

    return state.google.tokenClient;
}

function requestGoogleToken() {
    const tokenClient = ensureGoogleClient();

    return new Promise((resolve, reject) => {
        state.google.pendingResolve = resolve;
        state.google.pendingReject = reject;
        tokenClient.requestAccessToken({
            prompt: state.google.accessToken ? "" : "consent"
        });
    });
}

async function fetchGoogleSubscriptions(accessToken) {
    const channels = [];
    let pageToken = "";
    let pageCount = 0;

    do {
        const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
        endpoint.searchParams.set("part", "snippet");
        endpoint.searchParams.set("mine", "true");
        endpoint.searchParams.set("maxResults", "50");
        if (pageToken) {
            endpoint.searchParams.set("pageToken", pageToken);
        }

        const response = await fetch(endpoint, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload?.error?.message || "Failed to fetch subscriptions from YouTube API.");
        }

        const items = Array.isArray(payload.items) ? payload.items : [];
        items.forEach((item) => {
            const channelId = item?.snippet?.resourceId?.channelId || "";
            const title = item?.snippet?.title || "";
            const htmlUrl = channelId ? `https://www.youtube.com/channel/${channelId}` : "";
            const xmlUrl = channelId ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` : "";
            channels.push({
                channelId,
                title,
                htmlUrl,
                xmlUrl,
                source: "google",
                sourceTags: ["google"]
            });
        });

        pageToken = payload.nextPageToken || "";
        pageCount += 1;
    } while (pageToken && pageCount < 100);

    return normalizeChannels(channels);
}

function formatDateLabel(isoDate) {
    if (!isoDate) {
        return "Unknown date";
    }

    const parsedDate = new Date(isoDate);
    if (Number.isNaN(parsedDate.getTime())) {
        return "Unknown date";
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(parsedDate);
}

function getPlaybackUrl(video) {
    if (state.settings.playbackProvider === "invidious") {
        const baseUrl = normalizeInvidiousBase(state.settings.invidiousBase);
        return `${baseUrl}/watch?v=${encodeURIComponent(video.videoId)}`;
    }
    return video.youtubeUrl;
}

function getAlternatePlaybackUrl(video) {
    if (state.settings.playbackProvider === "invidious") {
        return video.youtubeUrl;
    }
    const baseUrl = normalizeInvidiousBase(state.settings.invidiousBase);
    return `${baseUrl}/watch?v=${encodeURIComponent(video.videoId)}`;
}

function openSettingsModal() {
    state.ui.lastFocusedBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : openSettingsButton;

    settingsOverlay.hidden = false;
    settingsOverlay.removeAttribute("inert");
    settingsOverlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    requestAnimationFrame(() => {
        closeSettingsButton.focus({ preventScroll: true });
    });
}

function closeSettingsModal() {
    const focusTarget = state.ui.lastFocusedBeforeModal && document.contains(state.ui.lastFocusedBeforeModal)
        ? state.ui.lastFocusedBeforeModal
        : openSettingsButton;

    if (settingsOverlay.contains(document.activeElement)) {
        focusTarget.focus({ preventScroll: true });
    }

    settingsOverlay.setAttribute("inert", "");
    settingsOverlay.setAttribute("aria-hidden", "true");
    settingsOverlay.hidden = true;
    document.body.classList.remove("modal-open");

    state.ui.lastFocusedBeforeModal = null;
}

function updateChannelCount() {
    const count = state.channels.length;
    channelCount.textContent = `${count} subscription${count === 1 ? "" : "s"} loaded.`;
}

function renderSubscriptionManager() {
    const query = normalizeText(subscriptionSearch.value).toLowerCase();
    const filteredChannels = state.channels.filter((channel) => {
        if (!query) {
            return true;
        }
        return channel.title.toLowerCase().includes(query);
    });

    subscriptionList.innerHTML = "";

    filteredChannels.forEach((channel) => {
        const item = document.createElement("li");
        item.className = "subscription-item";

        const meta = document.createElement("div");
        meta.className = "subscription-meta";

        const name = document.createElement("p");
        name.className = "subscription-name";
        name.textContent = channel.title;

        const source = document.createElement("p");
        source.className = "subscription-source";
        source.textContent = channel.sourceTags.join(" + ");

        meta.append(name, source);

        const removeButton = document.createElement("button");
        removeButton.className = "remove-channel-button";
        removeButton.type = "button";
        removeButton.dataset.removeChannel = "1";
        removeButton.dataset.channelId = channel.channelId;
        removeButton.textContent = "Remove";

        item.append(meta, removeButton);
        subscriptionList.append(item);
    });

    subscriptionEmpty.style.display = filteredChannels.length ? "none" : "block";
}

function getVisibleFeedState() {
    const channelIds = new Set(state.channels.map((channel) => channel.channelId));
    const visibleVideos = [];
    const hiddenCounts = {
        missingChannel: 0,
        shorts: 0,
        age: 0,
        cap: 0
    };

    state.videos.forEach((video) => {
        const hasChannel = !channelIds.size || channelIds.has(video.channelId);
        if (!hasChannel) {
            hiddenCounts.missingChannel += 1;
            return;
        }

        if (!state.settings.showShorts && isLikelyShort(video)) {
            hiddenCounts.shorts += 1;
            return;
        }

        if (!isWithinMaxAge(video, state.settings.maxAgeDays)) {
            hiddenCounts.age += 1;
            return;
        }

        if (visibleVideos.length >= state.settings.maxVisibleVideos) {
            hiddenCounts.cap += 1;
            return;
        }

        visibleVideos.push(video);
    });

    return {
        visibleVideos,
        hiddenCounts
    };
}

function renderFeedStats(visibleVideos, hiddenCounts) {
    const lastUpdated = state.feedMeta.lastUpdatedAt ? formatDateLabel(state.feedMeta.lastUpdatedAt) : "never";
    const hiddenSummaryParts = [];

    if (!state.settings.showShorts && hiddenCounts.shorts > 0) {
        hiddenSummaryParts.push(`${hiddenCounts.shorts} shorts hidden`);
    }
    if (hiddenCounts.age > 0) {
        hiddenSummaryParts.push(`${hiddenCounts.age} older than ${state.settings.maxAgeDays} days`);
    }
    if (hiddenCounts.cap > 0) {
        hiddenSummaryParts.push(`${hiddenCounts.cap} beyond ${state.settings.maxVisibleVideos}-item cap`);
    }

    const hiddenSummary = hiddenSummaryParts.length ? ` Hidden: ${hiddenSummaryParts.join(", ")}.` : "";
    feedStats.textContent = `${visibleVideos.length} videos shown. ${state.videos.length} loaded. Last refresh: ${lastUpdated}.${hiddenSummary}`;
}

function renderFeed() {
    const { visibleVideos, hiddenCounts } = getVisibleFeedState();
    feedList.innerHTML = "";

    if (!visibleVideos.length) {
        feedEmpty.style.display = "block";
    } else {
        feedEmpty.style.display = "none";
    }

    visibleVideos.forEach((video) => {
        const item = document.createElement("li");
        item.className = `feed-item${state.settings.showThumbnails && video.thumbnailUrl ? " with-thumbnail" : ""}`;

        if (state.settings.showThumbnails && video.thumbnailUrl) {
            const thumbnail = document.createElement("img");
            thumbnail.className = "feed-thumbnail";
            thumbnail.src = video.thumbnailUrl;
            thumbnail.alt = `Thumbnail for ${video.title}`;
            thumbnail.loading = "lazy";
            thumbnail.decoding = "async";
            item.append(thumbnail);
        }

        const body = document.createElement("article");
        body.className = "feed-body";

        const title = document.createElement("a");
        title.className = "feed-title";
        title.href = getPlaybackUrl(video);
        title.target = "_blank";
        title.rel = "noopener noreferrer";
        title.textContent = video.title;

        const meta = document.createElement("p");
        meta.className = "feed-meta";
        meta.textContent = `${video.channelTitle} | ${formatDateLabel(video.publishedAt)}`;

        const actions = document.createElement("div");
        actions.className = "feed-actions";

        const primaryLink = document.createElement("a");
        primaryLink.className = "feed-link";
        primaryLink.href = getPlaybackUrl(video);
        primaryLink.target = "_blank";
        primaryLink.rel = "noopener noreferrer";
        primaryLink.textContent = state.settings.playbackProvider === "youtube" ? "Open On YouTube" : "Open On Invidious";

        const alternateLink = document.createElement("a");
        alternateLink.className = "feed-link";
        alternateLink.href = getAlternatePlaybackUrl(video);
        alternateLink.target = "_blank";
        alternateLink.rel = "noopener noreferrer";
        alternateLink.textContent = state.settings.playbackProvider === "youtube" ? "Open On Invidious" : "Open On YouTube";

        actions.append(primaryLink, alternateLink);
        body.append(title, meta, actions);
        item.append(body);
        feedList.append(item);
    });

    renderFeedStats(visibleVideos, hiddenCounts);
}

function updateLoadMoreUI() {
    const hasChannels = state.channels.length > 0;

    loadMoreButton.style.display = hasChannels ? "inline-flex" : "none";
    if (!hasChannels) {
        loadMoreButton.disabled = true;
        loadMoreStatus.textContent = "Import channels from Settings to begin.";
        return;
    }

    if (state.feedPager.isLoading) {
        loadMoreButton.disabled = true;
        loadMoreStatus.textContent = "Fetching the next batch...";
        return;
    }

    const totalChannels = state.feedPager.totalChannels || state.channels.length;
    const loadedChannels = Math.min(state.feedPager.loadedChannels || 0, totalChannels);

    if (loadedChannels === 0 && !state.videos.length) {
        loadMoreButton.disabled = true;
        loadMoreStatus.textContent = "Refresh to start loading in batches.";
        return;
    }

    if (state.feedPager.hasMore) {
        loadMoreButton.disabled = false;
        loadMoreButton.textContent = "Load More Channels";
        loadMoreStatus.textContent = `${loadedChannels}/${totalChannels} channels loaded in this refresh.`;
        return;
    }

    loadMoreButton.disabled = true;
    loadMoreButton.textContent = "All Channels Loaded";
    if (loadedChannels === 0 && state.videos.length) {
        loadMoreStatus.textContent = "Showing cached feed snapshot. Refresh for live data.";
    } else {
        loadMoreStatus.textContent = `Loaded all ${totalChannels} channels for this refresh.`;
    }
}

function setRefreshState(isLoading) {
    refreshFeedButton.disabled = isLoading;
    refreshFeedButton.textContent = isLoading ? "Refreshing..." : "Refresh Feed";
}

async function fetchFeedBatch(reset) {
    if (!state.channels.length) {
        setFeedError("Import subscriptions in Settings first, then refresh the feed.", "warning");
        return;
    }

    if (state.feedPager.isLoading) {
        return;
    }

    if (reset) {
        state.videos = [];
        state.feedMeta.failures = [];
        persistVideos();
        persistFeedMeta();
        resetFeedPager();
        renderFeed();
        setFeedError("");
    }

    const cursor = reset ? 0 : state.feedPager.nextCursor;

    state.feedPager.isLoading = true;
    setRefreshState(true);
    updateLoadMoreUI();

    try {
        const response = await fetch("/api/feed", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                channelIds: state.channels.map((channel) => channel.channelId),
                limitPerChannel: FEED_LIMIT_PER_CHANNEL,
                cursor,
                batchSize: FEED_CHANNEL_BATCH_SIZE
            })
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload?.error || "Could not fetch feed batch.");
        }

        const incomingVideos = normalizeVideos(payload.videos || []);
        state.videos = normalizeVideos(reset ? incomingVideos : [...state.videos, ...incomingVideos]);

        const totalChannels = Number(payload.totalChannels);
        const nextCursor = Number(payload.nextCursor);
        const loadedChannels = Number(payload.loadedChannels);

        state.feedPager.totalChannels = Number.isFinite(totalChannels) && totalChannels >= 0 ? totalChannels : state.channels.length;
        state.feedPager.nextCursor = Number.isFinite(nextCursor) && nextCursor >= 0 ? nextCursor : state.feedPager.totalChannels;
        state.feedPager.loadedChannels = Number.isFinite(loadedChannels) && loadedChannels >= 0
            ? Math.min(loadedChannels, state.feedPager.totalChannels)
            : Math.min(state.feedPager.nextCursor, state.feedPager.totalChannels);
        state.feedPager.hasMore = Boolean(payload.hasMore);

        state.feedMeta.lastUpdatedAt = payload.generatedAt || new Date().toISOString();
        state.feedMeta.failures = Array.isArray(payload.failures) ? payload.failures : [];

        persistVideos();
        persistFeedMeta();

        renderFeed();

        if (state.feedMeta.failures.length) {
            setFeedError(`${state.feedMeta.failures.length} channels failed in this batch. Partial feed shown.`, "warning");
        } else {
            setFeedError("");
        }
    } catch (error) {
        setFeedError(error.message || "Feed refresh failed.", "error");
    } finally {
        state.feedPager.isLoading = false;
        setRefreshState(false);
        updateLoadMoreUI();
    }
}

async function refreshFeed() {
    await fetchFeedBatch(true);
}

async function loadMoreFeed() {
    if (!state.feedPager.hasMore || state.feedPager.isLoading) {
        return;
    }

    await fetchFeedBatch(false);
}

function removeChannel(channelId) {
    const targetChannel = state.channels.find((channel) => channel.channelId === channelId);
    if (!targetChannel) {
        return;
    }

    state.channels = state.channels.filter((channel) => channel.channelId !== channelId);
    state.videos = state.videos.filter((video) => video.channelId !== channelId);
    state.feedMeta.failures = [];

    persistChannels();
    persistVideos();
    persistFeedMeta();

    resetFeedPager();

    updateChannelCount();
    renderSubscriptionManager();
    renderFeed();
    updateLoadMoreUI();

    setFeedError(`Removed ${targetChannel.title}. Refresh feed to rebuild batch progress.`, "warning");
}

function clearAllSubscriptions() {
    const isConfirmed = window.confirm("Clear all imported channels and cached videos?");
    if (!isConfirmed) {
        return;
    }

    state.channels = [];
    state.videos = [];
    state.feedMeta = {
        lastUpdatedAt: null,
        failures: []
    };

    persistChannels();
    persistVideos();
    persistFeedMeta();

    resetFeedPager();

    updateChannelCount();
    renderSubscriptionManager();
    renderFeed();
    updateLoadMoreUI();

    setFeedError("");
    setStatus(googleStatus, "Google import is idle.");
    setStatus(opmlStatus, "OPML import is idle.");
}

async function handleGoogleImport() {
    googleImportButton.disabled = true;
    setStatus(googleStatus, "Authenticating with Google...", "warning");

    try {
        const accessToken = await requestGoogleToken();
        setStatus(googleStatus, "Fetching subscriptions from YouTube...", "warning");
        const importedChannels = await fetchGoogleSubscriptions(accessToken);

        if (!importedChannels.length) {
            setStatus(googleStatus, "No subscriptions found in this Google account.", "warning");
            return;
        }

        const result = mergeChannels(importedChannels);
        updateChannelCount();
        renderSubscriptionManager();
        renderFeed();
        updateLoadMoreUI();
        setStatus(googleStatus, `Imported ${result.addedCount} new channels. ${result.totalCount} total.`, "success");
        setFeedError("Subscriptions updated. Press Refresh Feed on the main page.", "warning");
    } catch (error) {
        setStatus(googleStatus, error.message || "Google import failed.", "error");
    } finally {
        googleImportButton.disabled = false;
    }
}

async function handleOpmlImport(event) {
    const file = event.target.files?.[0];
    if (!file) {
        return;
    }

    setStatus(opmlStatus, "Reading OPML file...", "warning");

    try {
        const opmlText = await file.text();
        const parsed = parseOpmlChannels(opmlText);

        if (!parsed.channels.length) {
            setStatus(opmlStatus, "No valid channel RSS entries found in this OPML file.", "error");
            return;
        }

        const result = mergeChannels(parsed.channels);

        updateChannelCount();
        renderSubscriptionManager();
        renderFeed();
        updateLoadMoreUI();

        if (parsed.skippedItems.length) {
            setStatus(opmlStatus, `Imported ${result.addedCount} new channels. Skipped ${parsed.skippedItems.length} invalid entries.`, "warning");
        } else {
            setStatus(opmlStatus, `Imported ${result.addedCount} new channels. ${result.totalCount} total.`, "success");
        }

        setFeedError("Subscriptions updated. Press Refresh Feed on the main page.", "warning");
    } catch (error) {
        setStatus(opmlStatus, error.message || "OPML import failed.", "error");
    } finally {
        event.target.value = "";
    }
}

function hydrateControls() {
    playbackProvider.value = state.settings.playbackProvider;
    invidiousBase.value = state.settings.invidiousBase;
    showThumbnails.checked = state.settings.showThumbnails;
    showShorts.checked = state.settings.showShorts;
}

function initializeGoogleStatus() {
    const hasConfiguredClientId = Boolean(getGoogleClientId());
    if (!hasConfiguredClientId) {
        setStatus(googleStatus, "Google client id not configured yet. Add it in meta[name=google-client-id].", "warning");
    } else {
        setStatus(googleStatus, "Google import is idle.");
    }
    setStatus(opmlStatus, "OPML import is idle.");
}

function attachEventListeners() {
    refreshFeedButton.addEventListener("click", refreshFeed);
    loadMoreButton.addEventListener("click", loadMoreFeed);

    openSettingsButton.addEventListener("click", openSettingsModal);
    closeSettingsButton.addEventListener("click", closeSettingsModal);

    settingsOverlay.addEventListener("click", (event) => {
        if (event.target === settingsOverlay) {
            closeSettingsModal();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !settingsOverlay.hidden) {
            closeSettingsModal();
        }
    });

    googleImportButton.addEventListener("click", handleGoogleImport);
    opmlInput.addEventListener("change", handleOpmlImport);

    playbackProvider.addEventListener("change", (event) => {
        state.settings.playbackProvider = event.target.value === "invidious" ? "invidious" : "youtube";
        persistSettings();
        renderFeed();
    });

    invidiousBase.addEventListener("change", (event) => {
        state.settings.invidiousBase = normalizeInvidiousBase(event.target.value);
        event.target.value = state.settings.invidiousBase;
        persistSettings();
        renderFeed();
    });

    showThumbnails.addEventListener("change", (event) => {
        state.settings.showThumbnails = Boolean(event.target.checked);
        persistSettings();
        renderFeed();
    });

    showShorts.addEventListener("change", (event) => {
        state.settings.showShorts = Boolean(event.target.checked);
        persistSettings();
        renderFeed();
    });

    subscriptionSearch.addEventListener("input", renderSubscriptionManager);

    subscriptionList.addEventListener("click", (event) => {
        const removeButton = event.target.closest("button[data-remove-channel]");
        if (!removeButton) {
            return;
        }
        removeChannel(removeButton.dataset.channelId || "");
    });

    clearSubscriptionsButton.addEventListener("click", clearAllSubscriptions);
}

function boot() {
    settingsOverlay.setAttribute("inert", "");
    settingsOverlay.setAttribute("aria-hidden", "true");
    settingsOverlay.hidden = true;

    hydrateState();
    hydrateControls();
    updateChannelCount();
    renderSubscriptionManager();
    renderFeed();
    updateLoadMoreUI();
    attachEventListeners();
    initializeGoogleStatus();

    if (!state.channels.length) {
        setFeedError("Open Settings to import subscriptions using Google or OPML.", "warning");
    }
}

boot();
