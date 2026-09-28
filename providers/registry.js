const vixsrcModule = require('./vixsrc'); 
const showboxModule = require('./Showbox'); 

const providers = new Map();

// 1. تسجيل مزود Showbox
providers.set('showbox', {
    name: 'showbox',
    enabled: true,
    fetch: async (args) => {
        const { tmdbId, type, season, episode } = args;
        const tmdbType = (type === 'movie' || type === '1') ? 'movie' : 'tv';
        
        try {
            const directCookie = global.currentRequestUserCookie || (config && config.febboxCookies ? config.febboxCookies[0] : "");
            const region = 'USA7';

            const result = await showboxModule.getStreamsFromTmdbId(
                tmdbType, 
                tmdbId, 
                season, 
                episode, 
                region, 
                directCookie
            );
            
            let streams = [];
            if (Array.isArray(result)) streams = result;
            else if (result && result.streams) streams = result.streams;
            
            return streams.map(s => ({ ...s, source: 'showbox' }));
        } catch (error) {
            return [];
        }
    }
});

// 2. تسجيل مزود Vixsrc
providers.set('vixsrc', {
    name: 'vixsrc',
    enabled: true,
    fetch: async (args) => {
        const { tmdbId, type, season, episode } = args;
        const tmdbType = (type === 'movie' || type === '1') ? 'movie' : 'tv';
        
        try {
            const result = await vixsrcModule.getVixsrcStreams(tmdbId, tmdbType, season, episode);
            return result; // يرجع البنية الصحيحة { streams: [...], subtitles: [...] }
        } catch (error) {
            return { streams: [], subtitles: [] };
        }
    }
});

function listProviders() {
    return Array.from(providers.values()).map(p => ({
        name: p.name,
        enabled: p.enabled
    }));
}

function getProvider(name) {
    return providers.get(name);
}

function getCookieStats() {
    return {};
}

module.exports = {
    listProviders,
    getProvider,
    getCookieStats
};
