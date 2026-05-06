const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { logger } = require('./logger');

/**
 * Konversi audio ke OGG OPUS Mono 48kHz murni
 * Format: OGG container + Opus codec + Mono + 48kHz
 * Ini adalah format PTT (voice note) yang dikenali WhatsApp.
 *
 * PENTING: audioChannels(1) harus EKSPLISIT di-set via outputOptions
 * karena beberapa versi fluent-ffmpeg abaikan .audioChannels()
 *
 * @param {Buffer} audioBuffer - Buffer audio input (MP3, M4A, dll)
 * @returns {Promise<Buffer>} - Buffer OGG Opus Mono 48kHz
 */
async function convertToOggOpus(audioBuffer) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputPath  = path.join(tempDir, `in_${tempId}.tmp`);
        const outputPath = path.join(tempDir, `out_${tempId}.ogg`);

        try {
            fs.writeFileSync(inputPath, audioBuffer);

            ffmpeg(inputPath)
                // Hapus stream video jika ada
                .inputOptions(['-vn'])
                // Output format: OGG container
                .toFormat('ogg')
                // Codec: libopus (wajib untuk WhatsApp voice note)
                .audioCodec('libopus')
                // ⚠️ WAJIB MONO — gunakan outputOptions agar pasti diterapkan
                .outputOptions([
                    '-ac 1',              // Mono (1 channel) — KRITIS!
                    '-ar 48000',          // Sample rate 48000Hz — KRITIS!
                    '-b:a 32k',           // Bitrate 32kbps (cukup untuk voice)
                    '-application voip',  // Optimalkan untuk voice
                    '-frame_duration 20', // Frame 20ms (standar Opus)
                    '-avoid_negative_ts make_zero',
                    '-map_metadata -1',   // Hapus metadata agar file lebih bersih
                    '-vn',               // Double-ensure no video
                ])
                .on('start', (cmd) => logger.info(`🎛️  FFmpeg OGG Opus: ${cmd}`))
                .on('end', () => {
                    try {
                        const outBuffer = fs.readFileSync(outputPath);
                        logger.info(`✅ Konversi OGG Opus selesai: ${outBuffer.length} bytes`);
                        resolve(outBuffer);
                    } catch (e) {
                        reject(e);
                    } finally {
                        if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    }
                })
                .on('error', (err) => {
                    logger.error(`❌ Gagal render OGG Opus: ${err.message}`);
                    if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    reject(err);
                })
                .save(outputPath);
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Konversi audio ke MP3 Mono 44.1kHz untuk dikirim sebagai audio document
 * (bukan PTT) ke WhatsApp Channel.
 *
 * Mengapa ini lebih aman untuk channel?
 * — Channel WhatsApp menerima MP3 sebagai audio playable (bukan download)
 * — Tidak perlu SILK/Opus yang kadang ditolak channel.
 *
 * @param {Buffer} audioBuffer - Buffer audio input
 * @returns {Promise<Buffer>} - Buffer MP3
 */
async function convertToMp3(audioBuffer) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputPath  = path.join(tempDir, `in_${tempId}.tmp`);
        const outputPath = path.join(tempDir, `out_${tempId}.mp3`);

        try {
            fs.writeFileSync(inputPath, audioBuffer);

            ffmpeg(inputPath)
                .inputOptions(['-vn'])
                .toFormat('mp3')
                .audioCodec('libmp3lame')
                .outputOptions([
                    '-ac 2',        // Stereo (lebih natural untuk musik TikTok)
                    '-ar 44100',    // 44.1kHz (standar music)
                    '-b:a 128k',    // 128kbps (kualitas bagus, file tidak terlalu besar)
                    '-q:a 2',       // Quality preset VBR
                    '-map_metadata -1',
                    '-vn',
                    '-id3v2_version 3',
                ])
                .on('start', (cmd) => logger.info(`🎛️  FFmpeg MP3: ${cmd}`))
                .on('end', () => {
                    try {
                        const outBuffer = fs.readFileSync(outputPath);
                        logger.info(`✅ Konversi MP3 selesai: ${outBuffer.length} bytes`);
                        resolve(outBuffer);
                    } catch (e) {
                        reject(e);
                    } finally {
                        if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    }
                })
                .on('error', (err) => {
                    logger.error(`❌ Gagal render MP3: ${err.message}`);
                    if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    reject(err);
                })
                .save(outputPath);
        } catch (e) {
            reject(e);
        }
    });
}

function generateWaveform() {
    // Fake waveform arrays — mencegah bug "Audio Unavailable" di Baileys
    const length = 64;
    const wave   = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        wave[i] = Math.floor(Math.random() * 100);
    }
    return wave;
}

/**
 * Ambil durasi audio dalam detik
 * @param {Buffer} audioBuffer 
 * @returns {Promise<number>}
 */
async function getAudioDuration(audioBuffer) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempPath = path.join(__dirname, '../../temp', `dur_${tempId}.tmp`);
        
        if (!fs.existsSync(path.dirname(tempPath))) {
            fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        }

        try {
            fs.writeFileSync(tempPath, audioBuffer);
            ffmpeg.ffprobe(tempPath, (err, metadata) => {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                if (err) return resolve(0);
                resolve(Math.floor(metadata.format.duration) || 0);
            });
        } catch (e) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            resolve(0);
        }
    });
}

module.exports = {
    convertToOggOpus,
    convertToMp3,
    generateWaveform,
    getAudioDuration,
};
