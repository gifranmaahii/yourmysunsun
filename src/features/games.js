const { logger } = require('../utils/logger');

// ============================================================
// DATABASE GAME MEGA — Auto-fetch dari BochilTeam (GitHub, GRATIS)
// Total soal: 2000+ soal dari 13 kategori game berbeda!
// ============================================================

const BOCHIL_BASE = 'https://raw.githubusercontent.com/BochilTeam/database/master/games';

// Mapping nama game → file JSON di GitHub + field mapping
const GAME_CONFIG = {
    // === GAME TEBAK-TEBAKAN (Database besar dari GitHub) ===
    tebaktebakan:  { url: `${BOCHIL_BASE}/tebaktebakan.json`,  soalKey: 'soal', jawabanKey: 'jawaban', emoji: '🤔', nama: 'TEBAK TEBAKAN' },
    tebakgambar:   { url: `${BOCHIL_BASE}/tebakgambar.json`,   soalKey: 'deskripsi', jawabanKey: 'jawaban', imgKey: 'img', emoji: '🖼️', nama: 'TEBAK GAMBAR' },
    tebakkata:     { url: `${BOCHIL_BASE}/tebakkata.json`,      soalKey: 'soal', jawabanKey: 'jawaban', emoji: '🔤', nama: 'TEBAK KATA' },
    tebakbendera:  { url: `${BOCHIL_BASE}/tebakbendera.json`,   soalKey: 'flag', jawabanKey: 'name', imgKey: 'img', emoji: '🏳️', nama: 'TEBAK BENDERA', isBendera: true },
    tebakkimia:    { url: `${BOCHIL_BASE}/tebakkimia.json`,     soalKey: 'soal', jawabanKey: 'jawaban', emoji: '⚗️', nama: 'TEBAK KIMIA' },
    tebaklirik:    { url: `${BOCHIL_BASE}/tebaklirik.json`,     soalKey: 'soal', jawabanKey: 'jawaban', emoji: '🎵', nama: 'TEBAK LIRIK' },
    tebakkalimat:  { url: `${BOCHIL_BASE}/tebakkalimat.json`,   soalKey: 'soal', jawabanKey: 'jawaban', emoji: '📝', nama: 'TEBAK KALIMAT' },

    // === GAME BARU — SERU & DATABASE BANYAK ===
    asahotak:      { url: `${BOCHIL_BASE}/asahotak.json`,       soalKey: 'soal', jawabanKey: 'jawaban', emoji: '🧠', nama: 'ASAH OTAK' },
    siapakahaku:   { url: `${BOCHIL_BASE}/siapakahaku.json`,    soalKey: 'soal', jawabanKey: 'jawaban', emoji: '🎭', nama: 'SIAPAKAH AKU' },
    susunkata:     { url: `${BOCHIL_BASE}/susunkata.json`,      soalKey: 'soal', jawabanKey: 'jawaban', tipeKey: 'tipe', emoji: '🔀', nama: 'SUSUN KATA' },
    tekateki:      { url: `${BOCHIL_BASE}/tekateki.json`,       soalKey: 'soal', jawabanKey: 'jawaban', emoji: '❓', nama: 'TEKA TEKI' },
    caklontong:    { url: `${BOCHIL_BASE}/caklontong.json`,     soalKey: 'soal', jawabanKey: 'jawaban', deskripsiKey: 'dpikirkan', emoji: '😂', nama: 'CAK LONTONG' },
    family100:     { url: `${BOCHIL_BASE}/family100.json`,      soalKey: 'soal', jawabanKey: 'jawaban', emoji: '👨‍👩‍👧‍👦', nama: 'FAMILY 100', isMultiAnswer: true },

    // === GAME BONUS: MATH QUIZ (lokal, tanpa API) ===
    math:          { local: true, emoji: '🔢', nama: 'MATH QUIZ' },
    tebakangka:    { local: true, emoji: '🎯', nama: 'TEBAK ANGKA' },
    truthordare:   { local: true, emoji: '🎲', nama: 'TRUTH OR DARE' },
};

// Cache database agar tidak fetch berulang kali
const dbCache = {};

// Active games per chat
const activeGames = new Map();

// ============================================================
// FETCH DATABASE (sekali fetch, disimpan di memori)
// ============================================================
async function fetchGameDB(gameType) {
    if (dbCache[gameType]) return dbCache[gameType];

    const config = GAME_CONFIG[gameType];
    if (!config) return null;
    if (config.local) return null; // game lokal tidak perlu fetch

    try {
        logger.info(`🎮 [GAME] Mengunduh database ${gameType} dari GitHub...`);
        const res = await fetch(config.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dbCache[gameType] = data;
        logger.info(`✅ [GAME] Database ${gameType} dimuat: ${data.length} soal`);
        return data;
    } catch (err) {
        logger.error(`❌ [GAME] Gagal fetch database ${gameType}: ${err.message}`);
        return null;
    }
}

// ============================================================
// GENERATE SOAL LOKAL (Math, Tebak Angka, Truth or Dare)
// ============================================================
function generateMathQuestion() {
    const ops = ['+', '-', '×'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, jawaban;
    switch (op) {
        case '+':
            a = Math.floor(Math.random() * 500) + 1;
            b = Math.floor(Math.random() * 500) + 1;
            jawaban = a + b;
            break;
        case '-':
            a = Math.floor(Math.random() * 500) + 100;
            b = Math.floor(Math.random() * a);
            jawaban = a - b;
            break;
        case '×':
            a = Math.floor(Math.random() * 30) + 2;
            b = Math.floor(Math.random() * 30) + 2;
            jawaban = a * b;
            break;
    }
    return { soal: `${a} ${op} ${b} = ?`, jawaban: String(jawaban) };
}

function generateTebakAngka() {
    const angka = Math.floor(Math.random() * 100) + 1;
    return { soal: `Aku sudah memikirkan angka antara 1–100. Coba tebak!`, jawaban: String(angka), isGuessNumber: true };
}

// Truth or Dare database lokal
const truthQuestions = [
    'Siapa orang yang terakhir kamu stalking di media sosial?',
    'Pernah bohong ke orang tua soal apa?',
    'Kalau bisa telepon satu orang sekarang, siapa?',
    'Hal paling memalukan yang pernah kamu alami?',
    'Pernah nangis gara-gara film apa?',
    'Crush pertama kamu siapa?',
    'Kapan terakhir kali kamu menangis?',
    'Apa rahasia yang belum pernah kamu ceritain ke siapapun?',
    'Hal paling bodoh yang pernah kamu lakukan?',
    'Kalau besok dunia kiamat, apa yang kamu lakukan hari ini?',
    'Pernah baca chat orang lain diam-diam?',
    'Siapa teman yang paling kamu iri?',
    'Pernah ngomong jelek tentang teman di belakang?',
    'Hal apa yang bikin kamu paling insecure?',
    'Pernah ketahuan bohong? Soal apa?',
    'Siapa orang yang paling kamu benci? Kenapa?',
    'Kalau dikasih Rp 1 Miliar, apa yang pertama kamu beli?',
    'Pernah jatuh cinta sama sahabat sendiri?',
    'Apa kebiasaan aneh kamu yang gak ada orang tahu?',
    'Kalau bisa jadi orang lain sehari, mau jadi siapa?',
];

const dareQuestions = [
    'Kirim chat "Aku kangen kamu" ke kontak terakhir!',
    'Screenshoot wallpaper HP kamu dan kirim ke sini!',
    'Kirim voice note nyanyi lagu apa aja 10 detik!',
    'Ganti foto profil WA jadi warna hitam selama 1 jam!',
    'Ketik pake kaki dan kirim hasilnya!',
    'Kirim emoji terakhir yang kamu pakai 50 kali!',
    'Tulis status WA "Aku butuh teman curhat, DM ya" selama 30 menit!',
    'Kirim pesan "Maafin aku ya" ke 3 kontak random!',
    'Ceritakan joke atau lelucon yang paling garing!',
    'Rekam voice note ketawa selama 10 detik!',
    'Tulis nama kamu pakai huruf terbalik!',
    'Kirim stiker paling aneh yang kamu punya!',
    'Balas semua pesan di grup ini selama 5 menit dengan emoji saja!',
    'Kirim foto terakhir di galeri HP kamu!',
    'Tulis puisi 4 baris tentang anggota grup ini!',
    'Sebutkan 5 nama hewan dalam 5 detik!',
    'Bilang "I love you" ke admin grup!',
    'Ganti nama profil WA jadi "Budak Cinta" selama 1 jam!',
    'Kirim voice note bilang "Aku mau nembak kamu" ke 1 kontak!',
    'Ketik pesan sepanjang mungkin tanpa menggunakan huruf A!',
];

function generateTruthOrDare() {
    const isTruth = Math.random() > 0.5;
    const pool = isTruth ? truthQuestions : dareQuestions;
    const q = pool[Math.floor(Math.random() * pool.length)];
    return { soal: q, jawaban: null, isTruthOrDare: true, type: isTruth ? 'TRUTH' : 'DARE' };
}

// ============================================================
// HINT GENERATOR
// ============================================================
function getHint(jawaban) {
    if (!jawaban || jawaban.length <= 2) return jawaban || '??';
    let hint = jawaban[0];
    for (let i = 1; i < jawaban.length - 1; i++) {
        hint += (jawaban[i] === ' ' ? ' ' : '_');
    }
    hint += jawaban[jawaban.length - 1];
    return hint;
}

// ============================================================
// START GAME
// ============================================================
async function startGame(sock, remoteJid, msg, gameType) {
    if (activeGames.has(remoteJid)) {
        await sock.sendMessage(remoteJid, { text: '❌ Masih ada game yang belum diselesaikan di chat ini! Jawab atau ketik *.nyerah*' }, { quoted: msg });
        return;
    }

    const config = GAME_CONFIG[gameType];
    if (!config) {
        await sock.sendMessage(remoteJid, { text: '❌ Game tidak ditemukan.' }, { quoted: msg });
        return;
    }

    let question;

    // === Game lokal (tanpa fetch) ===
    if (config.local) {
        if (gameType === 'math') {
            question = generateMathQuestion();
        } else if (gameType === 'tebakangka') {
            question = generateTebakAngka();
        } else if (gameType === 'truthordare') {
            question = generateTruthOrDare();
        }
    } else {
        // === Game dari API/GitHub ===
        const questions = await fetchGameDB(gameType);
        if (!questions || questions.length === 0) {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil database game. Coba lagi nanti.' }, { quoted: msg });
            return;
        }
        const randomIdx = Math.floor(Math.random() * questions.length);
        const raw = questions[randomIdx];

        // Normalize keys
        question = {
            soal: config.isBendera ? 'Negara apa yang memiliki bendera ini?' : (raw[config.soalKey] || raw.soal || raw.deskripsi || 'Tebak!'),
            jawaban: raw[config.jawabanKey] || raw.jawaban,
            img: config.imgKey ? raw[config.imgKey] : null,
            tipe: config.tipeKey ? raw[config.tipeKey] : null,
            dpikirkan: config.deskripsiKey ? raw[config.deskripsiKey] : null,
            isMultiAnswer: config.isMultiAnswer || false,
        };
    }

    if (!question) {
        await sock.sendMessage(remoteJid, { text: '❌ Gagal generate soal.' }, { quoted: msg });
        return;
    }

    // === TRUTH OR DARE — langsung tampilkan, tidak perlu jawaban ===
    if (question.isTruthOrDare) {
        const emoji = question.type === 'TRUTH' ? '🔮' : '🎯';
        const label = question.type === 'TRUTH' ? 'TRUTH (Jujur)' : 'DARE (Tantangan)';
        const textSoal = `🎲 *TRUTH OR DARE* 🎲\n\n${emoji} *${label}*\n\n${question.soal}\n\n💡 Ketik *.tod* untuk putar lagi!`;
        await sock.sendMessage(remoteJid, { text: textSoal }, { quoted: msg });
        return; // Tidak perlu set activeGames
    }

    const hadiah = Math.floor(Math.random() * 500) + 100;
    const waktu = gameType === 'family100' ? 120 : 60; // Family100 lebih lama karena multi-jawaban

    // === TEBAK ANGKA — mode special ===
    if (question.isGuessNumber) {
        const textSoal = `${config.emoji} *GAME ${config.nama}* ${config.emoji}\n\n` +
            `${question.soal}\n\n` +
            `⏳ Waktu: ${waktu} detik\n` +
            `💰 Hadiah: ${hadiah} XP\n\n` +
            `💡 Ketik angka (1-100) untuk menebak!\n` +
            `🏳️ Ketik *.nyerah* untuk menyerah`;

        const sentMsg = await sock.sendMessage(remoteJid, { text: textSoal }, { quoted: msg });

        const timeout = setTimeout(async () => {
            if (activeGames.has(remoteJid)) {
                const game = activeGames.get(remoteJid);
                if (game.id === sentMsg.key.id) {
                    await sock.sendMessage(remoteJid, { text: `⏳ *WAKTU HABIS!*\n\nAngka yang benar adalah: *${game.jawaban}*` });
                    activeGames.delete(remoteJid);
                }
            }
        }, waktu * 1000);

        activeGames.set(remoteJid, {
            id: sentMsg.key.id,
            tipe: gameType,
            jawaban: question.jawaban,
            hadiah: hadiah,
            timeout: timeout,
            isHintUsed: false,
            isGuessNumber: true,
            attempts: 0,
        });
        return;
    }

    // === Format jawaban ===
    let teksJawaban;
    let jawabanList = null; // untuk Family100
    if (question.isMultiAnswer && Array.isArray(question.jawaban)) {
        // Family100: jawaban = array of strings
        jawabanList = question.jawaban.map(j => j.toLowerCase().trim());
        teksJawaban = jawabanList.join(', ');
    } else {
        teksJawaban = String(question.jawaban || '').toLowerCase().trim();
    }

    // === Build soal text ===
    let soalDisplay = question.soal || 'Tebak!';
    if (question.tipe) {
        soalDisplay = `Kategori: *${question.tipe}*\n\nSusun huruf: *${soalDisplay}*`;
    }
    if (question.dpikirkan) {
        soalDisplay += `\n\n_💭 Yang dipikirkan: ${question.dpikirkan}_`;
    }

    const textSoal = `${config.emoji} *GAME ${config.nama}* ${config.emoji}\n\n` +
        `Soal: *${soalDisplay}*\n\n` +
        `⏳ Waktu: ${waktu} detik\n` +
        `💰 Hadiah: ${hadiah} XP\n\n` +
        (question.isMultiAnswer ? `📊 Jawaban: ${jawabanList.length} jawaban tersembunyi\n` : '') +
        `💡 Ketik *.hint* untuk bantuan\n` +
        `🏳️ Ketik *.nyerah* untuk menyerah\n` +
        `Balas pesan ini atau ketik langsung jawabannya!`;

    let sentMsg;
    if (question.img) {
        try {
            sentMsg = await sock.sendMessage(remoteJid, { image: { url: question.img }, caption: textSoal }, { quoted: msg });
        } catch (imgErr) {
            // Fallback ke teks jika gambar gagal
            sentMsg = await sock.sendMessage(remoteJid, { text: textSoal }, { quoted: msg });
        }
    } else {
        sentMsg = await sock.sendMessage(remoteJid, { text: textSoal }, { quoted: msg });
    }

    const timeout = setTimeout(async () => {
        if (activeGames.has(remoteJid)) {
            const game = activeGames.get(remoteJid);
            if (game.id === sentMsg.key.id) {
                const jawDisplay = game.isMultiAnswer 
                    ? game.jawabanList.join(', ')
                    : game.jawaban;
                await sock.sendMessage(remoteJid, { text: `⏳ *WAKTU HABIS!*\n\nJawaban yang benar adalah: *${jawDisplay}*` });
                activeGames.delete(remoteJid);
            }
        }
    }, waktu * 1000);

    activeGames.set(remoteJid, {
        id: sentMsg.key.id,
        tipe: gameType,
        jawaban: teksJawaban,
        jawabanList: jawabanList,
        answeredList: [], // untuk Family100
        isMultiAnswer: question.isMultiAnswer || false,
        hadiah: hadiah,
        timeout: timeout,
        isHintUsed: false,
    });
}

// ============================================================
// HANDLE JAWABAN GAME
// ============================================================
async function handleGameAnswer(sock, remoteJid, msg, textContent) {
    if (!activeGames.has(remoteJid)) return false;

    const game = activeGames.get(remoteJid);
    const answer = textContent.trim().toLowerCase();

    // === HINT ===
    if (answer === '.hint') {
        if (game.isGuessNumber) {
            // Tebak Angka hint: beri range
            const target = parseInt(game.jawaban);
            const low = Math.max(1, target - 15);
            const high = Math.min(100, target + 15);
            await sock.sendMessage(remoteJid, { text: `💡 *BANTUAN*\n\nAngkanya antara *${low}* sampai *${high}*` }, { quoted: msg });
            return true;
        }
        if (game.isMultiAnswer) {
            // Family100: tunjukkan jumlah huruf jawaban pertama yang belum dijawab
            const remaining = game.jawabanList.filter(j => !game.answeredList.includes(j));
            if (remaining.length > 0) {
                const hint = getHint(remaining[0]);
                await sock.sendMessage(remoteJid, { text: `💡 *BANTUAN*\n\nSalah satu jawaban: ${hint}\nSisa: ${remaining.length} jawaban` }, { quoted: msg });
            }
            return true;
        }
        if (!game.isHintUsed) {
            game.isHintUsed = true;
            await sock.sendMessage(remoteJid, { text: `💡 *BANTUAN*\n\nJawaban: ${getHint(game.jawaban)}` }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, { text: `❌ Bantuan sudah digunakan!` }, { quoted: msg });
        }
        return true;
    }

    // === MENYERAH ===
    if (answer === '.nyerah' || answer === '.surrender') {
        clearTimeout(game.timeout);
        const jawDisplay = game.isMultiAnswer
            ? game.jawabanList.join(', ')
            : game.jawaban;
        await sock.sendMessage(remoteJid, { text: `🏳️ *MENYERAH*\n\nGame dihentikan. Jawaban yang benar adalah: *${jawDisplay}*` }, { quoted: msg });
        activeGames.delete(remoteJid);
        return true;
    }

    // === CEK JAWABAN ===

    // TEBAK ANGKA — mode guess higher/lower
    if (game.isGuessNumber) {
        const guess = parseInt(answer);
        if (isNaN(guess)) return false;
        
        game.attempts = (game.attempts || 0) + 1;
        const target = parseInt(game.jawaban);

        if (guess === target) {
            clearTimeout(game.timeout);
            const participant = msg.key.participant || msg.key.remoteJid;
            await sock.sendMessage(remoteJid, {
                text: `🎉 *BENAR!* 🎉\n\n@${participant.split('@')[0]} berhasil menebak angka *${target}* dalam ${game.attempts} percobaan!\n💰 Mendapatkan: ${game.hadiah} XP!`,
                mentions: [participant]
            }, { quoted: msg });
            activeGames.delete(remoteJid);
            return true;
        } else if (guess < target) {
            await sock.sendMessage(remoteJid, { text: `⬆️ Angkanya lebih *BESAR* dari ${guess}! (Percobaan: ${game.attempts})` }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, { text: `⬇️ Angkanya lebih *KECIL* dari ${guess}! (Percobaan: ${game.attempts})` }, { quoted: msg });
        }
        return true;
    }

    // FAMILY100 — multi-answer mode
    if (game.isMultiAnswer && game.jawabanList) {
        const matched = game.jawabanList.find(j => 
            j === answer || j.includes(answer) || answer.includes(j)
        );

        if (matched && !game.answeredList.includes(matched)) {
            game.answeredList.push(matched);
            const remaining = game.jawabanList.length - game.answeredList.length;
            const participant = msg.key.participant || msg.key.remoteJid;

            if (remaining <= 0) {
                // Semua jawaban ditemukan!
                clearTimeout(game.timeout);
                await sock.sendMessage(remoteJid, {
                    text: `🎉 *SEMPURNA!* 🎉\n\n@${participant.split('@')[0]} berhasil menjawab SEMUA jawaban!\n\n📝 Jawaban: ${game.jawabanList.join(', ')}\n💰 Mendapatkan: ${game.hadiah * 2} XP (BONUS 2x)!`,
                    mentions: [participant]
                }, { quoted: msg });
                activeGames.delete(remoteJid);
            } else {
                await sock.sendMessage(remoteJid, {
                    text: `✅ *"${matched}"* BENAR! 🎉\n\n@${participant.split('@')[0]} mendapatkan ${Math.floor(game.hadiah / game.jawabanList.length)} XP\n\n📊 Terjawab: ${game.answeredList.length}/${game.jawabanList.length}\n⏳ Sisa ${remaining} jawaban lagi!`,
                    mentions: [participant]
                }, { quoted: msg });
            }
            return true;
        }
        return false; // Jawaban salah, biarkan pesan lewat
    }

    // GAME BIASA — single answer
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

// ============================================================
// GAME LIST (untuk tampilkan daftar game)
// ============================================================
function getGameList(prefix) {
    return `🎮 *DAFTAR GAME LENGKAP* 🎮

┏━『 *🧩 TEBAK-TEBAKAN* 』
┃
┣⌬ ${prefix}tebaktebakan — Tebak jawaban riddle
┣⌬ ${prefix}tebakgambar — Tebak dari gambar
┣⌬ ${prefix}tebakkata — Tebak kata tersembunyi
┣⌬ ${prefix}tebakbendera — Tebak bendera negara
┣⌬ ${prefix}tebakkimia — Tebak rumus kimia
┣⌬ ${prefix}tebaklirik — Lengkapi lirik lagu
┣⌬ ${prefix}tebakkalimat — Lengkapi peribahasa
┗━━━━━━━◧

┏━『 *🧠 ASAH OTAK* 』
┃
┣⌬ ${prefix}asahotak — Quiz pengetahuan umum
┣⌬ ${prefix}siapakahaku — Tebak dari deskripsi
┣⌬ ${prefix}susunkata — Susun huruf acak
┣⌬ ${prefix}tekateki — Teka-teki lucu
┣⌬ ${prefix}caklontong — Jawaban tak terduga!
┗━━━━━━━◧

┏━『 *🎲 PARTY GAMES* 』
┃
┣⌬ ${prefix}family100 — Tebak survey populer
┣⌬ ${prefix}math — Quiz matematika
┣⌬ ${prefix}tebakangka — Tebak angka 1-100
┣⌬ ${prefix}tod — Truth or Dare 🔥
┗━━━━━━━◧

┏━『 *⚙️ KONTROL* 』
┃
┣⌬ ${prefix}hint — Minta bantuan
┣⌬ ${prefix}nyerah — Menyerah
┗━━━━━━━◧

📊 Total: 2000+ soal dari 16 game!
💡 Database: BochilTeam (gratis & auto-update)`;
}

module.exports = {
    startGame,
    handleGameAnswer,
    getGameList,
    GAME_CONFIG,
};
