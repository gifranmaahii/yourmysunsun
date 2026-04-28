const { createCanvas } = require('@napi-rs/canvas');
const sharp = require('sharp');
const { logger } = require('../utils/logger');

/**
 * Membuat buffer gambar thumbnail (JPEG) untuk pancingan (Fake Preview)
 * @param {string} text - Teks yang akan ditampilkan di thumbnail
 * @returns {Buffer} Buffer JPEG thumbnail (max 32KB)
 */
async function generateFakeThumbnail(text = 'TAP ME') {
    try {
        const width = 200;
        const height = 200;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Background (Gelap agar kontras)
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        // Border
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.strokeRect(10, 10, width - 20, height - 20);

        // Teks
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Wrap text jika terlalu panjang
        const words = text.toUpperCase().split(' ');
        let line = '';
        let y = height / 2;
        
        if (words.length > 1) {
            ctx.fillText(words[0], width / 2, height / 2 - 15);
            ctx.fillText(words.slice(1).join(' '), width / 2, height / 2 + 15);
        } else {
            ctx.fillText(text.toUpperCase(), width / 2, height / 2);
        }

        // Simpan sebagai JPEG dengan kualitas rendah agar sizenya kecil (syarat WA < 32KB)
        const buffer = canvas.toBuffer('image/png');
        return await sharp(buffer)
            .jpeg({ quality: 50 })
            .resize(200, 200)
            .toBuffer();
    } catch (err) {
        logger.error(`❌ Gagal generate fake thumbnail: ${err.message}`);
        return null;
    }
}

module.exports = {
    generateFakeThumbnail
};
