const axios = require('axios');
const NodeCache = require('node-cache');

// ============================================================
// 1. الإعدادات العامة
// ============================================================

const BASE_URL = 'https://multiembed.mov';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL
};

// ============================================================
// 2. التخزين المؤقت (Cache)
// ============================================================

const cache = new NodeCache({ 
    stdTTL: 3600, // ساعة واحدة
    checkperiod: 600 
});

// ============================================================
// 3. دالة إعادة المحاولة (Retry) يدوية
// ============================================================

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    try {
        const response = await axios.get(url, options);
        return response;
    } catch (error) {
        if (retries > 0) {
            console.log(`[Superembed] ⏳ Retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ============================================================
// 4. جلب صفحة التضمين (Embed Page)
// ============================================================

async function fetchEmbedPage(tmdbId) {
    const embedUrl = `${BASE_URL}/?video_id=${tmdbId}`;
    console.log(`[Superembed] 🌐 Fetching embed page: ${embedUrl}`);
    
    try {
        const response = await fetchWithRetry(embedUrl, {
            headers: HEADERS,
            timeout: 15000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch (error) {
        console.log(`[Superembed] ❌ Failed to fetch embed page: ${error.message}`);
        return null;
    }
}

// ============================================================
// 5. استخراج Token, Expires, Playlist
// ============================================================

function extractTokenData(html) {
    // نفس الـ Regex المستخدم في vixsrc
    const tokenMatch = html.match(/token["']?\s*:\s*["']([^"']+)["']/i) || html.match(/token=([^&"']+)/);
    const expiresMatch = html.match(/expires["']?\s*:\s*["']([^"']+)["']/i) || html.match(/expires=([^&"']+)/);
    const playlistMatch = html.match(/url["']?\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) || 
                          html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/) || 
                          html.match(/url\s*:\s*["']([^"']+)/);

    const token = tokenMatch?.[1];
    const expires = expiresMatch?.[1];
    const playlist = playlistMatch?.[1];

    if (!token || !expires || !playlist) {
        console.log('[Superembed] ❌ Could not extract token/expires/playlist');
        return null;
    }

    // التحقق من صلاحية الـ token
    if (parseInt(expires, 10) * 1000 - 60000 < Date.now()) {
        console.log('[Superembed] ⚠️ Token is expired');
        return null;
    }

    return { token, expires, playlist };
}

// ============================================================
// 6. بناء رابط الـ Master
// ============================================================

function buildMasterUrl(tokenData) {
    const { token, expires, playlist } = tokenData;
    const sep = playlist.includes('?') ? '&' : '?';
    return `${playlist}${sep}token=${token}&expires=${expires}`;
}

// ============================================================
// 7. جلب الـ Playlist وتحليله
// ============================================================

async function fetchPlaylist(masterUrl) {
    try {
        const response = await fetchWithRetry(masterUrl, {
            headers: HEADERS,
            timeout: 15000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        return null;
    }
}

function parsePlaylist(content) {
    const sources = [];
    const lines = content.split('\n');

    // استخراج الدقات (Qualities)
    const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g;
    let match;
    const variants = [];

    while ((match = variantRegex.exec(content)) !== null) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        variants.push({ 
            width, 
            height, 
            resolution: `${height}p` 
        });
    }

    variants.sort((a, b) => b.height - a.height);

    if (variants.length === 0) {
        sources.push({
            name: 'Superembed - Auto',
            url: masterUrl,
            quality: 'Auto',
            provider: 'superembed',
            headers: HEADERS
        });
    } else {
        const best = variants[0];
        sources.push({
            name: `Superembed - ${best.resolution}`,
            url: masterUrl,
            quality: best.resolution,
            width: best.width,
            height: best.height,
            provider: 'superembed',
            headers: HEADERS
        });
    }

    return { streams: sources };
}

// ============================================================
// 8. الدالة الرئيسية (بنفس منطق vixsrc)
// ============================================================

async function getSuperembedStreams(tmdbId) {
    const cacheKey = `superembed-${tmdbId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[Superembed] ✅ Cache hit for ${tmdbId}`);
        return cached;
    }

    console.log(`[Superembed] 🔍 Fetching streams for TMDB ID: ${tmdbId}`);

    // الخطوة 1: جلب صفحة التضمين
    const html = await fetchEmbedPage(tmdbId);
    if (!html) {
        console.log('[Superembed] ❌ Failed to fetch embed page');
        return { streams: [], subtitles: [], audioTracks: [] };
    }

    // الخطوة 2: استخراج Token, Expires, Playlist
    const tokenData = extractTokenData(html);
    if (!tokenData) {
        console.log('[Superembed] ❌ Could not extract token/expires/playlist');
        return { streams: [], subtitles: [], audioTracks: [] };
    }

    // الخطوة 3: بناء رابط الـ Master
    const masterUrl = buildMasterUrl(tokenData);
    console.log(`[Superembed] 🔗 Master URL: ${masterUrl}`);

    // الخطوة 4: جلب الـ Playlist
    const playlistContent = await fetchPlaylist(masterUrl);
    if (!playlistContent) {
        console.log('[Superembed] ❌ Failed to fetch HLS playlist');
        return { streams: [], subtitles: [], audioTracks: [] };
    }

    // الخطوة 5: تحليل الـ Playlist
    const { streams } = parsePlaylist(playlistContent);

    if (streams.length === 0) {
        console.log('[Superembed] ❌ No streams found');
        return { streams: [], subtitles: [], audioTracks: [] };
    }

    console.log(`[Superembed] ✅ Successfully extracted ${streams.length} stream(s).`);
    console.log(`[Superembed] 🎬 Qualities: ${streams.map(s => s.quality).join(', ')}`);

    const result = {
        streams: streams,
        subtitles: [],
        audioTracks: []
    };

    cache.set(cacheKey, result, 3600);
    return result;
}

module.exports = { getSuperembedStreams };
