// test-subdl.js - أداة مستقلة لفحص سبب رفض SubDL
require('dotenv').config();

const SUBDL_API_KEY = process.env.SUBDL_API_KEY;
// ضع TMDB ID تجريبي هنا للتأكد (مثلاً فيلم Avatar أو غيره)
const TEST_TMDB_ID = 980431; 
const TEST_TYPE = 'movie';

async function testSubDl() {
    console.log('--------------------------------------------------');
    console.log('🧪 بدء فحص اتصال SubDL...');
    console.log(`🔑 المفتاح المستخدم: ${SUBDL_API_KEY ? SUBDL_API_KEY.substring(0, 6) + '...' : 'غير موجود!'}`);

    if (!SUBDL_API_KEY) {
        console.error('❌ خطأ: مفتاح SUBDL_API_KEY غير موجود في ملف .env');
        return;
    }

    const url = `https://api.subdl.com/api/v1/subtitles?api_key=${SUBDL_API_KEY}&tmdb_id=${TEST_TMDB_ID}&type=${TEST_TYPE}`;
    console.log(`🌐 الرابط المستهدف: ${url}`);

    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        console.log(`📡 حالة الرد (Status Code): ${response.status} ${response.statusText}`);
        
        // طباعة الـ Headers لمعرفة ما إذا كان هناك قيود أو حماية Cloudflare
        console.log('📋 الـ Headers الراجعة:');
        response.headers.forEach((val, key) => {
            console.log(`   ${key}: ${val}`);
        });

        const textBody = await response.text();
        console.log('📦 نص الاستجابة (Body):');
        console.log(textBody);

        try {
            const json = JSON.parse(textBody);
            if (json.status || json.subtitles) {
                console.log('✅ الاتصال ناجح والـ JSON سليم!');
            } else {
                console.log('⚠️ الـ API أرجع رد غير متوقع (قد يكون خطأ صلاحيات أو مفتاح).');
            }
        } catch (e) {
            console.log('❌ الاستجابة ليست بصيغة JSON (غالباً صفحة حظر Cloudflare أو HTML).');
        }

    } catch (error) {
        console.error('❌ حدث خطأ شبكة أثناء الاتصال:', error.message);
    }
    console.log('--------------------------------------------------');
}

testSubDl();
