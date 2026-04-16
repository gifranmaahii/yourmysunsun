const sharp = require('sharp');
const { createCanvas, registerFont } = require('@napi-rs/canvas');
const { logger } = require('../utils/logger');

/**
 * Konversi buffer gambar ke sticker (WebP 512x512)
 * @param {Buffer} imageBuffer - Buffer gambar asli
 * @returns {Buffer} Buffer WebP sticker
 */
async function convertToSticker(imageBuffer) {
    try {
        const sticker = await sharp(imageBuffer)
            .resize(512, 512, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 } // transparent
            })
            .webp({ quality: 80 })
            .toBuffer();

        logger.info('✅ Gambar berhasil dikonversi ke sticker');
        return sticker;
    } catch (err) {
        logger.error(`❌ Gagal konversi sticker: ${err.message}`);
        throw err;
    }
}

/**
 * Buat sticker dengan teks di atas gambar
 * Layout: [Background putih + teks hitam bold] di atas, [gambar] di bawah
 * Semua elemen centered/sejajar
 * 
 * @param {Buffer} imageBuffer - Buffer gambar asli
 * @param {string} text - Teks yang akan ditampilkan di atas
 * @returns {Buffer} Buffer WebP sticker
 */
async function createStickerWithText(imageBuffer, text) {
    try {
        const STICKER_SIZE = 512;
        const TEXT_AREA_HEIGHT = 100;       // Tinggi area teks (background putih)
        const IMAGE_AREA_HEIGHT = STICKER_SIZE - TEXT_AREA_HEIGHT; // 412px untuk gambar
        const PADDING = 16;
        const MAX_FONT_SIZE = 36;
        const MIN_FONT_SIZE = 16;

        // === STEP 1: Render teks dengan @napi-rs/canvas ===
        // Tentukan ukuran font yang pas  
        let fontSize = MAX_FONT_SIZE;
        let textCanvas, textCtx;

        // Cari ukuran font yang muat
        while (fontSize >= MIN_FONT_SIZE) {
            textCanvas = createCanvas(STICKER_SIZE, TEXT_AREA_HEIGHT);
            textCtx = textCanvas.getContext('2d');

            textCtx.font = `bold ${fontSize}px Arial, sans-serif`;
            const metrics = textCtx.measureText(text);

            if (metrics.width <= STICKER_SIZE - (PADDING * 2)) {
                break; // Font size pas
            }
            fontSize -= 2;
        }

        // Gambar background putih untuk area teks
        textCtx.fillStyle = '#FFFFFF';
        textCtx.fillRect(0, 0, STICKER_SIZE, TEXT_AREA_HEIGHT);

        // Gambar teks hitam bold, centered
        textCtx.fillStyle = '#000000';
        textCtx.font = `bold ${fontSize}px Arial, sans-serif`;
        textCtx.textAlign = 'center';
        textCtx.textBaseline = 'middle';
        textCtx.fillText(text, STICKER_SIZE / 2, TEXT_AREA_HEIGHT / 2, STICKER_SIZE - (PADDING * 2));

        // Konversi canvas ke buffer PNG
        const textBuffer = textCanvas.toBuffer('image/png');

        // === STEP 2: Resize gambar asli untuk area bawah ===
        const resizedImage = await sharp(imageBuffer)
            .resize(STICKER_SIZE, IMAGE_AREA_HEIGHT, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 1 } // background putih
            })
            .png()
            .toBuffer();

        // === STEP 3: Compose: teks di atas + gambar di bawah ===
        const composedSticker = await sharp({
            create: {
                width: STICKER_SIZE,
                height: STICKER_SIZE,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
            .composite([
                {
                    input: textBuffer,
                    top: 0,
                    left: 0,
                },
                {
                    input: resizedImage,
                    top: TEXT_AREA_HEIGHT,
                    left: 0,
                }
            ])
            .webp({ quality: 80 })
            .toBuffer();

        logger.info(`✅ Sticker dengan teks "${text}" berhasil dibuat`);
        return composedSticker;
    } catch (err) {
        logger.error(`❌ Gagal buat sticker dengan teks: ${err.message}`);
        throw err;
    }
}

module.exports = {
    convertToSticker,
    createStickerWithText
};
