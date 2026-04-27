const { logger } = require('../utils/logger');

const API_KEY = 'Btz-7cYq3';
const BETABOTZ_URL = 'https://api.betabotz.eu.org/api';
const FREE_API_URL = 'https://api.siputzx.my.id/api';

async function fetchJson(url) {
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (e) {
        logger.error(`[DOWNLOADER] Fetch failed: ${url} - ${e.message}`);
        throw e;
    }
}

/**
 * Multi-API Fallback Handler
 * @param {string} freeUrl - URL for free API
 * @param {string} btzEndpoint - Endpoint path for BetaBotz (without /api prefix)
 * @param {string} originalUrl - The media URL to download
 */
async function fallbackDownload(freeUrl, btzEndpoint, originalUrl) {
    // Try Free API first if provided
    if (freeUrl) {
        try {
            const json = await fetchJson(`${freeUrl}${encodeURIComponent(originalUrl)}`);
            if (json.status && (json.data || json.result)) {
                const data = json.data || json.result;
                const extractedUrl = data.dl || data.download || data.url || (Array.isArray(data.urls) ? data.urls[0].url : null);
                if (extractedUrl) {
                    return {
                        title: data.title || 'Downloaded Media',
                        url: extractedUrl
                    };
                }
            }
        } catch (e) {
            logger.warn(`[DOWNLOADER] Free API failed for ${btzEndpoint}, falling back to BetaBotz...`);
        }
    }

    // Fallback to BetaBotz
    const btzUrl = `${BETABOTZ_URL}${btzEndpoint}?url=${encodeURIComponent(originalUrl)}&apikey=${API_KEY}`;
    const json = await fetchJson(btzUrl);
    
    if (!json.status || !json.result) {
        let errorMsg = json.message || 'Unknown';
        const lowerMsg = errorMsg.toLowerCase();
        if (lowerMsg.includes('whitelist') || lowerMsg.includes('apikey') || lowerMsg.includes('api key') || lowerMsg.includes('betabotz') || lowerMsg.includes('limit')) {
            throw new Error('API Key Error: IP belum ke waitlist atau API Key belum terpasang.');
        }
        throw new Error(`Gagal mendownload dari server (Error: ${errorMsg})`);
    }

    const res = json.result;
    const finalUrl = res.mp3 || res.mp4 || res.dl || res.url || res.Normal_video || res.HD || (Array.isArray(res) ? res[0].url : null);
    
    if (!finalUrl) {
        throw new Error('Media tidak ditemukan di dalam respons server.');
    }

    return {
        title: res.title || 'Downloaded Media',
        // Handle various response structures from BetaBotz
        url: finalUrl,
        data: res // raw result just in case
    };
}

// ==========================================
// EXPORTED FUNCTIONS
// ==========================================

async function searchYouTube(query) {
    if (/^https?:\/\//i.test(query)) return query; // Sudah berupa URL
    
    try {
        const yts = require('yt-search');
        const r = await yts(query);
        if (r.videos && r.videos.length > 0) {
            return r.videos[0].url;
        }
    } catch (e) {
        logger.error('[YT SEARCH] Gagal mencari di YouTube (Lokal): ' + e.message);
    }
    
    // Jika yt-search gagal, coba API siputzx sebagai fallback pencarian
    try {
        const json = await fetchJson(`${FREE_API_URL}/s/youtube?query=${encodeURIComponent(query)}`);
        if (json.status && json.data && json.data.length > 0) {
            return json.data[0].url;
        }
    } catch (e) {
        logger.error('[YT SEARCH] Gagal mencari di Siputzx: ' + e.message);
    }
    
    throw new Error('Gagal menemukan video YouTube dari kata kunci pencarian tersebut.');
}

async function ytmp3(query) {
    const url = await searchYouTube(query);
    return await fallbackDownload(`${FREE_API_URL}/d/ytmp3?url=`, '/download/ytmp3', url);
}

async function ytmp4(query) {
    const url = await searchYouTube(query);
    return await fallbackDownload(`${FREE_API_URL}/d/ytmp4?url=`, '/download/ytmp4', url);
}

async function spotifyDl(url) {
    return await fallbackDownload(`${FREE_API_URL}/d/spotify?url=`, '/download/spotify', url);
}

async function spotifySearch(query) {
    try {
        const json = await fetchJson(`${FREE_API_URL}/s/spotify?query=${encodeURIComponent(query)}`);
        if (json.status && json.data && json.data.length > 0) return json.data;
    } catch (e) {}

    const json = await fetchJson(`${BETABOTZ_URL}/search/spotify?query=${encodeURIComponent(query)}&apikey=${API_KEY}`);
    if (!json.status || !json.result || !json.result.data) throw new Error('Tidak ditemukan');
    return json.result.data;
}

async function facebookDl(url) {
    return await fallbackDownload(`${FREE_API_URL}/d/facebook?url=`, '/download/fbdown', url);
}

async function igDl(url) {
    return await fallbackDownload(null, '/download/igdowloader', url);
}

async function tiktokDl(url) {
    return await fallbackDownload(null, '/download/tiktok', url);
}

async function twitterDl(url) {
    return await fallbackDownload(null, '/download/twitter', url);
}

async function threadsDl(url) {
    return await fallbackDownload(null, '/download/threads', url);
}

async function douyinDl(url) {
    return await fallbackDownload(null, '/download/douyin', url);
}

async function cocofunDl(url) {
    return await fallbackDownload(null, '/download/cocofun', url);
}

async function likeeDl(url) {
    return await fallbackDownload(null, '/download/likee', url);
}

async function gdriveDl(url) {
    return await fallbackDownload(null, '/download/gdrive', url);
}

async function tiktokSearch(query) {
    const json = await fetchJson(`${BETABOTZ_URL}/search/tiktoks?query=${encodeURIComponent(query)}&apikey=${API_KEY}`);
    if (!json.status || !json.result) throw new Error('Tidak ditemukan');
    return json.result; // usually returns array of results
}

async function getBuffer(url) {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

module.exports = {
    ytmp3,
    ytmp4,
    spotifyDl,
    spotifySearch,
    facebookDl,
    igDl,
    tiktokDl,
    twitterDl,
    threadsDl,
    douyinDl,
    cocofunDl,
    likeeDl,
    gdriveDl,
    tiktokSearch,
    getBuffer
};
