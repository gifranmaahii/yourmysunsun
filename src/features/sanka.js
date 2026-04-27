const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

async function sankaFetch(endpoint) {
    try {
        // Karena IP sedang dibanned 30 menit oleh Sanka Vollerei (Plana AI),
        // kita alihkan sementara ke API alternatif yang 100% jalan.
        if (endpoint === 'anime') {
            const res = await fetch('https://api.waifu.pics/sfw/waifu');
            const json = await res.json();
            return { type: 'url', data: json.url };
        } else if (endpoint === 'comic') {
            // Gunakan Pinterest search untuk mencari gambar komik/manga
            const res = await fetch(`https://api.siputzx.my.id/api/s/pinterest?query=comic+panel`);
            const json = await res.json();
            if (json.status && json.data && json.data.length > 0) {
                const img = json.data[Math.floor(Math.random() * json.data.length)].image_url;
                return { type: 'url', data: img };
            }
        }
        
        // Fallback asli jika ingin mencoba lagi nanti
        const url = `https://www.sankavollerei.com/${endpoint}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const text = await res.text();
        try {
            const json = JSON.parse(text);
            return { type: 'json', data: json };
        } catch(e) {
            return { type: 'text', data: text };
        }
    } catch (e) {
        logger.error(`[SANKA] Failed: ${e.message}`);
        return null;
    }
}

module.exports = {
    sankaFetch
};
