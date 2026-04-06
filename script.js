const APP_CONFIG = window.MINIMAL_SUBS_CONFIG || {};
const CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;
const STORAGE_KEYS = {
    channels: "minimalSubscriptions.channels",
    videos: "minimalSubscriptions.videos",
    settings: "minimalSubscriptions.settings",
    feedMeta: "minimalSubscriptions.feedMeta"
};
const DEFAULT_SETTINGS = {
    playbackProvider: "youtube",
    invidiousBase: "https://yewtu.be",
    showThumbnails: false
};
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const googleImportButton = document.querySelector("#google-import-button");
const googleStatus = document.querySelector("#google-status");
const opmlInput = document.querySelector("#opml-input");
const opmlStatus = document.querySelector("#opml-status");
const searchInput = document.querySelector("#search-input");
const channelFilter = document.querySelector("#channel-filter");
const playbackProvider = document.querySelector("#playback-provider");
const invidiousBase = document.querySelector("#invidious-base");
const showThumbnails = document.querySelector("#show-thumbnails");
const refreshFeedButton = document.querySelector("#refresh-feed-button");
const clearSubscriptionsButton = document.querySelector("#clear-subscriptions-button");
const channelCount = document.querySelector("#channel-count");
const channelList = document.querySelector("#channel-list");
const feedStats = document.querySelector("#feed-stats");
const feedError = document.querySelector("#feed-error");
const feedList = document.querySelector("#feed-list");
const feedEmpty = document.querySelector("#feed-empty");

const state = {
    channels: [],
    videos: [],
    settings: { ...DEFAULT_SETTINGS },
    filters: {
        query: "",
        channelId: ""
    },
    feedMeta: {
        lastUpdatedAt: null,
        failures: []
    },
    google: {
        tokenClient: null,
        pendingResolve: null,
        pendingReject: null,
        accessToken: ""
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

function hydrateState() {
    state.channels = normalizeChannels(readStorage(STORAGE_KEYS.channels, []));
    state.videos = normalizeVideos(readStorage(STORAGE_KEYS.videos, []));
    state.settings = {
        ...DEFAULT_SETTINGS,
        ...readStorage(STORAGE_KEYS.settings, {})
    };
    state.feedMeta = {
        lastUpdatedAt: null,
        failures: [],
        ...readStorage(STORAGE_KEYS.feedMeta, {})
    };
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
    return {
        videoId,
        title: normalizeText(video.title || "Untitled video"),
        channelId,
        channelTitle: normalizeText(video.channelTitle || "Unknown channel"),
        publishedAt: normalizeText(video.publishedAt || ""),
        thumbnailUrl: normalizeText(video.thumbnailUrl || ""),
        youtubeUrl: normalizeText(video.youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`)
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
        throw new Error("Set a Google client id in the meta tag google-client-id before using Google import.");
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

function updateChannelFilterOptions() {
    const previousValue = state.filters.channelId;
    channelFilter.innerHTML = "";

    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All Channels";
    channelFilter.append(allOption);

    state.channels.forEach((channel) => {
        const option = document.createElement("option");
        option.value = channel.channelId;
        option.textContent = channel.title;
        channelFilter.append(option);
    });

    channelFilter.value = previousValue;
}

function renderChannels() {
    channelCount.textContent = `${state.channels.length} channel${state.channels.length === 1 ? "" : "s"} loaded.`;
    channelList.innerHTML = "";

    if (!state.channels.length) {
        const item = document.createElement("li");
        item.className = "channel-item";
        item.textContent = "No subscriptions imported yet.";
        channelList.append(item);
        updateChannelFilterOptions();
        return;
    }

    state.channels.forEach((channel) => {
        const item = document.createElement("li");
        item.className = "channel-item";

        const title = document.createElement("span");
        title.textContent = channel.title;

        const source = document.createElement("span");
        source.textContent = channel.sourceTags.join(" + ");

        item.append(title, source);
        channelList.append(item);
    });

    updateChannelFilterOptions();
}

function getFilteredVideos() {
    const query = state.filters.query.toLowerCase().trim();
    const activeChannelId = state.filters.channelId;

    return state.videos.filter((video) => {
        const matchesQuery = !query || `${video.title} ${video.channelTitle}`.toLowerCase().includes(query);
        const matchesChannel = !activeChannelId || video.channelId === activeChannelId;
        return matchesQuery && matchesChannel;
    });
}

function renderFeed() {
    const filteredVideos = getFilteredVideos();
    feedList.innerHTML = "";

    if (!filteredVideos.length) {
        feedEmpty.style.display = "block";
    } else {
        feedEmpty.style.display = "none";
    }

    filteredVideos.forEach((video) => {
        const item = document.createElement("li");
        item.className = `feed-item${state.settings.showThumbnails && video.thumbnailUrl ? " with-thumbnail" : ""}`;

        if (state.settings.showThumbnails && video.thumbnailUrl) {
            const thumbnail = document.createElement("img");
            thumbnail.className = "feed-thumbnail";
            thumbnail.src = video.thumbnailUrl;
            thumbnail.alt = `Thumbnail for ${video.title}`;
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

    const totalVideos = state.videos.length;
    const filteredCount = filteredVideos.length;
    const lastUpdated = state.feedMeta.lastUpdatedAt ? formatDateLabel(state.feedMeta.lastUpdatedAt) : "never";

    feedStats.textContent = `${filteredCount} shown of ${totalVideos}. Last refresh: ${lastUpdated}.`;
}

function setRefreshState(isLoading) {
    refreshFeedButton.disabled = isLoading;
    refreshFeedButton.textContent = isLoading ? "Refreshing..." : "Refresh Feed";
}

async function fetchFeed() {
    if (!state.channels.length) {
        setFeedError("Import channels first, then refresh your feed.", "warning");
        return;
    }

    setRefreshState(true);
    setFeedError("");

    try {
        const response = await fetch("/api/feed", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                channelIds: state.channels.map((channel) => channel.channelId),
                limitPerChannel: 8
            })
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload?.error || "Could not fetch feed from API.");
        }

        state.videos = normalizeVideos(payload.videos || []);
        state.feedMeta = {
            lastUpdatedAt: payload.generatedAt || new Date().toISOString(),
            failures: Array.isArray(payload.failures) ? payload.failures : []
        };

        persistVideos();
        persistFeedMeta();
        renderFeed();

        if (state.feedMeta.failures.length) {
            setFeedError(`${state.feedMeta.failures.length} channels failed to load. Partial feed shown.`, "warning");
        } else {
            setFeedError("");
        }
    } catch (error) {
        setFeedError(error.message || "Feed refresh failed.", "error");
    } finally {
        setRefreshState(false);
    }
}

async function handleGoogleImport() {
    googleImportButton.disabled = true;
    setStatus(googleStatus, "Authenticating with Google...", "warning");

    try {
        const accessToken = await requestGoogleToken();
        setStatus(googleStatus, "Fetching subscriptions from YouTube...", "warning");
        const importedChannels = await fetchGoogleSubscriptions(accessToken);

        if (!importedChannels.length) {
            setStatus(googleStatus, "No subscriptions found in Google account.", "warning");
            return;
        }

        const result = mergeChannels(importedChannels);
        renderChannels();
        renderFeed();
        setStatus(googleStatus, `Imported ${result.addedCount} new channels. ${result.totalCount} total.`, "success");
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
        renderChannels();
        renderFeed();

        if (parsed.skippedItems.length) {
            setStatus(opmlStatus, `Imported ${result.addedCount} new channels. Skipped ${parsed.skippedItems.length} invalid entries.`, "warning");
        } else {
            setStatus(opmlStatus, `Imported ${result.addedCount} new channels. ${result.totalCount} total.`, "success");
        }
    } catch (error) {
        setStatus(opmlStatus, error.message || "OPML import failed.", "error");
    } finally {
        event.target.value = "";
    }
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

    state.filters.channelId = "";
    channelFilter.value = "";

    renderChannels();
    renderFeed();
    setFeedError("");
    setStatus(googleStatus, "Google import is idle.");
    setStatus(opmlStatus, "OPML import is idle.");
}

function hydrateControls() {
    playbackProvider.value = state.settings.playbackProvider;
    invidiousBase.value = state.settings.invidiousBase;
    showThumbnails.checked = state.settings.showThumbnails;

    searchInput.value = state.filters.query;
    channelFilter.value = state.filters.channelId;
}

function attachEventListeners() {
    googleImportButton.addEventListener("click", handleGoogleImport);
    opmlInput.addEventListener("change", handleOpmlImport);

    searchInput.addEventListener("input", (event) => {
        state.filters.query = normalizeText(event.target.value);
        renderFeed();
    });

    channelFilter.addEventListener("change", (event) => {
        state.filters.channelId = event.target.value;
        renderFeed();
    });

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

    refreshFeedButton.addEventListener("click", fetchFeed);
    clearSubscriptionsButton.addEventListener("click", clearAllSubscriptions);
}

function initializeGoogleStatus() {
    const hasConfiguredClientId = Boolean(getGoogleClientId());
    if (!hasConfiguredClientId) {
        setStatus(googleStatus, "Google client id is not configured yet. Add it in the head meta tag google-client-id.", "warning");
    } else {
        setStatus(googleStatus, "Google import is idle.");
    }
}

function boot() {
    hydrateState();
    renderChannels();
    renderFeed();
    hydrateControls();
    attachEventListeners();
    initializeGoogleStatus();
}

boot();
