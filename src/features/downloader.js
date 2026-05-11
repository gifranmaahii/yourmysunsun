const { logger } = require('../utils/logger');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Path binary yt-dlp lokal di dalam folder bot
const _YTDLP_BIN = path.join(__dirname, '../../bin/yt-dlp');
let _ytdlpReady = false;

async function _ensureYtdlp() {
    if (_ytdlpReady) return;
    if (fs.existsSync(_YTDLP_BIN)) {
        // Pastikan executable
        try { fs.chmodSync(_YTDLP_BIN, 0o755); } catch(_) {}
        _ytdlpReady = true;
        logger.info('[yt-dlp] Binary found at ' + _YTDLP_BIN);
        return;
    }
    try {
        logger.info('[yt-dlp] Downloading binary...');
        const dir = path.dirname(_YTDLP_BIN);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(_YTDLP_BIN, buf);
        fs.chmodSync(_YTDLP_BIN, 0o755);
        _ytdlpReady = true;
        logger.info('[yt-dlp] Downloaded OK, size=' + buf.length);
    } catch(e) {
        logger.warn('[yt-dlp] Download failed: ' + e.message);
    }
}

function _ytdlp(args, timeout = 25000) {
    return new Promise((resolve, reject) => {
        // Urutan: binary lokal → yt-dlp system → python3 -m yt_dlp → python -m yt_dlp
        const cmds = [
            [_YTDLP_BIN, args],
            ['yt-dlp', args],
            ['python3', ['-m', 'yt_dlp', ...args]],
            ['python',  ['-m', 'yt_dlp', ...args]],
        ];
        let idx = 0;
        function tryNext() {
            if (idx >= cmds.length) return reject(new Error('yt-dlp not found'));
            const [cmd, a] = cmds[idx++];
            if (cmd === _YTDLP_BIN && !fs.existsSync(cmd)) return tryNext();
            execFile(cmd, a, { timeout }, (err, stdout, stderr) => {
                const out = (stdout || '').trim();
                if (out) return resolve(out);
                if (err) {
                    logger.warn('[yt-dlp] cmd=' + cmd + ' err=' + (err.message||'').substring(0,60));
                }
                tryNext();
            });
        }
        tryNext();
    });
}

async function ytdlpGetUrl(ytUrl, format = 'bestaudio/best') {
    await _ensureYtdlp();
    const out = await _ytdlp(['--get-url', '--format', format, '--no-playlist', ytUrl]);
    const line = out.split('\n')[0].trim();
    if (!line.startsWith('http')) throw new Error('No URL from yt-dlp');
    return line;
}

async function ytdlpGetTitle(ytUrl) {
    try {
        await _ensureYtdlp();
        return await _ytdlp(['--get-title', '--no-playlist', ytUrl]);
    } catch (_) { return 'YouTube Audio'; }
}

async function ytdlpDownloadMp3(ytUrl) {
    await _ensureYtdlp();
    const os = require('os');
    const outDir = os.tmpdir();
    const outTpl = path.join(outDir, 'ytdlp_%(id)s.%(ext)s');
    // Download audio terbaik, convert ke mp3
    await _ytdlp([
        '--no-playlist',
        '--format', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '128K',
        '--output', outTpl,
        '--no-warnings',
        ytUrl
    ], 60000);
    // Cari file hasil download
    const id = ytUrl.match(/[?&]v=([^&]+)/)?.[1] || 'ytdlp';
    const candidates = fs.readdirSync(outDir).filter(f => f.startsWith('ytdlp_') && f.endsWith('.mp3'));
    candidates.sort((a,b) => fs.statSync(path.join(outDir,b)).mtimeMs - fs.statSync(path.join(outDir,a)).mtimeMs);
    if (!candidates.length) throw new Error('yt-dlp download produced no file');
    return path.join(outDir, candidates[0]);
}

const API_KEY = process.env.BETABOTZ_API_KEY || 'Btz-7cYq3';
const BETABOTZ_URL = 'https://api.betabotz.eu.org/api';
const FREE_API_URL = 'https://api.siputzx.my.id/api';

const YT_CONFIG = {
    SALT: '384d5028ee4a399f6cae0175025a1708aa924fc0ccb08be1aa359cd856dd1639',
    ENDPOINT: 'https://ssyoutube.com/api/v1/download'
};

function generateYTSignature(url, timestamp) {
    const rawString = url + timestamp + YT_CONFIG.SALT;
    return crypto.createHash('sha256').update(rawString).digest('hex');
}

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(resource, {
        ...options,
        signal: controller.signal  
    });
    clearTimeout(id);

    return response;
}

async function fetchJson(url) {
    try {
        const response = await fetchWithTimeout(url);
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
    // ============================================================
    // ATTEMPT 0: RYZUMI PREMIUM (Donator - IP Based)
    // ============================================================
    try {
        const ryzumiUrl = `https://api.ryzumi.net/api/downloader/all-in-one?url=${encodeURIComponent(originalUrl)}`;
        const res = await fetchWithTimeout(ryzumiUrl, { timeout: 10000 });
        const json = await res.json();
        
        if (json.medias && Array.isArray(json.medias) && json.medias.length > 0) {
            // Pilih media yang relevan (misal video untuk TikTok/FB, atau media pertama)
            const media = json.medias.find(m => m.type === 'video') || json.medias[0];
            if (media && media.url) {
                return {
                    title: json.title || 'Downloaded Media',
                    url: media.url,
                    source: 'Ryzumi'
                };
            }
        }
    } catch (e) {
        logger.warn(`[DOWNLOADER] Ryzumi fallback failed for ${originalUrl}: ${e.message}`);
    }

    // Try Free API next
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
    const encodedUrl = encodeURIComponent(url);
    
    // Attempt 0: Ryzumi Premium
    try {
        const ryzumiRes = await fetchWithTimeout(`https://api.ryzumi.net/api/downloader/all-in-one?url=${encodedUrl}`, { timeout: 15000 });
        const ryzumiJson = await ryzumiRes.json();
        if (ryzumiJson.medias && Array.isArray(ryzumiJson.medias)) {
            const audioMedia = ryzumiJson.medias.find(m => m.type === 'audio') || ryzumiJson.medias[0];
            if (audioMedia && audioMedia.url) {
                return { title: ryzumiJson.title || 'YouTube Audio', url: audioMedia.url };
            }
        }
    } catch (e) { logger.warn('[YTMP3] Ryzumi API failed: ' + e.message); }

    // Attempt 1: Magma API (Free & Stable)
    try {
        const res = await fetchWithTimeout(`https://www.magma-api.biz.id/download/ytmp3?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        console.log('[YTMP3] Magma response:', JSON.stringify(json).substring(0, 200));
        if (json.status && (json.result?.download?.url || json.result?.url)) {
            return { title: json.result.title || 'YouTube Audio', url: json.result.download?.url || json.result.url };
        }
    } catch (e) { logger.warn('[YTMP3] Magma API failed: ' + e.message); }

    // Attempt 2: Deline API (Free & Stable)
    try {
        const res = await fetchWithTimeout(`https://api.deline.web.id/downloader/ytmp3?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        console.log('[YTMP3] Deline response:', JSON.stringify(json).substring(0, 200));
        const dlUrl = json.result?.url || json.result?.media?.mp3;
        if (json.status && dlUrl) {
            return { title: json.result.title || 'YouTube Audio', url: dlUrl };
        }
    } catch (e) { logger.warn('[YTMP3] Deline API failed: ' + e.message); }

    // Attempt 3: Vreden API (Free)
    try {
        const res = await fetchWithTimeout(`https://api.vreden.my.id/api/ytmp3?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        if (json.status === 200 && json.result?.download?.url) {
            return { title: json.result.title || 'YouTube Audio', url: json.result.download.url };
        }
    } catch (e) { logger.warn('[YTMP3] Vreden API failed: ' + e.message); }

    // Attempt 4: Lolhuman (Premium/Key Based)
    const LOL_KEY = process.env.LOLHUMAN_API_KEY;
    if (LOL_KEY) {
        try {
            const res = await fetchWithTimeout(`https://api.lolhuman.xyz/api/ytaudio2?apikey=${LOL_KEY}&url=${encodedUrl}`, { timeout: 10000 });
            const json = await res.json();
            if (json.status === 200 && json.result?.link) {
                return { title: json.result.title || 'YouTube Audio', url: json.result.link };
            }
        } catch (e) { logger.warn('[YTMP3] Lolhuman API failed: ' + e.message); }
    }

    // Attempt 5: Cobalt Tools API (Free & Very Stable)
    try {
        const res = await fetchWithTimeout(`https://api.cobalt.tools/api/json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ url: url, audioFormat: 'mp3', downloadMode: 'audio' }),
            timeout: 15000
        });
        const json = await res.json();
        if (json.status === 'stream' || json.status === 'success') {
            return { title: 'YouTube Audio', url: json.url };
        }
    } catch (e) { logger.warn('[YTMP3] Cobalt API failed: ' + e.message); }

    // Attempt 5b: Y2mate.is API (Free)
    try {
        const res = await fetchWithTimeout(`https://y2mate.is/api/convert?url=${encodedUrl}&format=mp3`, { timeout: 10000 });
        const json = await res.json();
        if (json.status === 'success' && json.downloadUrl) {
            return { title: json.title || 'YouTube Audio', url: json.downloadUrl };
        }
    } catch (e) { logger.warn('[YTMP3] Y2mate API failed: ' + e.message); }

    // Attempt 5c: @distube/ytdl-core — pure Node
    try {
        const ytdl = require('@distube/ytdl-core');
        const info = await ytdl.getInfo(url);
        const fmt = ytdl.chooseFormat(info.formats, { quality: 'lowestaudio', filter: 'audioonly' })
            || ytdl.chooseFormat(info.formats, { filter: 'audioonly' })
            || info.formats.find(f => f.hasAudio);
        if (fmt?.url) {
            return { title: info.videoDetails.title || 'YouTube Audio', url: fmt.url };
        }
    } catch (e) { logger.warn('[YTMP3] ytdl-core failed: ' + e.message); }

    // Attempt 6: yt-dlp lokal — download MP3 ke tmp, return file path
    try {
        const filePath = await ytdlpDownloadMp3(url);
        const title = await ytdlpGetTitle(url);
        return { title, filePath, url: null };
    } catch (e) { logger.warn('[YTMP3] yt-dlp failed: ' + e.message); }

    // Attempt 7: Skizo API (Free)
    try {
        const res = await fetchWithTimeout(`https://skizo.tech/api/ytdl?url=${encodedUrl}&apikey=af7d4c86`, { timeout: 10000 });
        const json = await res.json();
        if (json.status && (json.audio?.url || json.download?.url)) {
            return { title: json.title || 'YouTube Audio', url: json.audio?.url || json.download?.url };
        }
    } catch (e) { logger.warn('[YTMP3] Skizo API failed: ' + e.message); }

    // Attempt 8: Siputzx Direct
    try {
        const res = await fetchWithTimeout(`${FREE_API_URL}/d/ytmp3?url=${encodedUrl}`, { timeout: 10000 });
        const json = await res.json();
        if (json.status && (json.data?.dl || json.data?.url)) {
            return { title: json.data?.title || 'YouTube Audio', url: json.data?.dl || json.data?.url };
        }
    } catch (e) { logger.warn('[YTMP3] Siputzx direct API failed: ' + e.message); }

    // Last fallback: Return error yang informatif
    throw new Error('Semua API download gagal. Coba lagi nanti atau gunakan link YouTube yang berbeda.');
}

async function ytmp4(query) {
    const url = await searchYouTube(query);
    const encodedUrl = encodeURIComponent(url);
    
    // Attempt 0: Ryzumi Premium
    try {
        const ryzumiRes = await fetchWithTimeout(`https://api.ryzumi.net/api/downloader/all-in-one?url=${encodedUrl}`, { timeout: 15000 });
        const ryzumiJson = await ryzumiRes.json();
        if (ryzumiJson.medias && Array.isArray(ryzumiJson.medias)) {
            const videoMedia = ryzumiJson.medias.find(m => m.type === 'video') || ryzumiJson.medias[0];
            if (videoMedia && videoMedia.url) {
                return { title: ryzumiJson.title || 'YouTube Video', url: videoMedia.url };
            }
        }
    } catch (e) { logger.warn('[YTMP4] Ryzumi API failed: ' + e.message); }

    // Attempt 1: Magma API
    try {
        const res = await fetchWithTimeout(`https://www.magma-api.biz.id/download/ytmp4?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        console.log('[YTMP4] Magma response:', JSON.stringify(json).substring(0, 200));
        if (json.status && (json.result?.download?.url || json.result?.url)) {
            return { title: json.result.title || 'YouTube Video', url: json.result.download?.url || json.result.url };
        }
    } catch (e) { logger.warn('[YTMP4] Magma API failed: ' + e.message); }

    // Attempt 2: Deline API
    try {
        const res = await fetchWithTimeout(`https://api.deline.web.id/downloader/ytmp4?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        console.log('[YTMP4] Deline response:', JSON.stringify(json).substring(0, 200));
        const dlUrl = json.result?.url || json.result?.media?.mp4;
        if (json.status && dlUrl) {
            return { title: json.result.title || 'YouTube Video', url: dlUrl };
        }
    } catch (e) { logger.warn('[YTMP4] Deline API failed: ' + e.message); }

    // Attempt 3: Vreden API (Free)
    try {
        const res = await fetchWithTimeout(`https://api.vreden.my.id/api/ytmp4?url=${encodedUrl}`, { timeout: 8000 });
        const json = await res.json();
        if (json.status === 200 && json.result?.download?.url) {
            return { title: json.result.title || 'YouTube Video', url: json.result.download.url };
        }
    } catch (e) { logger.warn('[YTMP4] Vreden API failed: ' + e.message); }

    // Attempt 4: Lolhuman
    const LOL_KEY = process.env.LOLHUMAN_API_KEY;
    if (LOL_KEY) {
        try {
            const res = await fetchWithTimeout(`https://api.lolhuman.xyz/api/ytvideo2?apikey=${LOL_KEY}&url=${encodedUrl}`, { timeout: 10000 });
            const json = await res.json();
            if (json.status === 200 && json.result?.link) {
                return { title: json.result.title || 'YouTube Video', url: json.result.link };
            }
        } catch (e) { logger.warn('[YTMP4] Lolhuman API failed: ' + e.message); }
    }

    return await fallbackDownload(`${FREE_API_URL}/d/ytmp4?url=`, '/download/ytmp4', url);
}

async function spotifyDl(url) {
    const encodedUrl = encodeURIComponent(url);

    // Attempt 1: Magma API
    try {
        const res = await fetch(`https://www.magma-api.biz.id/download/spotify?url=${encodedUrl}`);
        const json = await res.json();
        if (json.status && json.result?.download?.url) {
            return { title: json.result.title || 'Spotify Music', url: json.result.download.url };
        }
    } catch (e) { logger.warn('[SPOTIFY] Magma API failed'); }

    // Attempt 2: Deline API
    try {
        const res = await fetch(`https://api.deline.web.id/downloader/spotify?url=${encodedUrl}`);
        const json = await res.json();
        if (json.status && json.result?.url) {
            return { title: json.result.title || 'Spotify Music', url: json.result.url };
        }
    } catch (e) { logger.warn('[SPOTIFY] Deline API failed'); }

    try {
        // Step 1: Get track metadata
        const metadataRes = await fetch(`https://api.spotifydown.com/metadata/track/${url.split('track/')[1]?.split('?')[0]}`);
        const metadata = await metadataRes.json();
        
        if (metadata.success) {
            // Step 2: Get download link
            const downloadRes = await fetch(`https://api.spotifydown.com/download/${metadata.id}`);
            const download = await downloadRes.json();
            
            if (download.success && download.link) {
                return {
                    title: `${metadata.title} - ${metadata.artists}`,
                    url: download.link
                };
            }
        }
    } catch (e) {
        logger.warn('[SPOTIFY] Scraper failed, falling back to API...');
    }
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

async function pinterestDl(url) {
    return await fallbackDownload(`${FREE_API_URL}/d/pinterest?url=`, '/download/pinterest', url);
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
    pinterestDl,
    getBuffer
};
