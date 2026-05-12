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
        console.log(`[RYZUMI] 🤖 Memanggil AI Chat: ${model} | Prompt: ${prompt}`);
        const endpoint = model === 'gemini' ? '/api/ai/gemini' : '/api/ai/chatgpt';
        const res = await fetch(`https://api.ryzumi.net${endpoint}?prompt=${encodeURIComponent(prompt)}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        const json = await res.json();
        return json.result || json.response || '❌ Tidak ada respon dari AI.';
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error AI Chat: ${e.message}`);
        logger.error(`[RYZUMI AI] Error: ${e.message}`);
        throw new Error('Gagal menghubungi AI. Coba lagi nanti.');
    }
}

/**
 * AI Image Generation (Flux Diffusion - Kualitas Tinggi)
 */
async function textToImage(prompt) {
    try {
        console.log(`[RYZUMI] 🎨 Membuat Gambar (Flux): ${prompt}`);
        const res = await fetch(`https://api.ryzumi.net/api/ai/flux-diffusion?prompt=${encodeURIComponent(prompt)}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error Image Gen: ${e.message}`);
        logger.error(`[RYZUMI T2I] Error: ${e.message}`);
        throw new Error('Gagal membuat gambar.');
    }
}

/**
 * Screenshot Website
 */
async function ssWeb(url) {
    try {
        console.log(`[RYZUMI] 🌐 Screenshot Web: ${url}`);
        const res = await fetch(`https://api.ryzumi.net/api/tool/ssweb?url=${encodeURIComponent(url)}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error SSWeb: ${e.message}`);
        logger.error(`[RYZUMI SSWEB] Error: ${e.message}`);
        throw new Error('Gagal mengambil screenshot.');
    }
}

/**
 * Remini / Image Upscaler
 */
async function remini(imageUrl) {
    try {
        console.log(`[RYZUMI] 🔍 Upscaling Image (Remini): ${imageUrl}`);
        const res = await fetch(`https://api.ryzumi.net/api/ai/remini?url=${encodeURIComponent(imageUrl)}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        if (res.headers.get('content-type').includes('application/json')) {
            const json = await res.json();
            return json.result || json.url;
        }
        return await res.buffer();
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error Remini: ${e.message}`);
        logger.error(`[RYZUMI REMINI] Error: ${e.message}`);
        throw new Error('Gagal memproses Remini.');
    }
}

/**
 * Quotly (Teks ke Stiker Quote)
 */
async function quotly(text, name, avatar) {
    try {
        console.log(`[RYZUMI] 💬 Membuat Quotly: "${text}" dari ${name}`);
        const params = new URLSearchParams({
            text: text,
            name: name || 'User',
            avatar: avatar || 'https://i.ibb.co/0m0x0x0/user.png'
        });
        const res = await fetch(`https://api.ryzumi.net/api/image/quotly?${params.toString()}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        
        const contentType = res.headers.get('content-type') || '';
        
        // Jika response adalah JSON, ambil URL lalu download gambar
        if (contentType.includes('application/json')) {
            const json = await res.json();
            const imageUrl = json.result || json.url || json.image;
            
            if (!imageUrl) {
                throw new Error('API tidak mengembalikan URL gambar');
            }
            
            console.log(`[RYZUMI] 📥 Downloading image from: ${imageUrl.substring(0, 50)}...`);
            const imgRes = await fetch(imageUrl);
            if (!imgRes.ok) {
                throw new Error(`Failed to download image: ${imgRes.status}`);
            }
            return await imgRes.buffer();
        }
        
        // Jika response langsung gambar
        if (contentType.includes('image/')) {
            return await res.buffer();
        }
        
        // Fallback: coba buffer apapun
        return await res.buffer();
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error Quotly: ${e.message}`);
        logger.error(`[RYZUMI QUOTLY] Error: ${e.message}`);
        throw new Error('Gagal membuat stiker Quotly: ' + e.message);
    }
}

/**
 * Stalking (Instagram / TikTok)
 */
async function stalk(username, type = 'instagram') {
    try {
        console.log(`[RYZUMI] 🕵️ Stalking ${type}: ${username}`);
        const endpoint = type === 'tiktok' ? '/api/stalk/tiktok' : '/api/stalk/instagram';
        const res = await fetch(`https://api.ryzumi.net${endpoint}?username=${encodeURIComponent(username)}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        const json = await res.json();
        return json.result || json.data;
    } catch (e) {
        console.log(`[RYZUMI] ❌ Error Stalk: ${e.message}`);
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
