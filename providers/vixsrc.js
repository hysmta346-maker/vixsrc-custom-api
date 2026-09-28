const axios = require('axios');
const NodeCache = require('node-cache');

// ============================================================
// 1. الإعدادات العامة
// ============================================================

const BASE_URL = 'https://vixsrc.to';
const FALLBACK_URL = 'https://vsembed.ru';

const VIXSRC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL
};

// ============================================================
// 2. التخزين المؤقت (Cache)
// ============================================================

const cache = new NodeCache({ 
    stdTTL: 3600, 
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
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        throw error;
    }
}

// ============================================================
// 4. الدوال الأساسية (مع تحسينات)
// ============================================================

async function fetchApi(url) {
    try {
        const response = await fetchWithRetry(url, { 
            headers: VIXSRC_HEADERS, 
            timeout: 15000 
        });
        if (response.status !== 200 || !response.data) return null;
        return response.data;
    } catch (err) {
        if (url.startsWith(BASE_URL)) {
            const altUrl = url.replace(BASE_URL, FALLBACK_URL);
            try {
                const altResponse = await fetchWithRetry(altUrl, { 
                    headers: { ...VIXSRC_HEADERS, Referer: FALLBACK_URL, Origin: FALLBACK_URL }, 
                    timeout: 15000 
                });
                if (altResponse.status === 200 && altResponse.data) return altResponse.data;
            } catch (_) {}
        }
        return null;
    }
}

async function fetchEmbedPage(suburl, currentBase = BASE_URL) {
    try {
        const response = await fetchWithRetry(currentBase + suburl, {
            headers: { 
                ...VIXSRC_HEADERS, 
                Referer: currentBase, 
                Origin: currentBase, 
                Accept: 'text/html,application/xhtml+xml,*/*' 
            },
            timeout: 15000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        if (currentBase === BASE_URL) {
            return await fetchEmbedPage(suburl, FALLBACK_URL);
        }
        return null;
    }
}

function extractTokenData(html) {
    const tokenMatch = html.match(/token["']?\s*:\s*["']([^"']+)["']/i) || html.match(/token=([^&"']+)/);
    const expiresMatch = html.match(/expires["']?\s*:\s*["']([^"']+)["']/i) || html.match(/expires=([^&"']+)/);
    const playlistMatch = html.match(/url["']?\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) || 
                          html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/) || 
                          html.match(/url\s*:\s*["']([^"']+)/);

    const token = tokenMatch?.[1];
    const expires = expiresMatch?.[1];
    const playlist = playlistMatch?.[1];

    if (!token || !expires || !playlist) return null;

    if (parseInt(expires, 10) * 1000 - 60000 < Date.now()) {
        return null;
    }

    return { token, expires, playlist };
}

function buildMasterUrl(tokenData) {
    const { token, expires, playlist } = tokenData;
    const sep = playlist.includes('?') ? '&' : '?';
    return `${playlist}${sep}token=${token}&expires=${expires}&h=1`;
}

async function fetchPlaylist(masterUrl, pageApiUrl) {
    try {
        const response = await fetchWithRetry(masterUrl, {
            headers: { ...VIXSRC_HEADERS, Referer: pageApiUrl },
            timeout: 15000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        return null;
    }
}

async function resolveSubtitleUrl(url, referer) {
    try {
        const res = await fetchWithRetry(url, {
            headers: { ...VIXSRC_HEADERS, Referer: referer },
            responseType: 'text',
            timeout: 10000
        });

        const lines = res.data.split('\n');
        for (const line of lines) {
            if (line.startsWith('http') && line.includes('.vtt')) {
                return line.trim();
            }
        }
        return url;
    } catch (e) {
        return url;
    }
}

// ============================================================
// 5. تحليل الـ Playlist
// ============================================================

async function parsePlaylist(content, masterUrl, pageApiUrl) {
    const sources = [];
    const subtitles = [];
    const audioTracks = [];
    const lines = content.split('\n');

    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) continue;
        const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown';
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio';
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        
        let url = null;
        if (uri) {
            if (uri.startsWith('/')) {
                url = BASE_URL + uri;
            } else if (uri.startsWith('http')) {
                url = uri;
            } else {
                const basePath = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
                url = basePath + uri;
            }
        }
        
        audioTracks.push({ language, label, url, format: 'm3u8' });
    }

    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) continue;
        
        let url = line.match(/URI="([^"]+)"/)?.[1];
        if (!url) continue;
        
        if (url.startsWith('/')) {
            url = BASE_URL + url;
        }

        const realUrl = await resolveSubtitleUrl(url, pageApiUrl);
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Unknown';
        subtitles.push({ url: realUrl, label, format: 'vtt' });
    }

    const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g;
    let match;
    const variants = [];

    while ((match = variantRegex.exec(content)) !== null) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        variants.push({ width, height, resolution: `${height}p` });
    }

    variants.sort((a, b) => b.height - a.height);

    if (variants.length === 0) {
        sources.push({
            name: 'Vixsrc - Auto',
            title: 'Vixsrc - Auto',
            url: masterUrl,
            quality: 'Auto',
            provider: 'Vixsrc',
            headers: { 'Referer': pageApiUrl, 'User-Agent': VIXSRC_HEADERS['User-Agent'] }
        });
    } else {
        const best = variants[0];
        sources.push({
            name: `Vixsrc - ${best.resolution}`,
            title: `Vixsrc - ${best.resolution}`,
            url: masterUrl,
            quality: best.resolution,
            width: best.width,
            height: best.height,
            provider: 'Vixsrc',
            headers: { 'Referer': pageApiUrl, 'User-Agent': VIXSRC_HEADERS['User-Agent'] }
        });
    }

    return { sources, subtitles, audioTracks };
}

// ============================================================
// 6. الدالة الرئيسية
// ============================================================

async function getVixsrcStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const cacheKey = `${tmdbId}-${mediaType}-${seasonNum || ''}-${episodeNum || ''}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let apiUrl;
    if (mediaType === 'movie') {
        apiUrl = `${BASE_URL}/api/movie/${tmdbId}`;
    } else {
        apiUrl = `${BASE_URL}/api/tv/${tmdbId}/${seasonNum}/${episodeNum}`;
    }

    let apiData = await fetchApi(apiUrl);
    if (!apiData || !apiData.src) {
        const altApiUrl = apiUrl.replace(BASE_URL, FALLBACK_URL);
        apiData = await fetchApi(altApiUrl);
    }

    if (!apiData || !apiData.src) return { streams: [], subtitles: [] };

    const activeBase = apiData.src.startsWith('http') ? '' : BASE_URL;
    const html = await fetchEmbedPage(apiData.src);
    if (!html) return { streams: [], subtitles: [] };

    const tokenData = extractTokenData(html);
    if (!tokenData) return { streams: [], subtitles: [] };

    const masterUrl = buildMasterUrl(tokenData);
    const playlistContent = await fetchPlaylist(masterUrl, apiUrl);
    if (!playlistContent) return { streams: [], subtitles: [] };

    const { sources, subtitles, audioTracks } = await parsePlaylist(playlistContent, masterUrl, apiUrl);

    if (sources.length === 0) return { streams: [], subtitles: [] };

    const result = { streams: sources, subtitles, audioTracks };
    cache.set(cacheKey, result, 3600);

    return result;
}

module.exports = { getVixsrcStreams };
