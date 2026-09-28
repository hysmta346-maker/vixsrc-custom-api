// ============================================================
// server.js - السيرفر المركزي لمنظومة Stream Master (مع دعم الإسبانية ومنع تكرار الأفلام)
// ============================================================

const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const wrapper = require('./github/providers/wrapper');

const app = express();
const PORT = process.env.PORT || 5000;
const DEFAULT_PLACEHOLDER_IMAGE = "https://images.placeholders.dev/?width=500&height=750&text=Stream+Master&theme=dark";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

app.use(cors());
app.use(express.json());

let db = null;

async function initDatabase() {
    try {
        const SQL = await initSqlJs();
        const filebuffer = fs.readFileSync('./movies.db');
        db = new SQL.Database(filebuffer);
        console.log('Connected to the SQLite database via sql.js (In-Memory).');
    } catch (err) {
        console.error('Error opening database with sql.js', err.message);
    }
}

initDatabase();

function getFebboxCookie() {
    try {
        const configPath = path.join(__dirname, 'github', 'providers', 'utils', 'user-config.json');
        if (fs.existsSync(configPath)) {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (configData.febboxCookies && Array.isArray(configData.febboxCookies) && configData.febboxCookies.length > 0) {
                return configData.febboxCookies[0];
            }
        }
    } catch (e) {
        console.error("Error reading user-config.json cookies:", e.message);
    }
    return null;
}

function queryAll(sql, params = []) {
    if (!db) return [];
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (e) {
        console.error("SQL Error:", e.message);
        return [];
    }
}

function queryGet(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

// ==========================================
// HELPERS & FORMATTING
// ==========================================
function fixImageUrl(poster, backdrop) {
    let rawImg = (poster && String(poster).trim() && !['none', 'null', '', 'false'].includes(String(poster).trim().toLowerCase())) ? poster : backdrop;
    if (!rawImg || ['none', 'null', '', 'false'].includes(String(rawImg).trim().toLowerCase())) {
        return DEFAULT_PLACEHOLDER_IMAGE;
    }
    rawImg = String(rawImg).trim();
    if (rawImg.startsWith("http://") || rawImg.startsWith("https://")) return rawImg;
    if (rawImg.startsWith("//")) return "https:" + rawImg;
    if (rawImg.startsWith("/")) return `https://image.tmdb.org/t/p/w500${rawImg}`;
    return `https://image.tmdb.org/t/p/w500/${rawImg}`;
}

function getLangField(m, fieldPrefix, lang) {
    lang = lang.toLowerCase();
    const targetKey = `${fieldPrefix}_${lang}`;
    
    if (m[targetKey] && String(m[targetKey]).trim() && !['none', 'null', ''].includes(String(m[targetKey]).trim().toLowerCase())) {
        return String(m[targetKey]).trim();
    }
    
    const fallbacks = lang === 'es' ? ['es', 'en', 'ar', 'local'] : (lang === 'en' ? ['en', 'ar', 'es', 'local'] : ['ar', 'en', 'es', 'local']);
    
    for (const l of fallbacks) {
        const altKey = `${fieldPrefix}_${l}`;
        if (m[altKey] && String(m[altKey]).trim() && !['none', 'null', ''].includes(String(m[altKey]).trim().toLowerCase())) {
            return String(m[altKey]).trim();
        }
    }
    
    for (const alt of ['original_title', 'title_local']) {
        if (m[alt] && String(m[alt]).trim() && !['none', 'null', ''].includes(String(m[alt]).trim().toLowerCase())) {
            return String(m[alt]).trim();
        }
    }
    return "Untitled";
}

function formatMovie(m, lang = "ar") {
    lang = lang.toLowerCase();
    const title = getLangField(m, "title", lang);
    const desc = getLangField(m, "overview", lang) || `Watch ${title} now in high quality on Stream Master.`;
    const genre = getLangField(m, "genre", lang) || "Action";

    let posterVal = null;
    if (lang === 'en') posterVal = m.poster_en || m.poster;
    else if (lang === 'es') posterVal = m.poster_es || m.poster;
    else posterVal = m.poster_ar || m.poster;

    if (!posterVal || ['none', 'null', '', 'false'].includes(String(posterVal).trim().toLowerCase())) {
        posterVal = m.backdrop || m.poster;
    }
    
    const imageUrl = fixImageUrl(posterVal, m.backdrop);
    
    return {
        id: m.id,
        tmdb_id: m.tmdb_id,
        title: title,
        name: title,
        image: imageUrl,
        poster: imageUrl,
        cover: imageUrl,
        description: desc,
        overview: desc,
        vid: String(m.tmdb_id || m.id),
        rating: String(m.rating || "7.5"),
        vote: m.vote_count || 0,
        year: String(m.year || "2025"),
        genre: genre,
        quality: m.quality || "1080p",
        language: m.language || lang.toUpperCase(),
        duration: `${m.runtime || 120} min`,
        media_type: m.media_type || "movie",
        slug: m.slug || ""
    };
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/config', (req, res) => {
    res.json({
        status: "success",
        server_url: `${req.protocol}://${req.get('host')}`,
        api_version: "13.1 (Anti-Duplicate & Multi-Language Engine)"
    });
});

app.get(['/api/banner', '/api/slider'], (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 10));
    const lang = (req.query.lang || "ar").toLowerCase();
    const offset = (page - 1) * limit;

    const rows = queryAll("SELECT * FROM movies ORDER BY rating DESC, id DESC LIMIT ? OFFSET ?", [limit, offset]);
    const results = (rows || []).map(r => formatMovie(r, lang));
    const countRow = queryGet("SELECT COUNT(id) as total FROM movies");
    
    res.json({ status: "success", page, limit, total: countRow ? countRow.total : 0, results, data: results });
});

// مسار التصنيفات مع ميزة استبعاد الأفیلم التي تم إرجاعها مسبقاً لمنع التكرار
app.get('/api/category', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 15));
    const offset = (page - 1) * limit;
    const lang = (req.query.lang || "ar").toLowerCase();
    const cat = (req.query.cat || req.query.category || "").trim().toLowerCase();
    const excludeIdsParam = (req.query.exclude || "").trim(); // استقبال الأيدياس المستبعدة لمنع التكرار

    let sql = "SELECT * FROM movies ORDER BY id DESC LIMIT ? OFFSET ?";
    let params = [limit, offset];

    let excludeIds = [];
    if (excludeIdsParam) {
        excludeIds = excludeIdsParam.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    }

    if (cat === 'trending') {
        sql = "SELECT * FROM movies ORDER BY vote_count DESC, rating DESC LIMIT ? OFFSET ?";
    } else if (cat && cat !== 'latest' && cat !== 'all') {
        const likePattern = `%${cat}%`;
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => '?').join(',');
            sql = `SELECT * FROM movies WHERE (LOWER(genre_ar) LIKE ? OR LOWER(genre_en) LIKE ? OR LOWER(genre_es) LIKE ?) AND id NOT IN (${placeholders}) ORDER BY id DESC LIMIT ? OFFSET ?`;
            params = [likePattern, likePattern, likePattern, ...excludeIds, limit, offset];
        } else {
            sql = "SELECT * FROM movies WHERE LOWER(genre_ar) LIKE ? OR LOWER(genre_en) LIKE ? OR LOWER(genre_es) LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?";
            params = [likePattern, likePattern, likePattern, limit, offset];
        }
    } else {
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => '?').join(',');
            sql = `SELECT * FROM movies WHERE id NOT IN (${placeholders}) ORDER BY id DESC LIMIT ? OFFSET ?`;
            params = [...excludeIds, limit, offset];
        }
    }

    const rows = queryAll(sql, params);
    const results = (rows || []).map(r => formatMovie(r, lang));
    const countRow = queryGet("SELECT COUNT(id) as total FROM movies");
    
    res.json({ status: "success", page, results, data: results, total: countRow ? countRow.total : 0 });
});

app.get(['/api/related', '/api/similar', '/api/recommendations', '/get_related'], (req, res) => {
    const movieId = req.query.id || req.query.vid || req.query.movie_id;
    const limit = Math.max(1, Math.min(30, parseInt(req.query.limit) || 10));
    const lang = (req.query.lang || "ar").toLowerCase();

    let rows = [];
    if (movieId) {
        const targetMovie = queryGet("SELECT * FROM movies WHERE id=? OR tmdb_id=? LIMIT 1", [movieId, movieId]);
        if (targetMovie) {
            const genre = targetMovie.genre_en || targetMovie.genre_ar || targetMovie.genre_es || '';
            const firstGenre = genre ? genre.split(',')[0].trim() : '';
            if (firstGenre) {
                const likePattern = `%${firstGenre}%`;
                rows = queryAll("SELECT * FROM movies WHERE tmdb_id != ? AND (genre_ar LIKE ? OR genre_en LIKE ? OR genre_es LIKE ?) ORDER BY RANDOM() LIMIT ?", [targetMovie.tmdb_id, likePattern, likePattern, likePattern, limit]);
            } else {
                rows = queryAll("SELECT * FROM movies WHERE tmdb_id != ? ORDER BY RANDOM() LIMIT ?", [targetMovie.tmdb_id, limit]);
            }
        } else {
            rows = queryAll("SELECT * FROM movies ORDER BY RANDOM() LIMIT ?", [limit]);
        }
    } else {
        rows = queryAll("SELECT * FROM movies ORDER BY RANDOM() LIMIT ?", [limit]);
    }

    const results = (rows || []).map(r => formatMovie(r, lang));
    res.json({ status: "success", results, data: results });
});

app.get('/api/search', (req, res) => {
    const query = (req.query.query || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const lang = (req.query.lang || "ar").toLowerCase();

    let rows = [];
    if (!query) {
        rows = queryAll("SELECT * FROM movies ORDER BY id DESC LIMIT ? OFFSET ?", [limit, offset]);
    } else {
        const likePattern = `%${query}%`;
        rows = queryAll("SELECT * FROM movies WHERE title_ar LIKE ? OR title_en LIKE ? OR title_es LIKE ? OR original_title LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?", [likePattern, likePattern, likePattern, likePattern, limit, offset]);
    }

    const results = (rows || []).map(r => formatMovie(r, lang));
    res.json({ status: "success", page, results, data: results });
});

app.get(['/api/stream', '/api/stream/:movie_id'], async (req, res) => {
    try {
        const vid = req.params.movie_id || req.query.vid || req.query.query || req.query.id;
        if (!vid) {
            return res.status(400).json({ status: "error", message: "معرّف الفيلم مطلوب" });
        }

        const row = queryGet("SELECT tmdb_id FROM movies WHERE id=? OR tmdb_id=? OR slug=? LIMIT 1", [vid, vid, vid]);
        const tmdbId = row ? row.tmdb_id : vid;
        const type = req.query.type || 'movie';
        const season = req.query.s ? parseInt(req.query.s) : null;
        const episode = req.query.e ? parseInt(req.query.e) : null;

        let finalStreamData = null;
        global.currentRequestUserCookie = getFebboxCookie();

        const movieInfo = { tmdb_id: tmdbId, type: type, season: season, episode: episode };
        
        await wrapper.getResource(movieInfo, {}, (streamResult) => {
            finalStreamData = streamResult;
        });

        if (!finalStreamData || !finalStreamData.url) {
            return res.status(404).json({ status: "error", message: "فشل استخراج رابط البث من جميع المزودين" });
        }

        let streamUrl = finalStreamData.url;
        let headers = finalStreamData.headers || {
            "Referer": "https://vixsrc.to/",
            "User-Agent": DEFAULT_USER_AGENT
        };
        let subtitles = finalStreamData.subtitles || [];
        let firstSubtitleUrl = subtitles.length > 0 ? (subtitles[0].url || subtitles[0].file) : null;

        res.json({
            status: "success",
            extracted_link: streamUrl,
            stream_url: streamUrl,
            streaming_url: streamUrl,
            subtitle_url: firstSubtitleUrl,
            subtitles: subtitles,
            headers: headers,
            data: {
                stream_url: streamUrl,
                subtitle_url: firstSubtitleUrl,
                subtitles: subtitles,
                headers: headers
            },
            message: "تم العثور على البث بنجاح"
        });

    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.listen(PORT, () => {
    console.log("==============================================================");
    console.log(`🚀 السيرفر يعمل بوزع أحمال جيت هب (GitHub Distributed Engine)`);
    console.log(`📍 الرابط: http://0.0.0.0:${PORT}`);
    console.log("==============================================================");
});
