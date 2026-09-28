// ============================================================
// wrapper.js - محول موحد يدعم أولوية Showbox ثم Vixsrc كاحتياطي
// يعمل لكل من الأفلام والمسلسلات (season/episode) بنفس المسار.
//
// هذا هو الملف "النظامي" الوحيد: server.js يستدعيه عبر
//   require('../github/providers/wrapper')
// و require() في Node لا يحلّ أبداً إلى ملف .txt، لذلك أي نسخة
// أخرى بامتداد .txt (مثل wrapper_js.txt) غير مُحمّلة إطلاقاً في
// وقت التشغيل ويجب حذفها أو أرشفتها لتفادي الالتباس مستقبلاً.
// ============================================================

const path = require('path');

const PROVIDERS_DIR = __dirname;
const showboxModule = require(path.join(PROVIDERS_DIR, 'Showbox'));
const vixsrcModule = require(path.join(PROVIDERS_DIR, 'vixsrc'));

async function getResource(movieInfo, config, userCookie, callback) {
    try {
        const { tmdb_id, type, season, episode } = movieInfo || {};

        if (!tmdb_id) {
            console.error('[Wrapper] tmdb_id مفقود في movieInfo');
            return false;
        }

        const tmdbType = (type === 'movie' || type === '1') ? 'movie' : 'tv';
        const isSeries = tmdbType === 'tv';

        // مسلسل بدون season/episode صالحين = طلب غير مكتمل، لا داعي لمحاولة أي مزود.
        if (isSeries && (!Number.isInteger(season) || !Number.isInteger(episode))) {
            console.error(`[Wrapper] رقم الموسم/الحلقة غير صالح للمسلسل ${tmdb_id} (season=${season}, episode=${episode})`);
            return false;
        }

        const label = isSeries ? `tv/${tmdb_id} S${season}E${episode}` : `movie/${tmdb_id}`;

        // 1. محاولة استخدام Showbox أولاً (الأولوية الأولى)
        console.log(`[Wrapper] جاري محاولة Showbox لـ ${label}...`);
        try {
            const streams = await showboxModule.getStreamsFromTmdbId(
                tmdbType,
                tmdb_id,
                isSeries ? season : null,
                isSeries ? episode : null,
                'USA7',
                userCookie || null
            );

            if (streams && streams.length > 0) {
                const bestStream = streams[0];
                console.log(`[Wrapper] Showbox: تم العثور على رابط بنجاح لـ ${label}: ${bestStream.url}`);
                callback({
                    url: bestStream.url,
                    quality: bestStream.quality || 'auto',
                    headers: bestStream.headers || {},
                    subtitles: bestStream.subtitles || []
                });
                return true;
            }
            console.log(`[Wrapper] Showbox: لا يوجد روابط لـ ${label}, سيتم الانتقال للبديل.`);
        } catch (showboxErr) {
            console.warn(`[Wrapper] Showbox فشل لـ ${label}, سيتم الانتقال للبديل: ${showboxErr.message}`);
        }

        // 2. التحول إلى Vixsrc كاحتياطي (Fallback) إذا فشل Showbox أو لم يُرجع نتائج
        console.log(`[Wrapper] جاري محاولة Vixsrc (احتياطي) لـ ${label}...`);
        try {
            const vixResult = await vixsrcModule.getVixsrcStreams(
                tmdb_id,
                tmdbType,
                isSeries ? season : null,
                isSeries ? episode : null
            );

            if (vixResult && vixResult.streams && vixResult.streams.length > 0) {
                const bestStream = vixResult.streams[0];
                console.log(`[Wrapper] Vixsrc: تم العثور على رابط احتياطي لـ ${label}: ${bestStream.url}`);
                callback({
                    url: bestStream.url,
                    quality: bestStream.quality || 'auto',
                    headers: bestStream.headers || {},
                    subtitles: vixResult.subtitles || []
                });
                return true;
            }
        } catch (vixErr) {
            console.warn(`[Wrapper] Vixsrc فشل أيضاً لـ ${label}: ${vixErr.message}`);
        }

        console.log(`[Wrapper] عذراً، لم يتم العثور على أي روابط صالحة من كلا المزودين لـ ${label}.`);
        return false;

    } catch (error) {
        console.error('[Wrapper] خطأ عام في جلب الموارد:', error.message);
        return false;
    }
}

module.exports = { getResource };
