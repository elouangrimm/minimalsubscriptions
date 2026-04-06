const CACHE_TTL_MS = 1000 * 60 * 20;
const REQUEST_TIMEOUT_MS = 9000;
const MAX_CHANNELS = 250;
const DEFAULT_LIMIT_PER_CHANNEL = 6;
const MAX_LIMIT_PER_CHANNEL = 15;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 60;
const CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;
const FEED_CACHE = new Map();

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function decodeXml(value) {
    return String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function extractTagValue(xmlBlock, tagName) {
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = xmlBlock.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)<\/${escapedTag}>`, "i"));
    return match ? decodeXml(match[1]) : "";
}

function extractThumbnailUrl(xmlBlock) {
    const thumbnailMatch = xmlBlock.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    return thumbnailMatch ? decodeXml(thumbnailMatch[1]) : "";
}

function extractAlternateVideoUrl(xmlBlock, videoId) {
    const alternateLinkMatch = xmlBlock.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"[^>]*\/?>/i)
        || xmlBlock.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"[^>]*\/?>/i);

    if (alternateLinkMatch) {
        return decodeXml(alternateLinkMatch[1]);
    }

    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

function extractChannelTitle(feedXml) {
    const feedTitle = extractTagValue(feedXml, "title");
    return decodeXml(feedTitle.replace(/^Uploads from\s+/i, ""));
}

function parseVideos(feedXml, expectedChannelId, limitPerChannel) {
    const channelTitle = extractChannelTitle(feedXml);
    const entries = Array.from(feedXml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi));

    return entries.slice(0, limitPerChannel).map((entryMatch) => {
        const entryBlock = entryMatch[1];
        const videoId = extractTagValue(entryBlock, "yt:videoId");
        const entryChannelId = extractTagValue(entryBlock, "yt:channelId") || expectedChannelId;
        const authorName = extractTagValue(entryBlock, "name");
        const title = extractTagValue(entryBlock, "title");
        const publishedAt = extractTagValue(entryBlock, "published") || extractTagValue(entryBlock, "updated");
        const thumbnailUrl = extractThumbnailUrl(entryBlock);
        const alternateUrl = extractAlternateVideoUrl(entryBlock, videoId);
        const youtubeUrl = alternateUrl || `https://www.youtube.com/watch?v=${videoId}`;
        const isShort = /youtube\.com\/shorts\//i.test(alternateUrl);

        return {
            videoId,
            channelId: entryChannelId,
            channelTitle: authorName || channelTitle || `Channel ${entryChannelId.slice(-6)}`,
            title,
            publishedAt,
            thumbnailUrl,
            youtubeUrl,
            alternateUrl,
            isShort
        };
    }).filter((video) => video.videoId);
}

async function fetchChannelFeedXml(channelId) {
    const now = Date.now();
    const cachedItem = FEED_CACHE.get(channelId);

    if (cachedItem && now - cachedItem.cachedAt < CACHE_TTL_MS) {
        return cachedItem.xml;
    }

    const targetUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(targetUrl, {
            signal: abortController.signal,
            headers: {
                Accept: "application/atom+xml,text/xml"
            }
        });

        if (!response.ok) {
            throw new Error(`Upstream status ${response.status}`);
        }

        const xml = await response.text();
        FEED_CACHE.set(channelId, {
            cachedAt: now,
            xml
        });

        return xml;
    } finally {
        clearTimeout(timer);
    }
}

function cleanupCache() {
    const now = Date.now();
    for (const [channelId, cacheItem] of FEED_CACHE.entries()) {
        if (now - cacheItem.cachedAt >= CACHE_TTL_MS) {
            FEED_CACHE.delete(channelId);
        }
    }
}

function parseBody(req) {
    if (!req.body) {
        return {};
    }

    if (typeof req.body === "string") {
        try {
            return JSON.parse(req.body);
        } catch {
            return {};
        }
    }

    return req.body;
}

function sanitizeRequest(inputBody) {
    const channelIds = Array.isArray(inputBody.channelIds) ? inputBody.channelIds : [];
    const uniqueChannels = Array.from(new Set(channelIds.map((value) => String(value || "").trim()))).filter((value) => CHANNEL_ID_PATTERN.test(value));

    const limitPerChannel = Number(inputBody.limitPerChannel);
    const sanitizedLimit = Number.isFinite(limitPerChannel)
        ? Math.max(1, Math.min(MAX_LIMIT_PER_CHANNEL, Math.floor(limitPerChannel)))
        : DEFAULT_LIMIT_PER_CHANNEL;

    const cursorValue = Number(inputBody.cursor);
    const sanitizedCursor = Number.isFinite(cursorValue) ? Math.max(0, Math.floor(cursorValue)) : 0;

    const batchValue = Number(inputBody.batchSize);
    const sanitizedBatchSize = Number.isFinite(batchValue)
        ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(batchValue)))
        : DEFAULT_BATCH_SIZE;

    return {
        channelIds: uniqueChannels.slice(0, MAX_CHANNELS),
        limitPerChannel: sanitizedLimit,
        cursor: sanitizedCursor,
        batchSize: sanitizedBatchSize
    };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function dedupeAndSort(videos) {
    const uniqueVideos = new Map();

    videos.forEach((video) => {
        if (!video.videoId) {
            return;
        }

        if (!uniqueVideos.has(video.videoId)) {
            uniqueVideos.set(video.videoId, video);
            return;
        }

        const previous = uniqueVideos.get(video.videoId);
        const previousTime = Date.parse(previous.publishedAt || "") || 0;
        const nextTime = Date.parse(video.publishedAt || "") || 0;

        if (nextTime > previousTime) {
            uniqueVideos.set(video.videoId, video);
        }
    });

    return Array.from(uniqueVideos.values()).sort((first, second) => {
        const firstTime = Date.parse(first.publishedAt || "") || 0;
        const secondTime = Date.parse(second.publishedAt || "") || 0;
        return secondTime - firstTime;
    });
}

module.exports = async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }

    if (req.method !== "POST") {
        res.status(405).json({
            error: "Method not allowed. Use POST."
        });
        return;
    }

    cleanupCache();

    const inputBody = parseBody(req);
    const { channelIds, limitPerChannel, cursor, batchSize } = sanitizeRequest(inputBody);

    if (!channelIds.length) {
        res.status(400).json({
            error: "No valid channel ids were provided."
        });
        return;
    }

    const totalChannels = channelIds.length;
    const boundedCursor = Math.min(cursor, totalChannels);
    const selectedChannelIds = channelIds.slice(boundedCursor, boundedCursor + batchSize);
    const nextCursor = Math.min(boundedCursor + selectedChannelIds.length, totalChannels);
    const hasMore = nextCursor < totalChannels;

    if (!selectedChannelIds.length) {
        res.status(200).json({
            generatedAt: new Date().toISOString(),
            cursor: boundedCursor,
            nextCursor,
            hasMore: false,
            totalChannels,
            loadedChannels: totalChannels,
            channelCount: 0,
            successCount: 0,
            failureCount: 0,
            failures: [],
            videos: []
        });
        return;
    }

    const failures = [];

    const channelResults = await mapWithConcurrency(selectedChannelIds, 8, async (channelId) => {
        try {
            const feedXml = await fetchChannelFeedXml(channelId);
            const videos = parseVideos(feedXml, channelId, limitPerChannel);
            return {
                channelId,
                videos
            };
        } catch (error) {
            failures.push({
                channelId,
                error: error?.message || "Failed to load channel feed"
            });
            return {
                channelId,
                videos: []
            };
        }
    });

    const videos = dedupeAndSort(channelResults.flatMap((result) => result.videos));

    res.status(200).json({
        generatedAt: new Date().toISOString(),
        cursor: boundedCursor,
        nextCursor,
        hasMore,
        totalChannels,
        loadedChannels: nextCursor,
        channelCount: selectedChannelIds.length,
        successCount: selectedChannelIds.length - failures.length,
        failureCount: failures.length,
        failures,
        videos
    });
};
