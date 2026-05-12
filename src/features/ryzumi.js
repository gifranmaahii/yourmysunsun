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
    // Try Ryzumi API first
    try {
        console.log(`[RYZUMI] 💬 Membuat Quotly: "${text}" dari ${name}`);
        const params = new URLSearchParams({
            text: text,
            name: name || 'User',
            avatar: avatar || 'https://i.ibb.co/0m0x0x0/user.png'
        });
        const res = await fetch(`https://api.ryzumi.net/api/image/quotly?${params.toString()}`);
        console.log(`[RYZUMI] 📡 Status: ${res.status} ${res.statusText}`);
        
        if (res.ok) {
            const contentType = res.headers.get('content-type') || '';
            console.log(`[RYZUMI] 📄 Content-Type: ${contentType}`);
            
            if (contentType.includes('application/json')) {
                const json = await res.json();
                const imageUrl = json.result || json.url || json.image || json.data?.url;
                if (imageUrl) {
                    const imgRes = await fetch(imageUrl);
                    if (imgRes.ok) {
                        const imgBuffer = await imgRes.buffer();
                        if (isValidImage(imgBuffer)) return imgBuffer;
                    }
                }
            } else if (contentType.includes('image/')) {
                const buffer = await res.buffer();
                if (isValidImage(buffer)) return buffer;
            }
        }
        throw new Error('Ryzumi API failed');
    } catch (e) {
        console.log(`[RYZUMI] ❌ Ryzumi failed: ${e.message}`);
    }
    
    // Fallback 1: Otakustay API
    try {
        console.log(`[QUOTLY] Trying Otakustay API...`);
        const res = await fetch(`https://api.otakustay.com/quotly?text=${encodeURIComponent(text)}&name=${encodeURIComponent(name || 'User')}&avatar=${encodeURIComponent(avatar || 'https://i.ibb.co/0m0x0x0/user.png')}`);
        if (res.ok) {
            const buffer = await res.buffer();
            if (isValidImage(buffer)) return buffer;
        }
    } catch (e) {
        console.log(`[QUOTLY] Otakustay failed: ${e.message}`);
    }
    
    // Fallback 2: Create local quotly with canvas
    try {
        console.log(`[QUOTLY] Creating local quotly...`);
        return await createLocalQuotly(text, name, avatar);
    } catch (e) {
        console.log(`[QUOTLY] Local creation failed: ${e.message}`);
    }
    
    throw new Error('Semua API Quotly gagal');
}

/**
 * Create local quotly using canvas
 */
async function createLocalQuotly(text, name, avatar) {
    const { createCanvas, loadImage } = require('canvas');
    const fetch = require('node-fetch');
    
    // Canvas setup
    const width = 512;
    const height = 512;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(1, '#16213e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    
    // Card background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.roundRect(20, 20, width - 40, height - 40, 20);
    ctx.fill();
    
    // Try load avatar
    try {
        const avatarRes = await fetch(avatar || 'https://i.ibb.co/0m0x0x0/user.png');
        const avatarBuffer = await avatarRes.buffer();
        const avatarImg = await loadImage(avatarBuffer);
        
        // Draw avatar circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(80, 80, 50, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImg, 30, 30, 100, 100);
        ctx.restore();
    } catch (e) {
        // Draw default avatar circle
        ctx.fillStyle = '#0f3460';
        ctx.beginPath();
        ctx.arc(80, 80, 50, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText((name || 'U')[0].toUpperCase(), 80, 95);
    }
    
    // Name
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'left';
    // Truncate nama panjang
    const displayName = (name || 'User').length > 20 ? (name || 'User').substring(0, 20) + '...' : (name || 'User');
    ctx.fillText(displayName, 150, 70);
    
    // Time
    ctx.fillStyle = '#aaa';
    ctx.font = '16px Arial';
    ctx.fillText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 150, 95);
    
    // Text — dynamic font size based on text length
    const textLen = text.length;
    const fontSize = textLen > 100 ? 24 : textLen > 50 ? 28 : 32;
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${fontSize}px Arial`;
    
    // Word wrap dengan limit baris
    const words = text.split(' ');
    let line = '';
    let y = 180;
    const maxWidth = width - 80;
    const lineHeight = fontSize + 8;
    const maxLines = 6;
    let lineCount = 0;
    
    for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = ctx.measureText(testLine);
        const testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
            if (lineCount >= maxLines - 1) {
                ctx.fillText(line.trim() + '...', 40, y);
                lineCount++;
                break;
            }
            ctx.fillText(line, 40, y);
            line = words[n] + ' ';
            y += lineHeight;
            lineCount++;
        } else {
            line = testLine;
        }
    }
    if (lineCount < maxLines) {
        ctx.fillText(line, 40, y);
    }
    
    const pngBuffer = canvas.toBuffer('image/png');
    
    // Convert PNG ke WebP
    try {
        const sharp = require('sharp');
        return await sharp(pngBuffer).webp().toBuffer();
    } catch (e) {
        // Jika sharp tidak ada, return PNG saja (handler akan convert)
        return pngBuffer;
    }
}

/**
 * Cek magic bytes untuk validasi image (WebP/PNG/JPG)
 */
function isValidImage(buffer) {
    if (!buffer || buffer.length < 10) return false;
    
    // WebP: RIFF....WEBP
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && 
        buffer.toString('ascii', 8, 12) === 'WEBP') {
        return true;
    }
    
    // PNG: PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return true;
    }
    
    // JPEG: Ȣ
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return true;
    }
    
    return false;
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
