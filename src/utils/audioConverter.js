const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { logger } = require('./logger');

/**
 * Konversi audio ke format OGG dengan codec OPUS
 * Ini wajib digunakan agar WA bisa memutar sound tersebut sebagai Voice Note / Audio WA
 * @param {Buffer} audioBuffer 
 * @returns {Promise<Buffer>}
 */
async function convertToOggOpus(audioBuffer) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');
        
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const inputPath = path.join(tempDir, `in_${tempId}.tmp`);
        const outputPath = path.join(tempDir, `out_${tempId}.ogg`);
        
        try {
            // Tulis buffer ke file temp
            fs.writeFileSync(inputPath, audioBuffer);

            ffmpeg(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .on('end', () => {
                    try {
                        const outBuffer = fs.readFileSync(outputPath);
                        resolve(outBuffer);
                    } catch (e) {
                        reject(e);
                    } finally {
                        // Bersihkan file temp
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    }
                })
                .on('error', (err) => {
                    logger.error(`❌ Gagal render audio dengan FFmpeg: ${err.message}`);
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    reject(err);
                })
                .save(outputPath);
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = {
    convertToOggOpus
};
