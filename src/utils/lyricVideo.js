const { createCanvas } = require('@napi-rs/canvas');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

/**
 * Generator Video Lirik Aesthetic (Rain Effect + Word by Word)
 * @param {string[]} words - Array kata-kata yang ingin dimunculkan
 * @param {string} outputPath - Lokasi output file mp4
 */
async function generateLyricVideo(words, outputPath, isSticker = false) {
    const width = isSticker ? 512 : 720;
    const height = isSticker ? 512 : 720;
    const fps = isSticker ? 8 : 12; // FPS lebih tinggi untuk video agar halus
    const durationPerWord = 1.2; 
    const totalDuration = words.length * durationPerWord + 1;
    const totalFrames = totalDuration * fps;

    const tempDir = path.join(__dirname, '../../temp_frames');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Inisialisasi rintik hujan lebih banyak agar lebih "rainy"
    let raindrops = [];
    for (let i = 0; i < 60; i++) {
        raindrops.push({
            x: Math.random() * width,
            y: Math.random() * height,
            length: Math.random() * 60 + 30,
            speed: Math.random() * 20 + 15,
            opacity: Math.random() * 0.3 + 0.1
        });
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let f = 0; f < totalFrames; f++) {
        const currentTime = f / fps;
        
        // 1. Background Krem (Beige Vintage)
        ctx.fillStyle = '#f2e8cf';
        ctx.fillRect(0, 0, width, height);

        // 2. Tambahkan Noise/Grain agar terasa "film"
        ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
        for(let i=0; i<100; i++) {
            ctx.fillRect(Math.random()*width, Math.random()*height, 2, 2);
        }

        // 3. Logika Muncul Kata-per-Kata (Stacking)
        ctx.fillStyle = '#3d2b1f'; // Cokelat tua estetik
        const fontSize = isSticker ? 45 : 65;
        ctx.font = `bold ${fontSize}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let wordsToShow = Math.floor(currentTime / durationPerWord) + 1;
        if (wordsToShow > words.length) wordsToShow = words.length;

        for (let i = 0; i < wordsToShow; i++) {
            const spacing = isSticker ? 60 : 85;
            const yPos = (height / 2) - ((wordsToShow - 1) * (spacing/2)) + (i * spacing);
            const word = words[i].toUpperCase();
            
            // Gambar Teks Utama
            ctx.globalAlpha = 1.0;
            ctx.fillText(word, width / 2, yPos);

            // 4. Efek "Water Streaks" (Guratan air luntur di tulisan - WAJIB ADA)
            ctx.strokeStyle = '#f2e8cf'; // Warna background untuk "memotong" tulisan
            ctx.lineWidth = 2;
            for(let j=0; j<5; j++) {
                let rx = (width/2 - (word.length * 15)) + Math.random() * (word.length * 30);
                ctx.beginPath();
                ctx.moveTo(rx, yPos - 40);
                ctx.lineTo(rx, yPos + 40);
                ctx.globalAlpha = Math.random() * 0.6;
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1.0;

        // 5. Gambar Rain Effect (Garis vertikal jatuh)
        ctx.strokeStyle = 'rgba(61, 43, 31, 0.2)'; // Warna cokelat rintik
        ctx.lineWidth = 1.5;
        raindrops.forEach(rain => {
            ctx.beginPath();
            ctx.globalAlpha = rain.opacity;
            ctx.moveTo(rain.x, rain.y);
            ctx.lineTo(rain.x, rain.y + rain.length);
            ctx.stroke();

            // Gerakan hujan
            rain.y += rain.speed;
            if (rain.y > height) {
                rain.y = -rain.length;
                ctx.globalAlpha = 1.0;
                rain.x = Math.random() * width;
            }
        });
        ctx.globalAlpha = 1.0;

        // Simpan frame
        const buffer = canvas.toBuffer(isSticker ? 'image/png' : 'image/jpeg');
        fs.writeFileSync(path.join(tempDir, `frame_${String(f).padStart(5, '0')}.${isSticker ? 'png' : 'jpg'}`), buffer);
    }

    // 6. Merakit jadi Video atau WebP (Sticker)
    return new Promise((resolve, reject) => {
        const ff = ffmpeg()
            .input(path.join(tempDir, `frame_%05d.${isSticker ? 'png' : 'jpg'}`))
            .inputFPS(fps);

        if (isSticker) {
            // Output STICKER (WebP)
            ff.outputOptions([
                '-vcodec libwebp',
                '-lossless 0',
                '-compression_level 4',
                '-q:v 70',
                '-loop 0',
                '-preset default',
                '-an',
                '-vsync 0'
            ])
            .output(outputPath)
            .on('end', () => {
                cleanTemp(tempDir);
                resolve(outputPath);
            })
            .on('error', (err) => reject(err))
            .run();
        } else {
            // Output VIDEO (MP4)
            ff.outputOptions([
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-crf 23',
                '-preset faster'
            ])
            .output(outputPath)
            .on('end', () => {
                cleanTemp(tempDir);
                resolve(outputPath);
            })
            .on('error', (err) => reject(err))
            .run();
        }
    });
}

function cleanTemp(dir) {
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
    }
}

module.exports = { generateLyricVideo };
