const fetch = require('node-fetch');
const { generateLyricVideo } = require('../utils/lyricVideo');
const path = require('path');
const fs = require('fs');

/**
 * Fitur Lirik Lagu (Auto-Parsing Romaji/Kanji/Indo)
 * Menggunakan Kaizen API
 */
async function handleLyrics(sock, remoteJid, msg, textContent, prefix) {
    const command = textContent.toLowerCase().split(' ')[0];
    const isVideo = command.includes('vid') || command.includes('video');
    const isSticker = command.includes('stiker') || command.includes('sticker');
    const targetCmds = [prefix + 'lirik', prefix + 'lyrics', prefix + 'lirikvid', prefix + 'lirikvideo', prefix + 'lirikstiker', prefix + 'liriksticker'];
    
    if (!targetCmds.some(cmd => command.startsWith(cmd))) return false;

    const query = textContent.slice(command.length).trim();
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text;

    // Jika perintah video atau stiker, cek apakah ada teks manual atau reply
    if (isVideo || isSticker) {
        let videoText = '';
        let manualWords = null;

        // 1. Cek dari Reply
        if (quotedText) {
            videoText = quotedText;
            manualWords = videoText.split(/\s+/).slice(0, 15);
        } 
        // 2. Cek dari Koma (Permintaan Khusus User: .liriksticker kata1, kata2, kata3)
        else if (query && query.includes(',')) {
            manualWords = query.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
        // 3. Cek Teks Panjang
        else if (query && query.length > 20) {
            videoText = query;
            manualWords = videoText.split(/\s+/).slice(0, 15);
        }

        if (manualWords && manualWords.length > 0) {
            try { await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } }); } catch (e) {}
            const ext = isSticker ? 'webp' : 'mp4';
            const outPath = path.join(__dirname, `../../temp_lirik_${Date.now()}.${ext}`);
            await sock.sendMessage(remoteJid, { text: `⏳ Sedang merender ${isSticker ? 'stiker' : 'video'} lirik manual kamu...` }, { quoted: msg });
            
            try {
                await generateLyricVideo(manualWords, outPath, isSticker);
                const sendObj = isSticker ? { sticker: fs.readFileSync(outPath) } : { video: fs.readFileSync(outPath), caption: `🎥 *Video Lirik Manual Berhasil!*`, mimetype: 'video/mp4' };
                await sock.sendMessage(remoteJid, sendObj, { quoted: msg });
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            } catch (err) {
                console.error('Render Error:', err);
                await sock.sendMessage(remoteJid, { text: '❌ Gagal merender. Pastikan VPS tidak penuh.' }, { quoted: msg });
            }
            return true;
        }
    }

    if (!query && !quotedText) {
        await sock.sendMessage(remoteJid, { text: `❌ Format salah!\nContoh: *${command} kata1, kata2, kata3* atau reply teks.` }, { quoted: msg });
        return true;
    }

    // React loading
    try { await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } }); } catch (e) {}

    let lyricData = null;
    let source = '';

    // --- API 1: LOLHUMAN (Paling Akurat untuk Lagu Umum Indo/Barat) ---
    try {
        const apikey = process.env.LOLHUMAN_API_KEY;
        const res = await fetch(`https://api.lolhuman.xyz/api/lirik?apikey=${apikey}&query=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (json.status === 200 && json.result && json.result.length > 50) {
            lyricData = {
                title: query,
                lyrics: json.result
            };
            source = 'Lolhuman';
        }
    } catch (e) {
        console.error('[LYRICS LOLHUMAN ERROR]', e.message);
    }

    // --- API 2: SIPUTZX (Cadangan untuk Lagu Umum) ---
    if (!lyricData) {
        try {
            const res = await fetch(`https://api.siputzx.my.id/api/s/lyrics?query=${encodeURIComponent(query)}`);
            const json = await res.json();
            if (json.status && json.data && json.data.lyrics) {
                lyricData = {
                    title: json.data.title || query,
                    lyrics: json.data.lyrics
                };
                source = 'Siputzx';
            }
        } catch (e) {
            console.error('[LYRICS SIPUTZX ERROR]', e.message);
        }
    }

    // --- API 3: KAIZEN (Cadangan terakhir, biasanya Anime/Jepang) ---
    if (!lyricData) {
        try {
            const res = await fetch(`https://kaizenapi.my.id/search/kaze?q=${encodeURIComponent(query)}`);
            const json = await res.json();
            if (json.status && json.result) {
                lyricData = json.result;
                source = 'Kaizen';
            }
        } catch (e) {
            console.error('[LYRICS KAIZEN ERROR]', e.message);
        }
    }

    if (!lyricData) {
        try { await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }); } catch (e) {}
        await sock.sendMessage(remoteJid, { text: '❌ Lirik tidak ditemukan. Coba gunakan Nama Artis + Judul Lagu (Contoh: .lirikvid Tulus Hati-Hati di Jalan)' }, { quoted: msg });
        return true;
    }

    const { title, lyrics } = lyricData;

        const romaji = extractSection(lyrics, 'ROMAJI:');
        const kanji = extractSection(lyrics, 'KANJI:');
        const indo = extractSection(lyrics, 'INDONESIA:');

        let caption = `*L I R I K   L A G U*\n\n`;
        caption += `🎵 *${title}*\n\n`;

        if (kanji && romaji) {
            const romajiLines = romaji.split('\n');
            const kanjiLines = kanji.split('\n');
            let jpSection = '';
            const maxLines = Math.max(romajiLines.length, kanjiLines.length);
            for (let i = 0; i < maxLines; i++) {
                const k = (kanjiLines[i] || '').trim();
                const r = (romajiLines[i] || '').trim();
                if (k || r) {
                    if (k) jpSection += k + '\n';
                    if (r) jpSection += r + '\n';
                } else {
                    jpSection += '\n';
                }
            }
            caption += jpSection.trimEnd();
        } else {
            caption += lyrics.trim();
        }

        if (indo) {
            caption += `\n\n✦•┈๑⋅⋯┈─────  ─────┈⋯⋅๑┈•✦\n`;
            caption += `🇮🇩 *Terjemahan Indonesia*\n\n`;
            caption += indo.trimEnd();
        }

        const dateStr = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        caption += `\n\n*Request by*: ${msg.pushName || 'User'}\n*DATE*: ${dateStr}`;

        try { await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } }); } catch (e) {}
        
        if (isVideo || isSticker) {
            // --- LOGIKA MENCARI BAGIAN BAGUS (CHORUS) ---
            let selectedText = '';
            const lowerLyrics = lyrics.toLowerCase();
            const chorusMarkers = ['[chorus]', '(chorus)', 'reff:', 'chorus:', '[reff]', '(reff)'];
            
            let chorusIdx = -1;
            for (const marker of chorusMarkers) {
                chorusIdx = lowerLyrics.indexOf(marker);
                if (chorusIdx !== -1) {
                    const start = chorusIdx + marker.length;
                    const end = lyrics.indexOf('\n\n', start);
                    selectedText = lyrics.slice(start, end !== -1 ? end : start + 200).trim();
                    break;
                }
            }

            if (!selectedText) {
                const lines = lyrics.split('\n').filter(l => l.trim().length > 5);
                const mid = Math.floor(lines.length / 2);
                selectedText = lines.slice(mid, mid + 3).join(' ');
            }
            
            const words = selectedText.split(/\s+/).slice(0, 12); 
            const ext = isSticker ? 'webp' : 'mp4';
            const outPath = path.join(__dirname, `../../temp_lirik_${Date.now()}.${ext}`);
            await sock.sendMessage(remoteJid, { text: `⏳ Menemukan bagian terbaik (Reff)...\nSedang merender ${isSticker ? 'stiker' : 'video'}...` }, { quoted: msg });
            
            try {
                await generateLyricVideo(words, outPath, isSticker);
                const sendObj = isSticker ? { sticker: fs.readFileSync(outPath) } : { video: fs.readFileSync(outPath), caption: `🎥 *Video Lirik Otomatis*\n🎵 *${title}*`, mimetype: 'video/mp4' };
                await sock.sendMessage(remoteJid, sendObj, { quoted: msg });
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            } catch (err) {
                console.error('Render Error:', err);
                await sock.sendMessage(remoteJid, { text: '❌ Gagal merender.' }, { quoted: msg });
            }
        } else {
            await sock.sendMessage(remoteJid, { text: caption }, { quoted: msg });
        }

    } catch (e) {
        console.error('[LYRICS ERROR]', e);
        try { await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }); } catch (e1) {}
        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil lirik. Coba lagi nanti.' }, { quoted: msg });
    }

    return true;
}

/**
 * Helper untuk memotong bagian lirik berdasarkan header
 */
function extractSection(lyrics, header) {
    const idx = lyrics.indexOf(header);
    if (idx === -1) return '';

    const start = idx + header.length;
    const nextHeaders = [
        'ROMAJI:', 'KANJI:', 'ENGLISH TRANSLATION (KAZELYRICS VERSION):',
        'INDONESIA:', 'RELATED ARTICLES:', '[Lyrics,', 'TENTANG LAGU'
    ];

    let end = lyrics.length;
    for (const h of nextHeaders) {
        if (h === header) continue;
        const pos = lyrics.indexOf(h, start);
        if (pos !== -1 && pos < end) end = pos;
    }

    return lyrics.slice(start, end).trim();
}

module.exports = {
    handleLyrics
};
