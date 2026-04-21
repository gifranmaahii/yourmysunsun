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
    // LAYER 2: PRIVATE API KEY (Cepat & Stabil, Tapi Pake Limit)
    // (BetaBotz API -> 100 hit/hari)
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
            errors.push(`Layer 2 (BetaBotz) Gagal: ${e.message}`);
        }
    } else {
        errors.push(`Layer 2 Dilewati: Tidak ada Token BetaBotz di .env`);
    }

    // ============================================================
    // LAYER 3: ALTERNATIVE PUBLIC API KEY
    // (Lolhuman API - Akan memakai Personal Key Anda jika ada)
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
        errors.push(`Layer 3 (Lolhuman) Gagal: ${e.message}`);
    }

    // ============================================================
    // JIKA SEMUA LAYER GAGAL
    // ============================================================
    console.error(`[IG Downloader] Semua layer gagal ditembus:\n`, errors.join('\n'));
    
    if (!betabotzKey) {
        throw new Error(
            '🚫 Semua server Scraper Publik sedang terblokir Instagram (Anti-Bot).\n\n' +
            '💡 *SOLUSI DARURAT:* Aktifkan Jalur VVIP!\n' +
            '1. Daftar di web: https://api.betabotz.eu.org\n' +
            '2. Copy API Key Anda.\n' +
            '3. Buka file `.env` dan tambahkan:\n\n' +
            '`BETABOTZ_API_KEY=kunci_api_anda_di_sini`\n\n' +
            'Setelah dimasukkan, restart bot dan fitur Instagram akan berjalan lancar lagi!'
        );
    } else {
        throw new Error(`🚫 Gagal mengambil Instagram, semua server down termasuk API BetaBotz. Atau limit harian API Key Anda habis.`);
    }
}

module.exports = {
    getInstagramMedia
};
