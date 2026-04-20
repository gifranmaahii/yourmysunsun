const path = require('path');
const fs = require('fs');
const { randomBytes } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

/**
 * Mengubah buffer sticker webp (diam) menjadi gambar PNG
 */
async function stickerToImage(webpBuffer) {
    return await sharp(webpBuffer).png().toBuffer();
}

/**
 * Mengubah buffer sticker webp (animasi) menjadi video MP4
 */
function stickerToVideo(webpBuffer) {
    return new Promise(async (resolve, reject) => {
        try {
            // FFmpeg versi tertentu tidak support decode animated webp secara native (skipping ANIM chunk).
            // Solusinya: Ubah webp animasi ke GIF menggunakan sharp terlebih dahulu, lalu convert GIF ke MP4.
            const gifBuffer = await sharp(webpBuffer, { animated: true }).gif().toBuffer();

            const tempId = randomBytes(6).toString('hex');
            const tempDir = path.join(__dirname, '../../temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            const inPath = path.join(tempDir, `st_in_${tempId}.gif`);
            const outPath = path.join(tempDir, `st_out_${tempId}.mp4`);

            fs.writeFileSync(inPath, gifBuffer);
            ffmpeg(inPath)
                .outputOptions([
                    '-vcodec libx264',
                    '-pix_fmt yuv420p',
                    '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2', // Pastikan resolusi genap
                    '-preset fast'
                ])
                .on('end', () => {
                    try {
                        const mp4Buffer = fs.readFileSync(outPath);
                        try { fs.unlinkSync(inPath); } catch (_) {}
                        try { fs.unlinkSync(outPath); } catch (_) {}
                        resolve(mp4Buffer);
                    } catch (e) {
                         reject(e);
                    }
                })
                .on('error', (err) => {
                    try { fs.unlinkSync(inPath); } catch (_) {}
                    try { fs.unlinkSync(outPath); } catch (_) {}
                    reject(err);
                })
                .save(outPath);
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    stickerToImage,
    stickerToVideo
};
