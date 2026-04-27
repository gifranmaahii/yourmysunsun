const { logger } = require('../utils/logger');

// Database Game (Bisa ditambahkan lebih banyak soal nanti)
const db = {
    tebaktebakan: [
        { soal: 'Benda apa yang kalau dibalik jadi rusak?', jawaban: 'kasur' },
        { soal: 'Punya kepala, punya ekor, tapi tidak punya badan. Apakah itu?', jawaban: 'koin' },
        { soal: 'Apa yang selalu datang tapi tidak pernah tiba?', jawaban: 'besok' },
        { soal: 'Bisa dipegang tapi tidak bisa disentuh?', jawaban: 'janji' },
        { soal: 'Benda apa yang selalu jujur, tapi tidak pernah bicara?', jawaban: 'cermin' },
        { soal: 'Semakin banyak kamu mengambilnya, semakin besar dia. Apakah itu?', jawaban: 'lubang' },
        { soal: 'Aku punya kota tapi tidak punya rumah, punya gunung tapi tidak punya pohon, punya air tapi tidak punya ikan. Siapakah aku?', jawaban: 'peta' },
        { soal: 'Apa yang mempunyai kunci tapi tidak bisa membuka pintu?', jawaban: 'piano' },
        { soal: 'Apa yang bisa lari tapi tidak punya kaki?', jawaban: 'sungai' },
        { soal: 'Kalau orang sedang tidur, apa yang dia lakukan?', jawaban: 'bernapas' }
    ],
    tebakkata: [
        { soal: 'K - A - L - I - M - A - T', jawaban: 'kalimat' },
        { soal: 'P - E - R - T - A - N - Y - A - A - N', jawaban: 'pertanyaan' },
        { soal: 'S - E - M - A - N - G - A - T', jawaban: 'semangat' },
        { soal: 'P - R - O - G - R - A - M - M - E - R', jawaban: 'programmer' },
        { soal: 'K - E - B - E - R - S - I - H - A - N', jawaban: 'kebersihan' },
        { soal: 'K - E - A - M - A - N - A - N', jawaban: 'keamanan' },
        { soal: 'P - E - R - S - E - T - U - J - U - A - N', jawaban: 'persetujuan' }
    ],
    tebakbendera: [
        { soal: '🇮🇩', jawaban: 'indonesia' },
        { soal: '🇯🇵', jawaban: 'jepang' },
        { soal: '🇺🇸', jawaban: 'amerika serikat' },
        { soal: '🇲🇾', jawaban: 'malaysia' },
        { soal: '🇰🇷', jawaban: 'korea selatan' },
        { soal: '🇸🇬', jawaban: 'singapura' },
        { soal: '🇳🇱', jawaban: 'belanda' },
        { soal: '🇬🇧', jawaban: 'inggris' },
        { soal: '🇫🇷', jawaban: 'perancis' },
        { soal: '🇩🇪', jawaban: 'jerman' },
        { soal: '🇧🇷', jawaban: 'brazil' },
        { soal: '🇦🇺', jawaban: 'australia' }
    ],
    caklontong: [
        { soal: 'Menjadi koki harus memiliki...', jawaban: 'kemauan' },
        { soal: 'Satu tambah satu sama dengan...', jawaban: 'sebelas' },
        { soal: 'Makan sate kambing enak kalau ada...', jawaban: 'mulutnya' },
        { soal: 'Cicak biasanya merayap di...', jawaban: 'mana saja' },
        { soal: 'Gajah terbang dengan apa?', jawaban: 'dengan susah payah' }
    ],
    tebaklirik: [
        { soal: 'Balonku ada lima, rupa-rupa ...', jawaban: 'warnanya' },
        { soal: 'Cicak-cicak di dinding, diam-diam ...', jawaban: 'merayap' },
        { soal: 'Naik kereta api, tut tut tut, siapa ...', jawaban: 'hendak turut' },
        { soal: 'Bintang kecil, di langit yang ...', jawaban: 'biru' },
        { soal: 'Satu-satu aku sayang ...', jawaban: 'ibu' }
    ],
    tebakkimia: [
        { soal: 'H2O', jawaban: 'air' },
        { soal: 'O2', jawaban: 'oksigen' },
        { soal: 'NaCl', jawaban: 'garam' },
        { soal: 'CO2', jawaban: 'karbon dioksida' },
        { soal: 'Au', jawaban: 'emas' },
        { soal: 'Fe', jawaban: 'besi' },
        { soal: 'Ag', jawaban: 'perak' }
    ]
};

const activeGames = new Map();

function getHint(jawaban) {
    if (jawaban.length <= 2) return jawaban;
    let hint = jawaban[0];
    for (let i = 1; i < jawaban.length - 1; i++) {
        hint += (jawaban[i] === ' ' ? ' ' : '_');
    }
    hint += jawaban[jawaban.length - 1];
    return hint;
}

async function startGame(sock, remoteJid, msg, gameType) {
    if (activeGames.has(remoteJid)) {
        await sock.sendMessage(remoteJid, { text: '❌ Masih ada game yang belum diselesaikan di chat ini! Jawab atau ketik *.nyerah*' }, { quoted: msg });
        return;
    }

    // Auto fetch database tebak gambar gratis dari GitHub (BochilTeam Database)
    if (gameType === 'tebakgambar' && !db.tebakgambar) {
        try {
            const res = await fetch('https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar.json');
            db.tebakgambar = await res.json();
        } catch (e) {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil database tebak gambar.' }, { quoted: msg });
            return;
        }
    }

    const questions = db[gameType];
    if (!questions || questions.length === 0) {
        await sock.sendMessage(remoteJid, { text: '❌ Game belum tersedia.' }, { quoted: msg });
        return;
    }

    const randomIdx = Math.floor(Math.random() * questions.length);
    const question = questions[randomIdx];
    
    const hadiah = Math.floor(Math.random() * 500) + 100;
    const waktu = 60; // 60 detik

    const namaGame = gameType.replace('tebak', 'Tebak ').toUpperCase();

    // Sesuaikan text soal jika dari API (beberapa key berbeda)
    const teksPertanyaan = question.soal || question.deskripsi || 'Tebak gambar ini!';
    const teksJawaban = question.jawaban.toLowerCase();

    const textSoal = `🎮 *GAME ${namaGame}* 🎮\n\n` +
                     `Soal: *${teksPertanyaan}*\n\n` +
                     `⏳ Waktu: ${waktu} detik\n` +
                     `💰 Hadiah: ${hadiah} XP\n\n` +
                     `💡 Ketik *.hint* untuk bantuan\n` +
                     `🏳️ Ketik *.nyerah* untuk menyerah\n` +
                     `Balas pesan ini atau ketik langsung jawabannya!`;

    let sentMsg;
    if (question.img) {
        // Jika soal berbentuk gambar (API)
        sentMsg = await sock.sendMessage(remoteJid, { image: { url: question.img }, caption: textSoal }, { quoted: msg });
    } else {
        sentMsg = await sock.sendMessage(remoteJid, { text: textSoal }, { quoted: msg });
    }

    const timeout = setTimeout(async () => {
        if (activeGames.has(remoteJid)) {
            const game = activeGames.get(remoteJid);
            if (game.id === sentMsg.key.id) {
                await sock.sendMessage(remoteJid, { text: `⏳ *WAKTU HABIS!*\n\nJawaban yang benar adalah: *${game.jawaban}*` });
                activeGames.delete(remoteJid);
            }
        }
    }, waktu * 1000);

    activeGames.set(remoteJid, {
        id: sentMsg.key.id,
        tipe: gameType,
        jawaban: teksJawaban,
        hadiah: hadiah,
        timeout: timeout,
        isHintUsed: false
    });
}

async function handleGameAnswer(sock, remoteJid, msg, textContent) {
    if (!activeGames.has(remoteJid)) return false;

    const game = activeGames.get(remoteJid);
    const answer = textContent.trim().toLowerCase();

    if (answer === '.hint') {
        if (!game.isHintUsed) {
            game.isHintUsed = true;
            await sock.sendMessage(remoteJid, { text: `💡 *BANTUAN*\n\nJawaban: ${getHint(game.jawaban)}` }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, { text: `❌ Bantuan sudah digunakan!` }, { quoted: msg });
        }
        return true;
    }

    if (answer === '.nyerah' || answer === '.surrender') {
        clearTimeout(game.timeout);
        await sock.sendMessage(remoteJid, { text: `🏳️ *MENYERAH*\n\nGame dihentikan. Jawaban yang benar adalah: *${game.jawaban}*` }, { quoted: msg });
        activeGames.delete(remoteJid);
        return true;
    }

    // Cek jawaban
    if (answer === game.jawaban) {
        clearTimeout(game.timeout);
        const participant = msg.key.participant || msg.key.remoteJid;
        await sock.sendMessage(remoteJid, { 
            text: `🎉 *BENAR!* 🎉\n\n@${participant.split('@')[0]} berhasil menjawab: *${game.jawaban}*\n💰 Mendapatkan: ${game.hadiah} XP!`, 
            mentions: [participant] 
        }, { quoted: msg });
        activeGames.delete(remoteJid);
        return true;
    }

    return false;
}

module.exports = {
    startGame,
    handleGameAnswer,
    db
};
