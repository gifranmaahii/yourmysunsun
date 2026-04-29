const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

/**
 * Ryzumi Premium Features Integration
 * Menghubungkan bot ke berbagai fitur Sultan dari Ryzumi API
 */

/**
 * AI Chat (ChatGPT / Gemini)
 * @param {string} prompt - Pesan user
 * @param {string} model - 'chatgpt' atau 'gemini'
 */
async function aiChat(prompt, model = 'chatgpt') {
    try {
        const endpoint = model === 'gemini' ? '/api/ai/gemini' : '/api/ai/chatgpt';
        const res = await fetch(`https://api.ryzumi.net${endpoint}?prompt=${encodeURIComponent(prompt)}`);
        const json = await res.json();
        return json.result || json.response || '❌ Tidak ada respon dari AI.';
    } catch (e) {
        logger.error(`[RYZUMI AI] Error: ${e.message}`);
        throw new Error('Gagal menghubungi AI. Coba lagi nanti.');
    }
}

/**
 * AI Image Generation (Flux Diffusion - Kualitas Tinggi)
 */
async function textToImage(prompt) {
    try {
        const res = await fetch(`https://api.ryzumi.net/api/ai/flux-diffusion?prompt=${encodeURIComponent(prompt)}`);
        // Ryzumi biasanya return buffer langsung atau JSON berisi URL
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        logger.error(`[RYZUMI T2I] Error: ${e.message}`);
        throw new Error('Gagal membuat gambar.');
    }
}

/**
 * Screenshot Website
 */
async function ssWeb(url) {
    try {
        const res = await fetch(`https://api.ryzumi.net/api/tool/ssweb?url=${encodeURIComponent(url)}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        logger.error(`[RYZUMI SSWEB] Error: ${e.message}`);
        throw new Error('Gagal mengambil screenshot.');
    }
}

/**
 * Remini / Image Upscaler
 */
async function remini(imageUrl) {
    try {
        const res = await fetch(`https://api.ryzumi.net/api/ai/remini?url=${encodeURIComponent(imageUrl)}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        logger.error(`[RYZUMI REMINI] Error: ${e.message}`);
        throw new Error('Gagal memproses Remini.');
    }
}

/**
 * Quotly (Teks ke Stiker Quote)
 */
async function quotly(text, name, avatar) {
    try {
        const params = new URLSearchParams({
            text: text,
            name: name || 'User',
            avatar: avatar || 'https://i.ibb.co/0m0x0x0/user.png'
        });
        const res = await fetch(`https://api.ryzumi.net/api/image/quotly?${params.toString()}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        logger.error(`[RYZUMI QUOTLY] Error: ${e.message}`);
        throw new Error('Gagal membuat stiker Quotly.');
    }
}

/**
 * Stalking (Instagram / TikTok)
 */
async function stalk(username, type = 'instagram') {
    try {
        const endpoint = type === 'tiktok' ? '/api/stalk/tiktok' : '/api/stalk/instagram';
        const res = await fetch(`https://api.ryzumi.net${endpoint}?username=${encodeURIComponent(username)}`);
        const json = await res.json();
        return json.result || json.data;
    } catch (e) {
        logger.error(`[RYZUMI STALK] Error: ${e.message}`);
        throw new Error(`Gagal stalking ${type}.`);
    }
}

module.exports = {
    aiChat,
    textToImage,
    ssWeb,
    remini,
    quotly,
    stalk
};
