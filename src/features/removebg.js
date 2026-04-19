const fs = require('fs');
const path = require('path');
const https = require('https');
const { randomBytes } = require('crypto');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { logger } = require('../utils/logger');

// ============================================================
// ============================================================
// KONFIGURASI
// ============================================================
// Parse multiple API keys if provided (comma-separated)
const apiKeysEnv = process.env.REMOVEBG_API_KEY || '';
const REMOVEBG_API_KEYS = apiKeysEnv.split(',').map(k => k.trim()).filter(k => k.length > 0);

// Status sinkronisasi API keys (menyimpan info apakah API key sedang rate limit / exhausted)
// index menunjuk ke API key mana yang sedang aktif
let currentApiKeyIndex = 0;
const apiKeysStatus = REMOVEBG_API_KEYS.map(key => ({
    key: key,
    exhausted: false,
    creditsLeft: null
}));

// ============================================================
// METODE 1: remove.bg API (online, presisi tinggi)
// ============================================================

/**
 * Hapus background via remove.bg API (Menggunakan API Key yg sedang aktif)
 * @param {Buffer} imageBuffer
 * @param {string} apiKeyToUse
 * @returns {Promise<{buffer: Buffer, creditsLeft: number}>}
 */
async function removeViaRemoteBgApi(imageBuffer, apiKeyToUse) {
    // Konversi ke JPEG supaya ukuran lebih kecil
    const jpegBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 90 })
        .toBuffer();

    return new Promise((resolve, reject) => {
        const boundary = `----FormBoundary${randomBytes(8).toString('hex')}`;
        const CRLF = '\r\n';

        const partHeader =
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="image_file"; filename="image.jpg"${CRLF}` +
            `Content-Type: image/jpeg${CRLF}${CRLF}`;

        const formFields =
            `${CRLF}--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="size"${CRLF}${CRLF}` +
            `auto${CRLF}` +
            `--${boundary}--${CRLF}`;

        const body = Buffer.concat([
            Buffer.from(partHeader),
            jpegBuffer,
            Buffer.from(formFields)
        ]);

        const options = {
            hostname: 'api.remove.bg',
            path: '/v1.0/removebg',
            method: 'POST',
            headers: {
                'X-Api-Key': apiKeyToUse,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            }
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const responseBuffer = Buffer.concat(chunks);

                if (res.statusCode === 200) {
                    const creditsRemaining = res.headers['x-api-credits-remaining'];
                    resolve({ buffer: responseBuffer, creditsLeft: parseInt(creditsRemaining) || 999 });

                } else if (res.statusCode === 402) {
                    reject(new Error('QUOTA_EXCEEDED'));

                } else if (res.statusCode === 429) {
                    reject(new Error('RATE_LIMITED'));

                } else {
                    const errMsg = responseBuffer.toString().slice(0, 200);
                    reject(new Error(`HTTP_${res.statusCode}: ${errMsg}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.write(body);
        req.end();
    });
}

// ============================================================
// METODE 2: AI Lokal — @imgly/background-removal-node
// ============================================================

let localBgRemovalModule = null;

async function loadLocalBgRemoval() {
    if (localBgRemovalModule) return localBgRemovalModule;
    try {
        logger.info('📦 Memuat modul AI lokal remove background...');
        localBgRemovalModule = await import('@imgly/background-removal-node');
        logger.info('✅ Modul AI lokal berhasil dimuat');
        return localBgRemovalModule;
    } catch (err) {
        throw new Error(`Gagal memuat modul AI lokal: ${err.message}`);
    }
}

/**
 * Hapus background via AI lokal
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer>} Buffer PNG transparan
 */
async function removeViaLocalAI(imageBuffer) {
    const mod = await loadLocalBgRemoval();
    const removeBackground = mod.removeBackground || mod.default?.removeBackground || mod.default;

    if (typeof removeBackground !== 'function') {
        throw new Error('Fungsi removeBackground tidak ditemukan di modul');
    }

    logger.info('🤖 Memproses remove background dengan AI lokal...');
    
    // Gunakan require('buffer').Blob agar kompatibel dengan Node.js 16+
    const BlobClass = globalThis.Blob || require('buffer').Blob;
    const blob = new BlobClass([imageBuffer], { type: 'image/jpeg' });
    
    let resultBlob;
    try {
        resultBlob = await removeBackground(blob, {
            model: 'medium',
            output: { format: 'image/png', quality: 0.9 },
        });
    } catch (aiErr) {
        throw new Error(`AI lokal gagal: ${aiErr.message}`);
    }

    const arrayBuffer = await resultBlob.arrayBuffer();
    const resultBuffer = Buffer.from(arrayBuffer);
    logger.info(`✅ AI lokal selesai: ${resultBuffer.length} bytes`);
    return resultBuffer;
}

// ============================================================
// FUNGSI UTAMA: Smart Fallback + API Key Rotation
// ============================================================

/**
 * Hapus background gambar otomatis mencoba API lalu ke lokal jika gagal.
 * Akan merotasi API keys otomatis jika ada yg habis quota/rate limited.
 * 
 * @param {Buffer} imageBuffer
 * @returns {Promise<{buffer: Buffer, method: string, creditsLeft: number|null}>}
 */
async function removeBackgroundImage(imageBuffer) {
    // ---- Coba semua API keys yg tersisa & blm exhausted ----
    while (currentApiKeyIndex < apiKeysStatus.length) {
        const currentApi = apiKeysStatus[currentApiKeyIndex];
        
        if (currentApi.exhausted) {
            currentApiKeyIndex++;
            continue;
        }

        try {
            logger.info(`🌐 Mencoba remove.bg API (Key #${currentApiKeyIndex + 1}) ...`);
            const { buffer, creditsLeft } = await removeViaRemoteBgApi(imageBuffer, currentApi.key);
            
            // Berhasil! Update status kredit
            currentApi.creditsLeft = creditsLeft;
            logger.info(`✅ Key #${currentApiKeyIndex + 1} berhasil | Sisa kredit: ${creditsLeft}`);

            // Kalau kredit habis di hitungan ini, langsung tandai supaya next tidak dipakai lagi
            if (creditsLeft <= 0) {
                currentApi.exhausted = true;
                logger.warn(`⚠️ Kredit remove.bg (Key #${currentApiKeyIndex + 1}) habis!`);
                currentApiKeyIndex++; // Pindah ke key berikutnya jika ada
            }

            return { buffer, method: `remove.bg API (Key #${currentApiKeyIndex + (creditsLeft <= 0 ? 0 : 1)})`, creditsLeft };

        } catch (err) {
            if (err.message === 'QUOTA_EXCEEDED' || err.message === 'RATE_LIMITED') {
                logger.warn(`⚠️ remove.bg (Key #${currentApiKeyIndex + 1}): ${err.message} → Rotasi API Key...`);
                currentApi.exhausted = true;
                currentApiKeyIndex++;
            } else {
                logger.warn(`⚠️ remove.bg error di Key #${currentApiKeyIndex + 1}: ${err.message}`);
                // Jika error lain (bkn quota), jangan rotate key-nya, tpi langsung fallback AI Lokal sj utk skrg
                break;
            }
        }
    }

    // ---- Fallback: AI Lokal (Dipakai kl semua key habis / gk ada key sm sekali) ----
    if (apiKeysStatus.length === 0) {
         logger.info('ℹ️ REMOVEBG_API_KEY tidak ada → langsung pakai AI lokal');
    } else {
         logger.info('ℹ️ Semua API Key remove.bg habis/bermasalah → fallback AI lokal');
    }
    
    const buffer = await removeViaLocalAI(imageBuffer);
    return { buffer, method: 'AI Lokal', creditsLeft: null };
}

/**
 * Cek status API keys
 */
async function checkRemoveBgCredits() {
    return {
        keys: apiKeysStatus,
        activeKeyIndex: currentApiKeyIndex,
        allExhausted: apiKeysStatus.length > 0 && currentApiKeyIndex >= apiKeysStatus.length,
        hasKey: apiKeysStatus.length > 0,
    };
}

/**
 * Reset status semua API Keys
 */
function resetRemoveBgStatus() {
    apiKeysStatus.forEach(api => {
        api.exhausted = false;
        api.creditsLeft = null;
    });
    currentApiKeyIndex = 0;
    logger.info('🔄 Status semua API Key remove.bg direset');
}

// ============================================================
// REMOVE BACKGROUND VIDEO — via FFmpeg chroma key
// Untuk video dengan background warna SOLID
// ============================================================

/**
 * Hapus background video berdasarkan warna dominan (chroma key)
 * Menghasilkan WebP animated sticker transparan
 * 
 * @param {Buffer} videoBuffer
 * @param {string} bgColor      - Warna bg hex tanpa # (default: 'ffffff')
 * @param {number} similarity   - Toleransi 0.0–1.0 (default: 0.3)
 * @param {number} blend        - Kehalusan tepi 0.0–1.0 (default: 0.1)
 * @returns {Promise<Buffer>}   - Buffer WebP animated
 */
async function removeBackgroundVideo(videoBuffer, bgColor = 'ffffff', similarity = 0.15, blend = 0.05) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputPath  = path.join(tempDir, `rmbgv_in_${tempId}.mp4`);
        const outputPath = path.join(tempDir, `rmbgv_out_${tempId}.webp`);

        try {
            fs.writeFileSync(inputPath, videoBuffer);

            const vf = [
                `scale=512:512:force_original_aspect_ratio=decrease`,
                `pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0`,
                `fps=10`,
                `chromakey=0x${bgColor}:${similarity}:${blend}`,
                `format=rgba`
            ].join(',');

            ffmpeg(inputPath)
                .outputOptions([
                    '-vcodec', 'libwebp',
                    '-vf', vf,
                    '-lossless', '0',
                    '-compression_level', '5',
                    '-q:v', '45',
                    '-loop', '0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0',
                    '-t', '8'
                ])
                .toFormat('webp')
                .on('end', () => {
                    try {
                        const outBuffer = fs.readFileSync(outputPath);
                        cleanup(inputPath, outputPath);
                        logger.info(`✅ Remove background video selesai: ${outBuffer.length} bytes`);
                        resolve(outBuffer);
                    } catch (e) {
                        cleanup(inputPath, outputPath);
                        reject(e);
                    }
                })
                .on('error', (err) => {
                    cleanup(inputPath, outputPath);
                    logger.error(`❌ FFmpeg remove bg video gagal: ${err.message}`);
                    reject(err);
                })
                .save(outputPath);

        } catch (e) {
            cleanup(inputPath, outputPath);
            reject(e);
        }
    });
}

// ============================================================
// HELPER: Deteksi warna bg dominan dari sudut-sudut gambar
// ============================================================

/**
 * Deteksi warna background dominan dari frame gambar
 * @param {Buffer} frameBuffer
 * @returns {Promise<string>} Hex color tanpa #
 */
async function detectDominantBgColor(frameBuffer) {
    try {
        const { data, info } = await sharp(frameBuffer)
            .resize(100, 100, { fit: 'fill' })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const w = info.width;
        const ch = info.channels;
        const corners = [
            0,
            (w - 1) * ch,
            (99 * w) * ch,
            (99 * w + w - 1) * ch,
        ];

        let r = 0, g = 0, b = 0;
        for (const idx of corners) {
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
        }
        r = Math.round(r / 4);
        g = Math.round(g / 4);
        b = Math.round(b / 4);

        const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
        logger.info(`🎨 Deteksi warna bg: #${hex}`);
        return hex;
    } catch {
        return 'ffffff';
    }
}

function cleanup(...filePaths) {
    for (const p of filePaths) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
}

function cleanupDir(dirPath) {
    try {
        if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_) {}
}

// ============================================================
// HELPER: Bersihkan alpha channel setelah AI removal
// Menghilangkan piksel semi-transparan di tepi yang menyebabkan efek bayangan
// ============================================================
async function cleanAlphaChannel(pngBuffer) {
    try {
        const { data, info } = await sharp(pngBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const buf = Buffer.from(data);
        for (let i = 3; i < buf.length; i += 4) {
            const a = buf[i];
            if (a < 30) {
                // Piksel hampir transparan → buat sepenuhnya transparan
                buf[i] = 0;
                // Juga hitamkan RGB supaya tidak ada warna tersisa
                buf[i - 3] = 0; buf[i - 2] = 0; buf[i - 1] = 0;
            } else if (a > 220) {
                // Piksel hampir opak → buat sepenuhnya opak
                buf[i] = 255;
            }
            // Zona 30-220: biarkan (feathering edge yang halus)
        }

        return await sharp(buf, {
            raw: { width: info.width, height: info.height, channels: 4 }
        }).png().toBuffer();
    } catch (_) {
        return pngBuffer; // fallback jika gagal
    }
}

// ============================================================
// HELPER: Patch binary WebP — paksa DO_NOT_BLEND + BACKGROUND disposal
// Fix definitif untuk efek bayangan/ghost di animated sticker.
//
// WebP ANMF flags byte (offset 23 per chunk):
//   Bit 1 (0x02): Blending  (0=DO_NOT_BLEND, 1=BLEND)  ← harus 0
//   Bit 0 (0x01): Disposal  (0=NONE, 1=BACKGROUND)      ← harus 1
//
// Dengan DO_NOT_BLEND: tiap frame MENGGANTI frame lama (tidak di-blend)
// Dengan BACKGROUND:   setelah frame tampil, kanvas dibersihkan jadi transparan
// Hasilnya: tidak ada ghost/bayangan frame-frame sebelumnya.
// ============================================================
function fixWebPAnimationFlags(webpBuffer) {
    const buf = Buffer.from(webpBuffer);
    if (
        buf.length < 12 ||
        buf.toString('ascii', 0, 4) !== 'RIFF' ||
        buf.toString('ascii', 8, 12) !== 'WEBP'
    ) return webpBuffer;

    let pos = 12;
    let patched = 0;
    while (pos + 8 <= buf.length) {
        const fourCC  = buf.toString('ascii', pos, pos + 4);
        const chunkSz = buf.readUInt32LE(pos + 4);
        if (fourCC === 'ANMF') {
            // Struktur ANMF data (setelah 8-byte RIFF header):
            // 0-2: X,  3-5: Y,  6-8: W,  9-11: H,  12-14: Duration,  15: Flags
            const flagsOff = pos + 8 + 15;
            if (flagsOff < buf.length) {
                buf[flagsOff] = 0x01; // DO_NOT_BLEND(bit1=0) + BACKGROUND(bit0=1)
                patched++;
            }
        }
        const advance = 8 + chunkSz + (chunkSz & 1);
        if (advance <= 8) break;
        pos += advance;
    }
    logger.info(`🔧 Patch WebP: ${patched} ANMF frame → DO_NOT_BLEND+BACKGROUND`);
    return buf;
}

// ============================================================
// REMOVE BACKGROUND VIDEO — via AI (frame-by-frame)
// Akurat untuk semua jenis background, tidak butuh solid color
// Waktu: ~3-5 detik per frame (tergantung hardware)
// ============================================================

/**
 * Hapus background video menggunakan AI (frame-by-frame)
 * Hasilkan animated WebP sticker transparan
 *
 * @param {Buffer} videoBuffer
 * @returns {Promise<Buffer>} - Buffer WebP animated
 */
async function removeBackgroundVideoAI(videoBuffer) {
    const tempId  = randomBytes(6).toString('hex');
    const tempDir = path.join(__dirname, '../../temp');
    const workDir = path.join(tempDir, `ai_rmbgv_${tempId}`);
    const framesDir   = path.join(workDir, 'frames');
    const processedDir = path.join(workDir, 'processed');

    fs.mkdirSync(framesDir,    { recursive: true });
    fs.mkdirSync(processedDir, { recursive: true });

    const inputPath  = path.join(workDir, 'input.mp4');
    const outputPath = path.join(workDir, 'output.webp');

    try {
        fs.writeFileSync(inputPath, videoBuffer);

        // --- Step 1: Ekstrak frame 5fps, maks 6 detik ---
        logger.info('🎬 Step 1/3 — Ekstrak frame video...');
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black,fps=5',
                    '-t', '6'
                ])
                .output(path.join(framesDir, 'frame_%04d.png'))
                .on('end',   resolve)
                .on('error', reject)
                .run();
        });

        const frameFiles = fs.readdirSync(framesDir)
            .filter(f => f.endsWith('.png'))
            .sort();

        if (frameFiles.length === 0) {
            throw new Error('Tidak ada frame yang berhasil diekstrak dari video');
        }

        logger.info(`🎬 Step 2/3 — Proses AI pada ${frameFiles.length} frame...`);

        // --- Step 2: Muat AI dan proses tiap frame ---
        const mod = await loadLocalBgRemoval();
        const removeBackground = mod.removeBackground || mod.default?.removeBackground || mod.default;
        if (typeof removeBackground !== 'function') {
            throw new Error('Module AI remove background tidak tersedia');
        }

        const BlobClass = globalThis.Blob || require('buffer').Blob;

        for (let i = 0; i < frameFiles.length; i++) {
            const framePath = path.join(framesDir, frameFiles[i]);
            const frameBuffer = fs.readFileSync(framePath);

            const blob = new BlobClass([frameBuffer], { type: 'image/png' });
            let resultBlob;
            try {
                resultBlob = await removeBackground(blob, {
                    model: 'small', // lebih cepat dari 'medium'
                    output: { format: 'image/png', quality: 0.85 },
                });
            } catch (frameErr) {
                logger.warn(`⚠️ Frame ${i + 1} gagal, pakai frame original: ${frameErr.message}`);
                fs.copyFileSync(framePath, path.join(processedDir, frameFiles[i]));
                continue;
            }

            const rawResult = Buffer.from(await resultBlob.arrayBuffer());
            // Bersihkan alpha channel: hapus piksel semi-transparan di tepi
            const resultBuffer = await cleanAlphaChannel(rawResult);
            fs.writeFileSync(path.join(processedDir, frameFiles[i]), resultBuffer);
            logger.info(`🖼️ Frame ${i + 1}/${frameFiles.length} selesai`);
        }

        // --- Step 3: Gabungkan frame jadi animated WebP ---
        // PENTING: -r 5 di OUTPUT harus eksplisit, -vsync dihapus untuk mencegah ghosting
        // Setiap frame disimpan sebagai full keyframe dengan -q:v 85
        logger.info('🎬 Step 3/3 — Menggabungkan frame menjadi animated sticker...');
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(path.join(processedDir, 'frame_%04d.png'))
                .inputOptions(['-framerate', '5', '-start_number', '1'])
                .outputOptions([
                    '-vcodec', 'libwebp',
                    '-r', '5',          // output frame rate eksplisit
                    '-loop', '0',
                    '-lossless', '0',
                    '-q:v', '85',       // kualitas tinggi = lebih sedikit artifak
                    '-preset', 'picture',
                    '-an',
                    // Tidak pakai -vsync 0 karena bisa menyebabkan frame duplikasi
                ])
                .toFormat('webp')
                .on('end',   resolve)
                .on('error', reject)
                .save(outputPath);
        });

        const rawResult = fs.readFileSync(outputPath);
        // PATCH: Fix animation flags supaya tidak ada ghost dari frame sebelumnya
        const result = fixWebPAnimationFlags(rawResult);
        logger.info(`✅ AI video remove bg selesai: ${result.length} bytes`);
        return result;
    } finally {
        cleanupDir(workDir);
    }
}

module.exports = {
    removeBackgroundImage,
    removeBackgroundVideo,
    removeBackgroundVideoAI,
    detectDominantBgColor,
    checkRemoveBgCredits,
    resetRemoveBgStatus,
};
