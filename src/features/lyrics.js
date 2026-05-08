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
    const targetCmds = [prefix + 'lirik', prefix + 'lyrics', prefix + 'lirikvid', prefix + 'lirikvideo'];
    
    if (!targetCmds.some(cmd => command.startsWith(cmd))) return false;

    const query = textContent.slice(command.length).trim();
    if (!query) {
        await sock.sendMessage(remoteJid, { text: `❌ Format salah!\nContoh: *${command} Berharap Tak Berpisah*` }, { quoted: msg });
        return true;
    }

    // React loading
    try { await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } }); } catch (e) {}

    try {
        const res = await fetch(`https://kaizenapi.my.id/search/kaze?q=${encodeURIComponent(query)}`);
        const json = await res.json();

        if (!json.status || !json.result) {
            try { await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }); } catch (e) {}
            await sock.sendMessage(remoteJid, { text: '❌ Lirik tidak ditemukan.' }, { quoted: msg });
            return true;
        }

        const { title, lyrics } = json.result;

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
        
        if (isVideo) {
            // Ambil 3-4 baris pertama saja untuk video agar tidak terlalu berat
            const lines = lyrics.split('\n').filter(l => l.trim().length > 5).slice(0, 3);
            const allWords = lines.join(' ').split(' ').slice(0, 10); // Maks 10 kata agar video tidak kelamaan
            
            const outPath = path.join(__dirname, `../../temp_lirik_${Date.now()}.mp4`);
            await sock.sendMessage(remoteJid, { text: '⏳ Sedang merender video lirik... Mohon tunggu sebentar.' }, { quoted: msg });
            
            try {
                await generateLyricVideo(allWords, outPath);
                await sock.sendMessage(remoteJid, { 
                    video: fs.readFileSync(outPath), 
                    caption: `🎥 *Video Lirik Otomatis*\n🎵 *${title}*\n\n_Efek: Rain Aesthetic_`,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
                
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            } catch (err) {
                console.error('Video Gen Error:', err);
                await sock.sendMessage(remoteJid, { text: '❌ Gagal membuat video. RAM VPS mungkin tidak cukup.' }, { quoted: msg });
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
