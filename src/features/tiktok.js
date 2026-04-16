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
}

module.exports = {
    getTikTokAudio
};
