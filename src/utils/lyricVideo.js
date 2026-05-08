const { createCanvas } = require('@napi-rs/canvas');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

/**
 * Generator Video Lirik Aesthetic (Rain Effect + Word by Word)
 * @param {string[]} words - Array kata-kata yang ingin dimunculkan
 * @param {string} outputPath - Lokasi output file mp4
 */
async function generateLyricVideo(words, outputPath) {
    const width = 720;
    const height = 720;
    const fps = 10; // Frame per second (cukup untuk estetika lirik)
    const durationPerWord = 1.5; // Detik per kata muncul
    const totalDuration = words.length * durationPerWord + 2; // +2 detik ending
    const totalFrames = totalDuration * fps;

    const tempDir = path.join(__dirname, '../../temp_frames');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    console.log(`Generating ${totalFrames} frames for ${words.length} words...`);

    // Inisialisasi rintik hujan (statis di awal, nanti diupdate per frame)
    let raindrops = [];
    for (let i = 0; i < 40; i++) {
        raindrops.push({
            x: Math.random() * width,
            y: Math.random() * height,
            length: Math.random() * 40 + 20,
            speed: Math.random() * 15 + 10
        });
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let f = 0; f < totalFrames; f++) {
        const currentTime = f / fps;
        
        // 1. Gambar Background Krem (Sama dengan gambar user)
        ctx.fillStyle = '#f5e6d3';
        ctx.fillRect(0, 0, width, height);

        // 2. Gambar Rain Effect (Garis vertikal tipis)
        ctx.strokeStyle = 'rgba(74, 44, 42, 0.15)'; // Warna cokelat tipis
        ctx.lineWidth = 1;
        raindrops.forEach(rain => {
            ctx.beginPath();
            ctx.moveTo(rain.x, rain.y);
            ctx.lineTo(rain.x, rain.y + rain.length);
            ctx.stroke();

            // Update posisi hujan untuk frame berikutnya
            rain.y += rain.speed;
            if (rain.y > height) {
                rain.y = -rain.length;
                rain.x = Math.random() * width;
            }
        });

        // 3. Logika Muncul Kata-per-Kata
        ctx.fillStyle = '#4a2c2a'; // Warna cokelat tua (Exact match)
        ctx.font = 'bold 65px serif'; // Serif font
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let wordsToShow = Math.floor(currentTime / durationPerWord) + 1;
        if (wordsToShow > words.length) wordsToShow = words.length;

        // Tampilkan kata secara bertumpuk ke bawah (seperti di gambar "holdin' your hand")
        for (let i = 0; i < wordsToShow; i++) {
            const yPos = (height / 2) - ((wordsToShow - 1) * 40) + (i * 80);
            
            // Efek rintik hujan pada tulisan (kita gambar garis putih tipis di atas tulisan)
            ctx.fillText(words[i].toUpperCase(), width / 2, yPos);
            
            // Overlap rintik air pada teks
            ctx.strokeStyle = 'rgba(245, 230, 211, 0.4)';
            ctx.lineWidth = 2;
            for(let j=0; j<3; j++) {
                let rx = (width/2 - 100) + Math.random() * 200;
                ctx.beginPath();
                ctx.moveTo(rx, yPos - 30);
                ctx.lineTo(rx, yPos + 30);
                ctx.stroke();
            }
        }

        // Simpan frame
        const buffer = canvas.toBuffer('image/jpeg');
        fs.writeFileSync(path.join(tempDir, `frame_${String(f).padStart(5, '0')}.jpg`), buffer);
    }

    // 4. Gabungkan Frame jadi Video pakai FFmpeg
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(path.join(tempDir, 'frame_%05d.jpg'))
            .inputFPS(fps)
            .outputOptions([
                '-c:v libx264',
                '-pix_fmt yuv420p',
                '-crf 23'
            ])
            .output(outputPath)
            .on('end', () => {
                // Hapus temp frames
                fs.readdirSync(tempDir).forEach(file => fs.unlinkSync(path.join(tempDir, file)));
                resolve(outputPath);
            })
            .on('error', (err) => reject(err))
            .run();
    });
}

module.exports = { generateLyricVideo };
