/**
 * HD Enhancer — Tingkatkan kualitas foto & video
 * 
 * Foto:  Upscale resolusi + sharpen + denoise menggunakan sharp
 * Video: Upscale resolusi + sharpen + denoise menggunakan ffmpeg
 * 
 * Menghasilkan output yang benar-benar HD (minimal 1920px sisi terpanjang)
 */

const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { randomBytes } = require('crypto');

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');

// Pastikan folder temp ada
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Enhance foto menjadi HD
 * - Upscale ke minimal 2048px di sisi terpanjang (jika lebih kecil)
 * - Sharpen (unsharp mask) untuk ketajaman
 * - Denoise ringan (median filter)
 * - Output JPEG kualitas 95% atau PNG
 * 
 * @param {Buffer} imageBuffer - Buffer gambar input
 * @param {Object} options - Opsi tambahan
 * @param {number} options.targetSize - Target resolusi sisi terpanjang (default: 2048)
 * @param {number} options.quality - Kualitas JPEG output (default: 95)
 * @param {boolean} options.asPng - Output sebagai PNG (default: false)
 * @returns {Promise<{buffer: Buffer, width: number, height: number, originalWidth: number, originalHeight: number}>}
 */
async function enhanceImageHD(imageBuffer, options = {}) {
    const {
        targetSize = 3840, // Paksa resolusi tinggi (4K) agar WhatsApp memunculkan logo HD
        quality = 100,     // Kualitas maksimal
        asPng = false,
    } = options;

    // Baca metadata gambar asli
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    if (!originalWidth || !originalHeight) {
        throw new Error('Tidak bisa membaca resolusi gambar');
    }

    // Hitung skala upscale
    const longestSide = Math.max(originalWidth, originalHeight);
    // Minimal target 3840px (4K) agar kedeteksi HD oleh WhatsApp
    const effectiveTarget = Math.max(targetSize, longestSide * 2);
    // Batasi maksimal 6000px
    const finalTarget = Math.min(effectiveTarget, 6000);

    let pipeline = sharp(imageBuffer);

    // Step 1: Upscale dengan algoritma Lanczos3 (terbaik untuk upscaling)
    if (longestSide < finalTarget) {
        if (originalWidth >= originalHeight) {
            pipeline = pipeline.resize(finalTarget, null, {
                kernel: sharp.kernel.lanczos3,
                withoutEnlargement: false,
            });
        } else {
            pipeline = pipeline.resize(null, finalTarget, {
                kernel: sharp.kernel.lanczos3,
                withoutEnlargement: false,
            });
        }
    }

    // Step 2: Denoise ringan via median filter (radius 3) — mengurangi noise tanpa blur berlebihan
    pipeline = pipeline.median(3);

    // Step 3: Sharpen menggunakan unsharp mask — menambah ketajaman detail
    // sigma: radius blur (1.0 = cukup tajam), flat: area datar (1.0), jagged: area detail (2.0)
    pipeline = pipeline.sharpen({
        sigma: 1.0,
        m1: 1.0,   // flat areas sharpening
        m2: 2.0,   // jagged/detail areas sharpening
    });

    // Step 4: Normalize contrast (auto levels) — perbaiki kontras secara otomatis
    pipeline = pipeline.normalize();

    // Step 5: Sedikit tingkatkan saturasi warna via modulate
    pipeline = pipeline.modulate({
        brightness: 1.02,    // sedikit lebih terang
        saturation: 1.1,     // warna lebih hidup
    });

    // Step 6: Output
    let outputBuffer;
    if (asPng) {
        outputBuffer = await pipeline.png({ quality: 100 }).toBuffer();
    } else {
        outputBuffer = await pipeline
            .jpeg({
                quality,
                chromaSubsampling: '4:4:4',  // Full chroma = warna lebih detail
                mozjpeg: true,               // Kompresi optimal
            })
            .toBuffer();
    }

    // Dapatkan resolusi output
    const outputMeta = await sharp(outputBuffer).metadata();

    return {
        buffer: outputBuffer,
        width: outputMeta.width,
        height: outputMeta.height,
        originalWidth,
        originalHeight,
    };
}


/**
 * Enhance video menjadi HD menggunakan ffmpeg
 * - Upscale ke 1920px (sisi terpanjang) jika lebih kecil
 * - Sharpen via unsharp filter
 * - Denoise via hqdn3d filter
 * - Encode H.264 dengan CRF rendah (kualitas tinggi)
 * 
 * @param {Buffer} videoBuffer - Buffer video input
 * @param {Object} options - Opsi tambahan
 * @param {number} options.targetWidth - Target lebar (default: 1920)
 * @param {number} options.crf - CRF quality (default: 18, lower = better)
 * @returns {Promise<{buffer: Buffer, duration: number}>}
 */
async function enhanceVideoHD(videoBuffer, options = {}) {
    const {
        targetWidth = 2560, // Paksa ke 2K resolusi
        crf = 16, // Kualitas sangat tinggi
    } = options;

    const tempId = randomBytes(6).toString('hex');
    const inputPath = path.join(TEMP_DIR, `hd_in_${tempId}.mp4`);
    const outputPath = path.join(TEMP_DIR, `hd_out_${tempId}.mp4`);

    // Tulis input ke file temp
    fs.writeFileSync(inputPath, videoBuffer);

    return new Promise((resolve, reject) => {
        // Baca info video dulu
        ffmpeg.ffprobe(inputPath, (err, probeData) => {
            if (err) {
                cleanup(inputPath, outputPath);
                return reject(new Error('Gagal membaca info video: ' + err.message));
            }

            const videoStream = probeData.streams.find(s => s.codec_type === 'video');
            if (!videoStream) {
                cleanup(inputPath, outputPath);
                return reject(new Error('Tidak ditemukan stream video'));
            }

            const origW = videoStream.width;
            const origH = videoStream.height;
            const duration = parseFloat(probeData.format.duration) || 0;

            // Batasi durasi video HD (maks 60 detik agar tidak terlalu lama)
            if (duration > 60) {
                cleanup(inputPath, outputPath);
                return reject(new Error('Durasi video maksimal 60 detik untuk fitur HD'));
            }

            // Hitung resolusi output (maks 2560 agar 2K / 1440p)
            let outW, outH;
            if (origW >= origH) {
                // Landscape
                outW = Math.max(origW, Math.min(targetWidth, 2560));
                outH = Math.round(outW * (origH / origW));
            } else {
                // Portrait
                outH = Math.max(origH, Math.min(targetWidth, 2560));
                outW = Math.round(outH * (origW / origH));
            }
            // Pastikan genap (requirement H.264)
            outW = outW % 2 === 0 ? outW : outW + 1;
            outH = outH % 2 === 0 ? outH : outH + 1;

            // Build filter chain:
            // 1. Scale dengan lanczos (terbaik untuk upscale)
            // 2. unsharp = sharpen (luma 5x5 strength 0.8, chroma 3x3 strength 0.3)
            // 3. hqdn3d = high quality denoise (ringan)
            const videoFilters = [
                `scale=${outW}:${outH}:flags=lanczos`,
                `unsharp=5:5:0.8:3:3:0.3`,
                `hqdn3d=3:2:3:2`,
                // Color correction: sedikit tingkatkan contrast & saturation
                `eq=contrast=1.05:saturation=1.1:brightness=0.02`,
            ];

            const command = ffmpeg(inputPath)
                .videoFilters(videoFilters)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'slow',       // Slower preset = better quality
                    '-crf', String(crf),      // CRF rendah = kualitas tinggi
                    '-maxrate', '8M',         // Paksa bitrate tinggi agar file cukup besar untuk diakui HD
                    '-bufsize', '16M',
                    '-profile:v', 'high',     // High profile untuk kualitas terbaik
                    '-level', '4.2',
                    '-pix_fmt', 'yuv420p',    // Kompatibilitas maksimal
                    '-movflags', '+faststart', // Quick playback start
                    '-c:a', 'aac',            // Audio AAC
                    '-b:a', '192k',           // Bitrate audio tinggi
                    '-ar', '44100',           // Sample rate
                ])
                .on('end', () => {
                    try {
                        const outBuffer = fs.readFileSync(outputPath);
                        cleanup(inputPath, outputPath);
                        resolve({
                            buffer: outBuffer,
                            duration: Math.round(duration),
                            originalWidth: origW,
                            originalHeight: origH,
                            outputWidth: outW,
                            outputHeight: outH,
                        });
                    } catch (e) {
                        cleanup(inputPath, outputPath);
                        reject(new Error('Gagal membaca output video HD'));
                    }
                })
                .on('error', (ffErr) => {
                    cleanup(inputPath, outputPath);
                    reject(new Error('FFmpeg error: ' + ffErr.message));
                })
                .save(outputPath);
        });
    });
}

/**
 * Cleanup file temp
 */
function cleanup(...paths) {
    for (const p of paths) {
        try { fs.unlinkSync(p); } catch (_) {}
    }
}

module.exports = {
    enhanceImageHD,
    enhanceVideoHD,
};
