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
// METODE 2: AI Lokal (DINONAKTIFKAN UNTUK HEMAT STORAGE)
// ============================================================

/**
 * Hapus background gambar otomatis mencoba API.
 * 
 * @param {Buffer} imageBuffer
 * @returns {Promise<{buffer: Buffer, method: string, creditsLeft: number|null}>}
 */
async function removeBackgroundImage(imageBuffer) {
    if (apiKeysStatus.length === 0) {
        throw new Error('❌ Tidak ada API Key remove.bg yang terdeteksi di .env');
    }

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
                break;
            }
        }
    }

    throw new Error('❌ Semua API Key remove.bg sudah habis kuota atau error. Silakan tambah API key baru di .env');
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

/**
 * Hapus background video menggunakan AI (DINONAKTIFKAN)
 */
async function removeBackgroundVideoAI(videoBuffer) {
    throw new Error('❌ Fitur AI Video Remove BG dinonaktifkan untuk menghemat storage VPS. Gunakan fitur chroma key biasa.');
}

module.exports = {
    removeBackgroundImage,
    removeBackgroundVideo,
    removeBackgroundVideoAI,
    detectDominantBgColor,
    checkRemoveBgCredits,
    resetRemoveBgStatus,
};
