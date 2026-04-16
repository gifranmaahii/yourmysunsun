/**
 * Test konversi audio: OGG Opus (mono) & MP3
 * Output akan dicek dengan detect-audio-format.js
 */
const { convertToOggOpus, convertToMp3 } = require('./src/utils/audioConverter');
const fs = require('fs');
const path = require('path');

async function test() {
    try {
        console.log('⬇️  Download sample MP3...');
        const response = await fetch('https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3');
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`✅ Download sukses: ${(buffer.length / 1024).toFixed(1)} KB`);

        // ---- Test OGG Opus (untuk PTT / voice note ke user) ----
        console.log('\n🔄 Konversi ke OGG Opus (mono 48kHz)...');
        const oggBuffer = await convertToOggOpus(buffer);
        fs.writeFileSync('test_output.ogg', oggBuffer);
        console.log(`✅ test_output.ogg → ${(oggBuffer.length / 1024).toFixed(1)} KB`);

        // ---- Test MP3 (untuk audio document ke channel) ----
        console.log('\n🔄 Konversi ke MP3 (stereo 44.1kHz 128kbps)...');
        const mp3Buffer = await convertToMp3(buffer);
        fs.writeFileSync('test_output.mp3', mp3Buffer);
        console.log(`✅ test_output.mp3 → ${(mp3Buffer.length / 1024).toFixed(1)} KB`);

        console.log('\n✅ Semua konversi berhasil!');
        console.log('\n--- Deteksi Format ---');
        console.log('Jalankan: node detect-audio-format.js test_output.ogg');
        console.log('Jalankan: node detect-audio-format.js test_output.mp3');

    } catch (e) {
        console.error('❌ Gagal:', e.message);
        console.error(e.stack);
    }
}

test();
