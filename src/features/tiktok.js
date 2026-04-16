const { logger } = require('../utils/logger');
const https = require('https');

/**
 * Konversi link TikTok menjadi buffer audio (music)
 * Menggunakan unofficial API TikWM (tikwm.com)
 * 
 * @param {string} url - Link TikTok
 * @returns {Promise<{buffer: Buffer, title: string, author: string}>}
 */
async function getTikTokAudio(url) {
    try {
        // Ambil data metadata dari API
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const json = await response.json();

        if (json.code !== 0 || !json.data) {
            throw new Error(json.msg || 'Gagal mengambil data dari TikTok');
        }

        const data = json.data;
        const musicUrl = data.music;
        
        if (!musicUrl) {
            throw new Error('Audio tidak ditemukan pada video ini');
        }

        logger.info(`🎵 Audio TikTok ditemukan: ${data.music_info?.title || 'Unknown Title'}`);

        // Download MP3 buffer
        const audioBuffer = await new Promise((resolve, reject) => {
            https.get(musicUrl, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });

        return {
            buffer: audioBuffer,
            title: data.music_info?.title || data.title || 'TikTok Audio',
            author: data.music_info?.author || data.author?.nickname || 'Unknown Author'
        };

    } catch (err) {
        logger.error(`❌ Gagal scrape TikTok: ${err.message}`);
        throw err;
    }
/**
 * Konversi link TikTok menjadi buffer video tanpa watermark
 * Menggunakan unofficial API TikWM (tikwm.com)
 * 
 * @param {string} url - Link TikTok
 * @returns {Promise<{buffer: Buffer, title: string, author: string}>}
 */
async function getTikTokVideo(url) {
    try {
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const json = await response.json();

        if (json.code !== 0 || !json.data) {
            throw new Error(json.msg || 'Gagal mengambil data dari TikTok');
        }

        const data = json.data;
        const videoUrl = data.play; // URL video tanpa watermark
        
        if (!videoUrl) {
            throw new Error('Video tidak ditemukan (mungkin ini berupa kumpulan foto/slideshow)');
        }

        logger.info(`🎬 Video TikTok ditemukan: ${data.title || 'Unknown Title'}`);

        // Download MP4 buffer
        const videoBuffer = await new Promise((resolve, reject) => {
            https.get(videoUrl, (res) => {
                // Ikuti redirect jika ada (kadang S3/CDN return 3xx)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    https.get(res.headers.location, (res2) => {
                        const chunks = [];
                        res2.on('data', (chunk) => chunks.push(chunk));
                        res2.on('end', () => resolve(Buffer.concat(chunks)));
                        res2.on('error', reject);
                    }).on('error', reject);
                    return;
                }
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });

        return {
            buffer: videoBuffer,
            title: data.title || 'TikTok Video',
            author: data.author?.nickname || 'Unknown Author'
        };

    } catch (err) {
        logger.error(`❌ Gagal download video TikTok: ${err.message}`);
        throw err;
    }
}

module.exports = {
    getTikTokAudio,
    getTikTokVideo
};
