const sharp = require('sharp');
const { createCanvas, registerFont } = require('@napi-rs/canvas');
const { logger } = require('../utils/logger');
const { getConfig } = require('../utils/config');
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
        const cfg1 = getConfig();
        sticker = await addExif(sticker, cfg1.stickerPackName, cfg1.stickerPackAuthor);

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

        // === STEP 1: Render teks ===
        const textBuffer = generateTextPngBuffer(text);

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
        const cfg2 = getConfig();
        const stickerMuxed = await addExif(composedSticker, cfg2.stickerPackName, cfg2.stickerPackAuthor);

        logger.info(`✅ Sticker dengan teks "${text}" berhasil dibuat`);
        return stickerMuxed;
    } catch (err) {
        logger.error(`❌ Gagal buat sticker dengan teks: ${err.message}`);
        throw err;
    }
}

/**
 * Buat sticker bulat (Circle)
 * @param {Buffer} imageBuffer 
 * @returns {Buffer}
 */
async function createCircleSticker(imageBuffer) {
    try {
        const STICKER_SIZE = 512;
        const circleShape = Buffer.from(
            `<svg><circle cx="${STICKER_SIZE / 2}" cy="${STICKER_SIZE / 2}" r="${STICKER_SIZE / 2}" /></svg>`
        );

        const circleSticker = await sharp(imageBuffer)
            .resize(STICKER_SIZE, STICKER_SIZE, {
                fit: 'cover',
                position: 'center'
            })
            .composite([{
                input: circleShape,
                blend: 'dest-in'
            }])
            .webp({ quality: 80 })
            .toBuffer();

        const cfg = getConfig();
        return await addExif(circleSticker, cfg.stickerPackName, cfg.stickerPackAuthor);
    } catch (err) {
        logger.error(`❌ Gagal buat circle sticker: ${err.message}`);
        throw err;
    }
}

/**
 * Buat sticker dengan sudut membulat (Rounded)
 * @param {Buffer} imageBuffer 
 * @returns {Buffer}
 */
async function createRoundedSticker(imageBuffer) {
    try {
        const STICKER_SIZE = 512;
        const rectShape = Buffer.from(
            `<svg><rect x="0" y="0" width="${STICKER_SIZE}" height="${STICKER_SIZE}" rx="50" ry="50" /></svg>`
        );

        const roundedSticker = await sharp(imageBuffer)
            .resize(STICKER_SIZE, STICKER_SIZE, {
                fit: 'cover',
                position: 'center'
            })
            .composite([{
                input: rectShape,
                blend: 'dest-in'
            }])
            .webp({ quality: 80 })
            .toBuffer();

        const cfg = getConfig();
        return await addExif(roundedSticker, cfg.stickerPackName, cfg.stickerPackAuthor);
    } catch (err) {
        logger.error(`❌ Gagal buat rounded sticker: ${err.message}`);
        throw err;
    }
}

/**
 * Buat sticker ala Meme (Teks di atas dan bawah)
 * @param {Buffer} imageBuffer 
 * @param {string} topText 
 * @param {string} bottomText 
 * @returns {Buffer}
 */
async function createMemeSticker(imageBuffer, topText = '', bottomText = '') {
    try {
        const STICKER_SIZE = 512;
        
        const topTxtBuf = generateMemeTextBuffer(topText, STICKER_SIZE, true);
        const botTxtBuf = generateMemeTextBuffer(bottomText, STICKER_SIZE, false);

        const memeSticker = await sharp(imageBuffer)
            .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'cover' })
            .composite([
                { input: topTxtBuf, top: 10, left: 0 },
                { input: botTxtBuf, top: STICKER_SIZE - 90, left: 0 }
            ])
            .webp({ quality: 80 })
            .toBuffer();

        const cfg = getConfig();
        return await addExif(memeSticker, cfg.stickerPackName, cfg.stickerPackAuthor);
    } catch (err) {
        logger.error(`❌ Gagal buat meme sticker: ${err.message}`);
        throw err;
    }
}

function generateMemeTextBuffer(text, width, isTop) {
    const height = 80;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.font = 'bold 45px Impact, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 4;

    const x = width / 2;
    const y = isTop ? 50 : 60;

    ctx.strokeText(text.toUpperCase(), x, y);
    ctx.fillText(text.toUpperCase(), x, y);

    return canvas.toBuffer('image/png');
}

/**
 * Buat sticker dengan filter warna
 * @param {Buffer} imageBuffer 
 * @param {string} filter - grayscale, invert, sepia
 * @returns {Buffer}
 */
async function createFilteredSticker(imageBuffer, filter) {
    try {
        const STICKER_SIZE = 512;
        let s = sharp(imageBuffer).resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });

        if (filter === 'gray' || filter === 'grayscale') {
            s = s.grayscale();
        } else if (filter === 'invert') {
            s = s.negate();
        } else if (filter === 'sepia') {
            s = s.recomb([
                [0.393, 0.769, 0.189],
                [0.349, 0.686, 0.168],
                [0.272, 0.534, 0.131]
            ]);
        }

        const filteredSticker = await s.webp({ quality: 80 }).toBuffer();
        const cfg = getConfig();
        return await addExif(filteredSticker, cfg.stickerPackName, cfg.stickerPackAuthor);
    } catch (err) {
        logger.error(`❌ Gagal buat filtered sticker: ${err.message}`);
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
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=10,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,format=rgba',
                    '-lossless 0',           
                    '-compression_level 6',
                    '-qscale 20',               
                    '-loop 0',               
                    '-preset default',
                    '-an',                   
                    '-vsync 0',
                    '-t 8'
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
            const cfg3 = getConfig();
            addExif(outBuffer, cfg3.stickerPackName, cfg3.stickerPackAuthor)
                .then(muxedBuffer => {
                    resolveCallback(muxedBuffer);
                })
                .catch(e => {
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
 * Konversi video/GIF (mp4) ke Animated WebP Sticker dengan Teks di Atas
 * 
 * @param {Buffer} mediaBuffer - Buffer mp4 atau gif
 * @param {string} text - Teks di atas
 * @returns {Promise<Buffer>} Buffer WebP animated
 */
async function createAnimatedStickerWithText(mediaBuffer, text) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputVideoPath  = path.join(tempDir, `v_in_${tempId}.mp4`);
        const inputTextPath   = path.join(tempDir, `t_in_${tempId}.png`);
        const outputPath      = path.join(tempDir, `out_${tempId}.webp`);

        try {
            fs.writeFileSync(inputVideoPath, mediaBuffer);
            
            const textBuffer = generateTextPngBuffer(text);
            fs.writeFileSync(inputTextPath, textBuffer);

            ffmpeg()
                .input(inputTextPath)
                .input(inputVideoPath)
                .complexFilter([
                    // Video (input 1) di-scale dan di-pad ke ukuran 512x412, warna putih
                    '[1:v]scale=512:412:force_original_aspect_ratio=decrease,fps=10,pad=512:412:(ow-iw)/2:(oh-ih)/2:color=white@1.0,format=rgba[vid]',
                    // Teks PNG (input 0) ditumpuk di atas Video [vid] secara vertikal -> 512x512 total
                    '[0:v][vid]vstack=inputs=2[outv]'
                ], 'outv')
                .outputOptions([
                    '-vcodec libwebp',
                    '-lossless 0',           
                    '-compression_level 6',
                    '-qscale 20',               
                    '-loop 0',               
                    '-preset default',
                    '-an',                   
                    '-vsync 0',
                    '-t 8'
                ])
                .toFormat('webp')
                .on('end', () => {
                    finishProcessing(outputPath, [inputVideoPath, inputTextPath], resolve, reject);
                })
                .on('error', (err2) => {
                    cleanupTempFiles([inputVideoPath, inputTextPath], outputPath);
                    logger.error(`❌ Gagal konversi sticker gerak + teks: ${err2.message}`);
                    reject(err2);
                })
                .save(outputPath);
        } catch (e) {
            cleanupTempFiles([inputVideoPath, inputTextPath], outputPath);
            reject(e);
        }
    });

    function finishProcessing(outPath, inPaths, resolveCallback, rejectCallback) {
        try {
            const outBuffer = fs.readFileSync(outPath);
            cleanupTempFiles(inPaths, outPath);
            
            const cfg4 = getConfig();
            addExif(outBuffer, cfg4.stickerPackName, cfg4.stickerPackAuthor)
                .then(muxedBuffer => {
                    logger.info('✅ Sticker gerak + teks berhasil dibuat');
                    resolveCallback(muxedBuffer);
                })
                .catch(e => {
                    resolveCallback(outBuffer);
                });
        } catch (e) {
            cleanupTempFiles(inPaths, outPath);
            rejectCallback(e);
        }
    }

    function cleanupTempFiles(inPaths, outP) {
        if (Array.isArray(inPaths)) {
            inPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
        } else {
            if (fs.existsSync(inPaths)) fs.unlinkSync(inPaths);
        }
        if (fs.existsSync(outP)) fs.unlinkSync(outP);
    }
}

/** Helper untuk membuat buffer PNG teks */
function generateTextPngBuffer(text) {
    const STICKER_SIZE = 512;
    const TEXT_AREA_HEIGHT = 100;       
    const PADDING = 16;
    const MAX_FONT_SIZE = 36;
    const MIN_FONT_SIZE = 16;

    let fontSize = MAX_FONT_SIZE;
    let textCanvas = createCanvas(STICKER_SIZE, TEXT_AREA_HEIGHT);
    let textCtx = textCanvas.getContext('2d');

    while (fontSize >= MIN_FONT_SIZE) {
        textCtx.font = `bold ${fontSize}px Arial, sans-serif`;
        const metrics = textCtx.measureText(text);
        if (metrics.width <= STICKER_SIZE - (PADDING * 2)) break;
        fontSize -= 2;
    }

    textCtx.fillStyle = '#FFFFFF';
    textCtx.fillRect(0, 0, STICKER_SIZE, TEXT_AREA_HEIGHT);

    textCtx.fillStyle = '#000000';
    textCtx.font = `bold ${fontSize}px Arial, sans-serif`;
    textCtx.textAlign = 'center';
    textCtx.textBaseline = 'middle';
    textCtx.fillText(text, STICKER_SIZE / 2, TEXT_AREA_HEIGHT / 2, Math.max(0, STICKER_SIZE - (PADDING * 2)));

    return textCanvas.toBuffer('image/png');
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
    createAnimatedSticker,
    createAnimatedStickerWithText,
    createCircleSticker,
    createRoundedSticker,
    createMemeSticker,
    createFilteredSticker,
    addExif
};
