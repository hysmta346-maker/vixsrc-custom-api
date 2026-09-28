const axios = require('axios');

// استخدام النطاق الأساسي مع إمكانية التبديل الاحتياطي
const BASE_URL = 'https://vixsrc.to';
const FALLBACK_URL = 'https://vsembed.ru';

const VIXSRC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL
};

// Step 1: GET /api/movie/{id} or /api/tv/{id}/{s}/{e} → { src: "/embed/..." }
async function fetchApi(url) {
    try {
        const response = await axios.get(url, { headers: VIXSRC_HEADERS, timeout: 10000 });
        if (response.status !== 200 || !response.data) return null;
        return response.data;
    } catch (err) {
        // تجربة النطاق الاحتياطي في حال فشل الأساسي
        if (url.startsWith(BASE_URL)) {
            const altUrl = url.replace(BASE_URL, FALLBACK_URL);
            try {
                const altResponse = await axios.get(altUrl, { headers: { ...VIXSRC_HEADERS, Referer: FALLBACK_URL, Origin: FALLBACK_URL }, timeout: 10000 });
                if (altResponse.status === 200 && altResponse.data) return altResponse.data;
            } catch (_) {}
        }
        return null;
    }
}

// Step 2: GET Embed Page with Fallback support
async function fetchEmbedPage(suburl, currentBase = BASE_URL) {
    try {
        const response = await axios.get(currentBase + suburl, {
            headers: { ...VIXSRC_HEADERS, Referer: currentBase, Origin: currentBase, Accept: 'text/html,application/xhtml+xml,*/*' },
            timeout: 10000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        // محاولة عبر النطاق الاحتياطي إذا فشل الأول
        if (currentBase === BASE_URL) {
            return await fetchEmbedPage(suburl, FALLBACK_URL);
        }
        return null;
    }
}

// Step 3: Extract token, expires, playlist URL from embed HTML
function extractTokenData(html) {
    const tokenMatch = html.match(/token["']?\s*:\s*["']([^"']+)["']/i) || html.match(/token=([^&"']+)/);
    const expiresMatch = html.match(/expires["']?\s*:\s*["']([^"']+)["']/i) || html.match(/expires=([^&"']+)/);
    const playlistMatch = html.match(/url["']?\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) || html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/) || html.match(/url\s*:\s*["']([^"']+)/);

    const token = tokenMatch?.[1];
    const expires = expiresMatch?.[1];
    const playlist = playlistMatch?.[1];

    if (!token || !expires || !playlist) return null;

    // Reject expired tokens (with 60s grace period)
    if (parseInt(expires, 10) * 1000 - 60_000 < Date.now()) {
        console.log('[Vixsrc] Token is expired');
        return null;
    }

    return { token, expires, playlist };
}

// Step 4: Append token params to master URL
function buildMasterUrl(tokenData) {
    const { token, expires, playlist } = tokenData;
    const sep = playlist.includes('?') ? '&' : '?';
    return `${playlist}${sep}token=${token}&expires=${expires}&h=1`;
}

// Step 5: Fetch the master HLS playlist
async function fetchPlaylist(masterUrl, pageApiUrl) {
    try {
        const response = await axios.get(masterUrl, {
            headers: { ...VIXSRC_HEADERS, Referer: pageApiUrl },
            timeout: 10000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        return null;
    }
}

// دالة جديدة لاستخراج رابط vtt الحقيقي من ملف m3u8 الخاص بالترجمة
async function resolveSubtitleUrl(url, referer) {
    try {
        const res = await axios.get(url, {
            headers: {
                ...VIXSRC_HEADERS,
                Referer: referer
            },
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

// Step 6: Parse HLS manifest for quality variants, audio tracks, subtitles (تم تحويلها لـ async)
async function parsePlaylist(content, masterUrl, pageApiUrl) {
    const sources = [];
    const subtitles = [];
    const audioTracks = [];

    const lines = content.split('\n');

    // Audio tracks
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) continue;
        const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown';
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio';
        audioTracks.push({ language, label });
    }

    // Subtitles
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) continue;
        
        let url = line.match(/URI="([^"]+)"/)?.[1];
        if (!url) continue;
        
        if (url.startsWith('/')) {
            url = BASE_URL + url;
        }

        // جلب الرابط الحقيقي للترجمة
        const realUrl = await resolveSubtitleUrl(url, pageApiUrl);

        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Unknown';
        subtitles.push({ 
            url: realUrl, 
            label, 
            format: 'vtt' 
        });
    }

    // Quality variants — find the highest resolution
    const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g;
    let match;
    let bestResolution = 0;
    while ((match = variantRegex.exec(content)) !== null) {
        const res = parseInt(match[1], 10);
        if (res > bestResolution) bestResolution = res;
    }

    if (bestResolution === 0) {
        sources.push({
            name: `Vixsrc - Auto`,
            title: `Vixsrc - Auto`,
            url: masterUrl,
            quality: 'Auto',
            provider: 'Vixsrc',
            headers: { 'Referer': pageApiUrl, 'User-Agent': VIXSRC_HEADERS['User-Agent'] }
        });
        return { sources, subtitles };
    }

    sources.push({
        name: `Vixsrc - ${bestResolution}p`,
        title: `Vixsrc - ${bestResolution}p`,
        url: masterUrl,
        quality: `${bestResolution}p`,
        provider: 'Vixsrc',
        headers: {
            'Referer': pageApiUrl,
            'User-Agent': VIXSRC_HEADERS['User-Agent']
        }
    });

    return { sources, subtitles };
}

async function getVixsrcStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    let apiUrl;
    if (mediaType === 'movie') {
        apiUrl = `${BASE_URL}/api/movie/${tmdbId}`;
    } else {
        apiUrl = `${BASE_URL}/api/tv/${tmdbId}/${seasonNum}/${episodeNum}`;
    }

    console.log(`[Vixsrc] Step 1 - Calling API: ${apiUrl}`);
    let apiData = await fetchApi(apiUrl);
    
    if (!apiData || !apiData.src) {
        const altApiUrl = apiUrl.replace(BASE_URL, FALLBACK_URL);
        apiData = await fetchApi(altApiUrl);
    }

    if (!apiData || !apiData.src) {
        console.log('[Vixsrc] No src returned from API');
        return { streams: [], subtitles: [] };
    }

    const activeBase = apiData.src.startsWith('http') ? '' : BASE_URL;
    console.log(`[Vixsrc] Step 2 - Fetching embed page: ${activeBase}${apiData.src}`);

    const html = await fetchEmbedPage(apiData.src);
    if (!html) {
        console.log('[Vixsrc] Failed to fetch embed page');
        return { streams: [], subtitles: [] };
    }
    console.log(`[Vixsrc] Embed HTML length: ${html.length} characters`);

    const tokenData = extractTokenData(html);
    if (!tokenData) {
        console.log('[Vixsrc] Could not extract token/expires/playlist from embed HTML');
        return { streams: [], subtitles: [] };
    }

    const masterUrl = buildMasterUrl(tokenData);
    console.log(`[Vixsrc] Step 3 - Master URL: ${masterUrl}`);

    const playlistContent = await fetchPlaylist(masterUrl, apiUrl);
    if (!playlistContent) {
        console.log('[Vixsrc] Failed to fetch HLS playlist');
        return { streams: [], subtitles: [] };
    }

    // تم إضافة await هنا لأن parsePlaylist أصبحت async
    const { sources, subtitles } = await parsePlaylist(playlistContent, masterUrl, apiUrl);

    if (sources.length === 0) {
        console.log('[Vixsrc] No streams found in HLS playlist');
        return { streams: [], subtitles: [] };
    }

    console.log(`[Vixsrc] Successfully extracted ${sources.length} stream(s). Subtitles: ${subtitles.length}`);
    
    return {
        streams: sources,
        subtitles: subtitles
    };
}

module.exports = { getVixsrcStreams };
