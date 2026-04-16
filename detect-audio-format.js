/**
 * SCRIPT DETEKSI FORMAT AUDIO
 * Gunakan ini untuk mendeteksi format audio dari file WAV/OGG/MP3/dsb
 * 
 * Cara pakai:
 *   node detect-audio-format.js <path_ke_file_audio>
 *   node detect-audio-format.js test_output.ogg
 * 
 * Atau jalankan saja tanpa argumen untuk test file test_output.ogg yang ada
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =============================================
// CEK MAGIC BYTES (tanpa ffprobe)
// =============================================
function detectByMagicBytes(buffer) {
    const hex4 = buffer.slice(0, 4).toString('hex').toUpperCase();
    const hex8 = buffer.slice(0, 8).toString('hex').toUpperCase();
    const str4 = buffer.slice(0, 4).toString('ascii');
    const str8 = buffer.slice(0, 8).toString('ascii');

    // OGG
    if (str4 === 'OggS') {
        // Cek apakah isinya Opus atau Vorbis
        const opusMagic = buffer.indexOf(Buffer.from('OpusHead'));
        const vorbisMagic = buffer.indexOf(Buffer.from('\x01vorbis'));
        if (opusMagic !== -1 && opusMagic < 100) return { container: 'OGG', codec: 'Opus', mimetype: 'audio/ogg; codecs=opus' };
        if (vorbisMagic !== -1 && vorbisMagic < 100) return { container: 'OGG', codec: 'Vorbis', mimetype: 'audio/ogg' };
        return { container: 'OGG', codec: 'Unknown', mimetype: 'audio/ogg' };
    }

    // MP3
    if (str4.startsWith('ID3') || hex4 === 'FFFB' || hex4 === 'FFF3' || hex4 === 'FFF2') {
        return { container: 'MP3', codec: 'MP3', mimetype: 'audio/mpeg' };
    }

    // MP4 / M4A
    if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.slice(8, 12).toString('ascii');
        if (brand === 'M4A ' || brand === 'M4B ') return { container: 'MP4', codec: 'AAC', mimetype: 'audio/mp4' };
        return { container: 'MP4', codec: 'AAC/Unknown', mimetype: 'audio/mp4' };
    }

    // WAV
    if (str4 === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WAVE') {
        return { container: 'WAV', codec: 'PCM', mimetype: 'audio/wav' };
    }

    // FLAC
    if (str4 === 'fLaC') {
        return { container: 'FLAC', codec: 'FLAC', mimetype: 'audio/flac' };
    }

    // WebM / Matroska
    if (hex4 === '1A45DFA3') {
        return { container: 'WebM/MKV', codec: 'Unknown', mimetype: 'audio/webm' };
    }

    // SILK (format WhatsApp voice note asli — dari WA ke WA)
    // SILK v3 header: 02 53 49 4C 4B 20 76 33
    if (buffer.slice(1, 5).toString('ascii') === 'SILK') {
        return { container: 'SILK', codec: 'SILK', mimetype: 'audio/silk', note: 'Format asli WhatsApp voice note!' };
    }

    return { container: 'Unknown', codec: 'Unknown', mimetype: 'application/octet-stream', rawHex: hex8 };
}

// =============================================
// CEK DENGAN FFPROBE (lebih detail)
// =============================================
function detectWithFFprobe(filePath) {
    try {
        const result = execSync(
            `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`,
            { timeout: 10000 }
        ).toString();
        const info = JSON.parse(result);
        const audioStream = info.streams?.find(s => s.codec_type === 'audio');
        return {
            format: info.format?.format_name,
            duration: parseFloat(info.format?.duration || 0).toFixed(2) + ' detik',
            bitrate: Math.round((info.format?.bit_rate || 0) / 1000) + ' kbps',
            codec: audioStream?.codec_name,
            codecLong: audioStream?.codec_long_name,
            sampleRate: audioStream?.sample_rate + ' Hz',
            channels: audioStream?.channels,
            channelLayout: audioStream?.channel_layout,
        };
    } catch (e) {
        return { error: 'ffprobe tidak tersedia atau gagal: ' + e.message };
    }
}

// =============================================
// MAIN
// =============================================
async function main() {
    const filePath = process.argv[2] || path.join(__dirname, 'test_output.ogg');

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File tidak ditemukan: ${filePath}`);
        console.log('\n💡 Cara pakai:');
        console.log('   node detect-audio-format.js <path_file_audio>');
        console.log('   node detect-audio-format.js test_output.ogg');
        process.exit(1);
    }

    const buffer = fs.readFileSync(filePath);
    const fileSize = (buffer.length / 1024).toFixed(1) + ' KB';
    const ext = path.extname(filePath).toUpperCase();

    console.log('\n========================================');
    console.log('  🔍 DETEKSI FORMAT AUDIO');
    console.log('========================================');
    console.log(`📁 File    : ${path.basename(filePath)}`);
    console.log(`📦 Ukuran  : ${fileSize}`);
    console.log(`🔖 Ekstensi: ${ext || '(tidak ada)'}`);

    console.log('\n--- Deteksi Magic Bytes ---');
    const magic = detectByMagicBytes(buffer);
    console.log(`📦 Container : ${magic.container}`);
    console.log(`🎵 Codec     : ${magic.codec}`);
    console.log(`📋 MIME Type : ${magic.mimetype}`);
    if (magic.rawHex) console.log(`🔢 Raw Hex   : ${magic.rawHex}`);
    if (magic.note) console.log(`⭐ Note      : ${magic.note}`);

    console.log('\n--- Deteksi FFprobe (detail) ---');
    const ffInfo = detectWithFFprobe(filePath);
    if (ffInfo.error) {
        console.log(`⚠️  ${ffInfo.error}`);
    } else {
        console.log(`📦 Format    : ${ffInfo.format}`);
        console.log(`🎵 Codec     : ${ffInfo.codec} (${ffInfo.codecLong})`);
        console.log(`⏱️  Durasi    : ${ffInfo.duration}`);
        console.log(`📡 Bitrate   : ${ffInfo.bitrate}`);
        console.log(`🔊 Sample    : ${ffInfo.sampleRate}`);
        console.log(`📢 Channels  : ${ffInfo.channels} (${ffInfo.channelLayout})`);
    }

    // =============================================
    // ANALISIS KOMPATIBILITAS WHATSAPP CHANNEL
    // =============================================
    console.log('\n--- Analisis Kompatibilitas WhatsApp ---');

    const codec = (ffInfo.codec || magic.codec || '').toLowerCase();
    const container = (ffInfo.format || magic.container || '').toLowerCase();
    const sampleRate = parseInt(ffInfo.sampleRate || '0');
    const channels = parseInt(ffInfo.channels || '0');

    let status = '';
    let tips = [];

    if (codec === 'opus' && container.includes('ogg')) {
        if (sampleRate === 48000 && channels === 1) {
            status = '✅ KOMPATIBEL — Format ideal untuk WhatsApp voice note (OGG Opus 48k Mono)';
        } else {
            status = '⚠️ HAMPIR KOMPATIBEL — OGG Opus tapi sample rate/channel mungkin salah';
            if (sampleRate !== 48000) tips.push(`Sample rate harus 48000Hz (sekarang: ${sampleRate}Hz)`);
            if (channels !== 1) tips.push(`Channel harus Mono/1 (sekarang: ${channels})`);
        }
    } else if (codec === 'opus' && container.includes('webm')) {
        status = '⚠️ MUNGKIN ERROR — WebM Opus tidak dikenal WhatsApp Channel sebagai voice note';
        tips.push('Konversi ke OGG Opus: ffmpeg -i input.webm -c:a libopus -ar 48000 -ac 1 output.ogg');
    } else if (codec === 'mp3' || codec === 'mpeg') {
        status = '❌ TIDAK KOMPATIBEL sebagai PTT — MP3 tidak bisa diplay di WhatsApp Channel sebagai voice note';
        tips.push('Gunakan format: audio/mp4 atau audio/aac (kirim sebagai dokumen audio, bukan PTT)');
        tips.push('Atau konversi ke OGG Opus dengan FFmpeg');
    } else if (codec === 'aac') {
        status = '⚠️ KOMPATIBEL sebagai audio file (bukan PTT) — MIME: audio/mp4';
        tips.push('Kirim dengan mimetype "audio/mp4" dan ptt: false untuk tampil sebagai audio di channel');
    } else if (magic.container === 'SILK') {
        status = '✅ FORMAT SILK — Format asli voice note WhatsApp! Harusnya kompatibel';
        tips.push('Ini adalah format yang digunakan saat kamu send voice note langsung dari WhatsApp');
    } else {
        status = `❓ TIDAK DIKETAHUI — Codec: ${codec}, Container: ${container}`;
        tips.push('Coba konversi ulang dengan FFmpeg ke OGG Opus');
    }

    console.log(status);
    if (tips.length > 0) {
        console.log('\n💡 Tips:');
        tips.forEach(t => console.log('   •', t));
    }

    console.log('\n--- Rekomendasi untuk WhatsApp Channel ---');
    console.log('Format yang TERBUKTI bisa diplay di WhatsApp Channel:');
    console.log('  1️⃣  audio/mp4 (AAC) → ptt: false  [sebagai audio file, berjalan lancar]');
    console.log('  2️⃣  audio/ogg; codecs=opus → ptt: true  [voice note, kadang bermasalah di old WA]');
    console.log('  3️⃣  audio/mpeg (MP3) → ptt: false  [sebagai audio document, tergantung client]');
    console.log('\n🔑 SOLUSI TERBAIK untuk Channel:');
    console.log('  Kirim MP3 asli dari TikTok sebagai AUDIO DOCUMENT (bukan PTT/voice note)');
    console.log('  dengan mimetype: "audio/mpeg" dan ptt: false');
    console.log('========================================\n');
}

main().catch(console.error);
