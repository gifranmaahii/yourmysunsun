const fetch = require('node-fetch');

/**
 * Mengambil link media Instagram (Video/Foto/Reels) menggunakan Sistem Auto-Fallback
 * (Jalur Cadangan Berlapis agar bot super stabil)
 */
async function getInstagramMedia(url) {
    const errors = [];
    const encodedUrl = encodeURIComponent(url);

    // ============================================================
    // LAYER 1: PUBLIC SCRAPER (Gratis 100%, Tanpa Limit)
    // ============================================================
    try {
        // Coba Siputzx Public API (Scraper unlimited)
        const res = await fetch(`https://api.siputzx.my.id/api/d/igdl?url=${encodedUrl}`);
        const data = await res.json();
        if (data.status && data.data && data.data.length > 0) {
            // Standarisasi output jadi array o{url}
            return data.data.map(item => ({ url: item.url }));
        }
    } catch (e) {
        errors.push(`Layer 1 (Siputzx) Gagal: ${e.message}`);
    }

    try {
        // Coba Ryzendesu Public API (Scraper unlimited)
        const res = await fetch(`https://api.ryzendesu.vip/api/downloader/igdl?url=${encodedUrl}`);
        const data = await res.json();
        if (data.url && data.url.length > 0) {
            return data.url.map(link => ({ url: link }));
        }
    } catch (e) {
        errors.push(`Layer 1 (Ryzendesu) Gagal: ${e.message}`);
    }

    // ============================================================
    // LAYER 2: PITUCODE API (50 req/hari, Stabil & Terpercaya)
    // Endpoint: instagram-downloader & instagram-downloader-v2
    // Auth: Header x-api-key
    // ============================================================
    const pitucodeKey = process.env.PITUCODE_API_KEY;
    if (pitucodeKey) {
        // Coba V2 dulu (lebih baru)
        try {
            const res = await fetch(`https://api.pitucode.com/instagram-downloader-v2?url=${encodedUrl}`, {
                headers: { 'x-api-key': pitucodeKey }
            });
            const data = await res.json();
            console.log('[IG] Pitucode V2 response:', JSON.stringify(data).substring(0, 300));
            
            if (data.status && data.data) {
                // Handle berbagai format response
                if (Array.isArray(data.data)) {
                    const mediaLinks = data.data
                        .filter(item => item.url || item.download || item.link)
                        .map(item => ({ url: item.url || item.download || item.link }));
                    if (mediaLinks.length > 0) return mediaLinks;
                } else if (typeof data.data === 'string') {
                    return [{ url: data.data }];
                } else if (data.data.url || data.data.download) {
                    return [{ url: data.data.url || data.data.download }];
                }
            }
            // Fallback: cek field result
            if (data.result) {
                if (Array.isArray(data.result)) {
                    const mediaLinks = data.result
                        .filter(item => typeof item === 'string' || item.url || item.download)
                        .map(item => typeof item === 'string' ? { url: item } : { url: item.url || item.download });
                    if (mediaLinks.length > 0) return mediaLinks;
                }
            }
        } catch (e) {
            errors.push(`Layer 2 (Pitucode V2) Gagal: ${e.message}`);
        }

        // Coba V1 sebagai cadangan Pitucode
        try {
            const res = await fetch(`https://api.pitucode.com/instagram-downloader?url=${encodedUrl}`, {
                headers: { 'x-api-key': pitucodeKey }
            });
            const data = await res.json();
            console.log('[IG] Pitucode V1 response:', JSON.stringify(data).substring(0, 300));
            
            if (data.status && data.data) {
                if (Array.isArray(data.data)) {
                    const mediaLinks = data.data
                        .filter(item => item.url || item.download || item.link)
                        .map(item => ({ url: item.url || item.download || item.link }));
                    if (mediaLinks.length > 0) return mediaLinks;
                } else if (typeof data.data === 'string') {
                    return [{ url: data.data }];
                } else if (data.data.url || data.data.download) {
                    return [{ url: data.data.url || data.data.download }];
                }
            }
            if (data.result) {
                if (Array.isArray(data.result)) {
                    const mediaLinks = data.result
                        .filter(item => typeof item === 'string' || item.url || item.download)
                        .map(item => typeof item === 'string' ? { url: item } : { url: item.url || item.download });
                    if (mediaLinks.length > 0) return mediaLinks;
                }
            }
        } catch (e) {
            errors.push(`Layer 2 (Pitucode V1) Gagal: ${e.message}`);
        }
    } else {
        errors.push(`Layer 2 Dilewati: Tidak ada API Key Pitucode di .env`);
    }

    // ============================================================
    // LAYER 3: BETABOTZ PRIVATE API KEY (100 hit/hari)
    // ============================================================
    const betabotzKey = process.env.BETABOTZ_API_KEY; 
    if (betabotzKey) {
        try {
            const res = await fetch(`https://api.betabotz.eu.org/api/download/igdowloader?url=${encodedUrl}&apikey=${betabotzKey}`);
            const data = await res.json();
            if (data.status && data.result && data.result.length > 0) {
                return data.result; 
            }
        } catch (e) {
            errors.push(`Layer 3 (BetaBotz) Gagal: ${e.message}`);
        }
    } else {
        errors.push(`Layer 3 Dilewati: Tidak ada Token BetaBotz di .env`);
    }

    // ============================================================
    // LAYER 4: LOLHUMAN ALTERNATIVE PUBLIC API KEY
    // ============================================================
    const lolhumanKey = process.env.LOLHUMAN_API_KEY || 'beta';
    try {
        const res = await fetch(`https://api.lolhuman.xyz/api/instagram?apikey=${lolhumanKey}&url=${encodedUrl}`);
        const data = await res.json();
        if (data.status === 200 && data.result && data.result.length > 0) {
            // Lolhuman me-return array of strings langsung
            return data.result.map(link => ({ url: link }));
        }
    } catch (e) {
        errors.push(`Layer 4 (Lolhuman) Gagal: ${e.message}`);
    }

    // ============================================================
    // JIKA SEMUA LAYER GAGAL
    // ============================================================
    console.error(`[IG Downloader] Semua layer gagal ditembus:\n`, errors.join('\n'));
    
    if (!betabotzKey && !pitucodeKey) {
        throw new Error(
            '🚫 Semua server Scraper Publik sedang terblokir Instagram (Anti-Bot).\n\n' +
            '💡 *SOLUSI DARURAT:* Aktifkan Jalur VVIP!\n' +
            '1. Daftar di web: https://pitucode.com atau https://api.betabotz.eu.org\n' +
            '2. Copy API Key Anda.\n' +
            '3. Buka file `.env` dan tambahkan:\n\n' +
            '`PITUCODE_API_KEY=kunci_api_anda_di_sini`\n\n' +
            'Setelah dimasukkan, restart bot dan fitur Instagram akan berjalan lancar lagi!'
        );
    } else {
        throw new Error(`🚫 Gagal mengambil Instagram, semua server down termasuk API Pitucode & BetaBotz. Cek limit harian API Key Anda.`);
    }
}

module.exports = {
    getInstagramMedia
};
