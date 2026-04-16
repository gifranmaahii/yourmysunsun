const sharp = require('sharp');
const { createCanvas, registerFont } = require('@napi-rs/canvas');
const { logger } = require('../utils/logger');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const webp = require('node-webpmux');

/**
 * Konversi buffer gambar ke sticker (WebP 512x512)
 * @param {Buffer} imageBuffer - Buffer gambar asli
 * @returns {Buffer} Buffer WebP sticker
 */
async function convertToSticker(imageBuffer) {
    try {
        let sticker = await sharp(imageBuffer)
            .resize(512, 512, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 } // transparent
            })
            .webp({ quality: 80 })
            .toBuffer();

        // Tambahkan metadata EXIF agar WhatsApp mengenali sebagai stiker yang valid
        sticker = await addExif(sticker, 'Bot Stiker', 'Robby Bot');

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

        // Tambahkan EXIF agar dikenali WA
        const stickerMuxed = await addExif(composedSticker, 'Bot Stiker', 'Robby Bot');

        logger.info(`✅ Sticker dengan teks "${text}" berhasil dibuat`);
        return stickerMuxed;
    } catch (err) {
        logger.error(`❌ Gagal buat sticker dengan teks: ${err.message}`);
        throw err;
    }
}

/**
 * Konversi video/GIF (mp4) ke Animated WebP Sticker
 * Format: WebP, resolusi proporsional max 512x512, fps 15.
 * 
 * @param {Buffer} mediaBuffer - Buffer mp4 atau gif
 * @returns {Promise<Buffer>} Buffer WebP animated
 */
async function createAnimatedSticker(mediaBuffer) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputPath  = path.join(tempDir, `in_${tempId}.mp4`);
        const outputPath = path.join(tempDir, `out_${tempId}.webp`);

        try {
            fs.writeFileSync(inputPath, mediaBuffer);

            ffmpeg(inputPath)
                .inputOptions(['-vcodec', 'libx264']) // fallback jika input bermasalah
                .on('error', (err) => {
                    // Coba tanpa inputOption khusus jika yang pertama error
                    try {
                        ffmpeg(inputPath)
                            .outputOptions([
                                '-vcodec libwebp',
                                '-vf', 'scale=320:320:force_original_aspect_ratio=decrease,fps=15,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=white@0.0,format=rgba',
                                '-lossless 0',
                                '-compression_level 4',
                                '-q:v 50',
                                '-loop 0',
                                '-preset default',
                                '-an',
                                '-vsync 0'
                            ])
                            .toFormat('webp')
                            .on('end', () => {
                                finishProcessing(outputPath, inputPath, resolve, reject);
                            })
                            .on('error', (err2) => {
                                cleanupTempFiles(inputPath, outputPath);
                                logger.error(`❌ Gagal konversi sticker gerak: ${err2.message}`);
                                reject(err2);
                            })
                            .save(outputPath);
                    } catch (e) {
                        cleanupTempFiles(inputPath, outputPath);
                        reject(e);
                    }
                })
                .outputOptions([
                    '-vcodec libwebp',
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,format=rgba',
                    '-lossless 0',           
                    '-compression_level 4',
                    '-q:v 50',               
                    '-loop 0',               
                    '-preset default',
                    '-an',                   
                    '-vsync 0'
                ])
                .toFormat('webp')
                .on('end', () => {
                    finishProcessing(outputPath, inputPath, resolve, reject);
                })
                .save(outputPath);
        } catch (e) {
            cleanupTempFiles(inputPath, outputPath);
            reject(e);
        }
    });

    function finishProcessing(outPath, inPath, resolveCallback, rejectCallback) {
        try {
            const outBuffer = fs.readFileSync(outPath);
            cleanupTempFiles(inPath, outPath);
            
            // Tambahkan Metadata EXIF supaya WA memutarnya dan tidak mengubah jadi static image
            addExif(outBuffer, 'Bot Stiker', 'Robby Bot')
                .then(muxedBuffer => {
                    logger.info('✅ Sticker gerak berhasil dibuat');
                    resolveCallback(muxedBuffer);
                })
                .catch(e => {
                    // Fallback walaupun EXIF gagal
                    logger.info('✅ Sticker gerak berhasil dibuat (tanpa EXIF fallback)');
                    resolveCallback(outBuffer);
                });
                
        } catch (e) {
            cleanupTempFiles(inPath, outPath);
            rejectCallback(e);
        }
    }

    function cleanupTempFiles(inP, outP) {
        if (fs.existsSync(inP)) fs.unlinkSync(inP);
        if (fs.existsSync(outP)) fs.unlinkSync(outP);
    }
}

/**
 * Tambahkan EXIF metadata (packId, author) supaya WA
 * merendernya sebagai stiker valid (animasi jalan & bisa disave pakai tombol sticker).
 */
async function addExif(webpBuffer, packname, author) {
    const img = new webp.Image();
    await img.load(webpBuffer);
    
    // EXIF metadata template standard WA
    const json = {
        "sticker-pack-id": "robby-bot",
        "sticker-pack-name": packname,
        "sticker-pack-publisher": author,
        "emojis": ["🤖"]
    };
    
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
    const exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    
    img.exif = exif;
    return await img.save(null);
}

module.exports = {
    convertToSticker,
    createStickerWithText,
    createAnimatedSticker
};
