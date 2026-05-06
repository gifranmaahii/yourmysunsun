const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { logger, baileyLogger } = require('../utils/logger');
const { addExif } = require('./sticker');
const cfg = require('../utils/config');
const { convertToOggOpus, getAudioDuration, generateWaveform } = require('../utils/audioConverter');

const DATABASE_PATH = path.join(__dirname, '../../data/channelCopierDB.json');

// Kunci API Gemini (Rotasi)
const GEMINI_KEYS = [
    "AIzaSyARVEABPQZ3MLE4zpFTawUt-05z51G1U4Q",
    "AIzaSyAvUSJDwYc6YHyhzdoAqGEPKfKCm_bkqpU",
    "AIzaSyCogQpWi53F4VZtNnbqVIw8GwleFLh27tE",
    "AIzaSyBkeCVQrwIOezK0SfNuN1ZOIr713VCIhVU",
    "AIzaSyBXpKCecgXeDNNkaz7s4k4vh5PVbPyhdd0",
    "AIzaSyCsNhvkv4_VNXZOVAnOxOGjVR-a_OPqycQ",
    "AIzaSyDl6YD6Fo2FEoHaVeHqj9rdbXhSQLY7SF4",
    "AIzaSyDvMusM4UzOrVJFnRE54uikwYgbeRO1EhM",
    "AIzaSyCh_X_MaQkvlMn-sEWuVrvH7qYG84a_OSk",
    "AIzaSyB8XiH8OH6WcDY79aZcpDgcbvLLLmKYaqY",
    "AIzaSyC5BjyOoBm9jZ6YO3unR7IraEBYxHPw4ic",
    "AIzaSyCBksWq4gsVO8xL76PQS4uYFY-TnxSdE1U",
    "AIzaSyCReA33hQaYQJQ5u4CLFjjQEP1fSMspZD8",
    "AIzaSyAVwHKkWaMr4UPYZ24Jmq7RSYasL1Nk9BQ",
    "AIzaSyANkr2-_34k0AUSYUFP2WEM5_YnyABa0jo",
    "AIzaSyBVkv2ERQKZyETL4Ydk8R12fiF2VWiwZwQ",
    "AIzaSyCo7l-JdJgcbIZ4NFOsR5YCwqcu69G9BBg",
    "AIzaSyBRt2Ibf_BoQFjKFSQfZTjat2daG_mBQy0",
    "AIzaSyB446c71Q1SxvpytkPAen_rc9RbpafBm7w",
    "AIzaSyCoeoPOSDlWacqzBGfPdIijS2sxHYZU1eU",
    "AIzaSyAu-qE-IqG0aGzmervEwY4tdmnKOLWA7ZE",
    "AIzaSyDUNqEQB5smyuOUOsvI2-IkHCP8mtb1zPc",
    "AIzaSyCHnXneMMHf4mi8eAiMx4w3tStI0jGWhCE",
    "AIzaSyDOtUE5Hzr5FUYfe8QIpwE2zn2e_4hYVMs",
    "AIzaSyA_wUq77ngM6FmXr-CJez6epThORJq3IEE"
];

let db = {
    jobs: [], // { id, creator, sourceJid, targetJid, active, settings }
    vips: []  // List nomor JID yang boleh akses media/video
};

function loadDB() {
    try {
        const dir = path.dirname(DATABASE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(DATABASE_PATH)) {
            const data = fs.readFileSync(DATABASE_PATH, 'utf8');
            const parsed = JSON.parse(data);
            db.jobs = parsed.jobs || [];
            db.vips = parsed.vips || [];
            console.log(`[DEBUG COPIER] Database loaded! Jobs: ${db.jobs.length}, VIPs: ${db.vips.length}`);
        } else {
            console.log(`[DEBUG COPIER] Database file not found at ${DATABASE_PATH}. Creating new one.`);
        }
    } catch (e) {
        logger.error('Gagal meload database channelCopier: ' + e.message);
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DATABASE_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
        logger.error('Gagal menyimpan database channelCopier: ' + e.message);
    }
}

loadDB();

async function rewriteWithGemini(text) {
    if (!text || text.trim() === '') return text;
    const prompt = `Tulis ulang (rewrite) kata-kata berikut agar natural dan tidak terlihat hasil copy-paste, tapi pertahankan inti informasinya:\n\n${text}`;
    for (let i = 0; i < 3; i++) {
        const key = GEMINI_KEYS[Math.floor(Math.random() * GEMINI_KEYS.length)];
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            const data = await res.json();
            if (data.candidates?.[0]?.content) {
                return data.candidates[0].content.parts[0].text.trim();
            }
        } catch (e) { logger.warn(`Gemini Error: ${e.message}`); }
    }
    return text;
}

async function handleCopier(sock, msg) {
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid.endsWith('@newsletter')) return false;

    // DEBUG LOG
    console.log(`\n[DEBUG COPIER] Mendeteksi pesan dari saluran: ${remoteJid}`);
    console.log(`[DEBUG COPIER] Daftar Sumber di DB: ${db.jobs.map(j => j.sourceJid).join(', ')}`);
    
    // Cari tugas yang menggunakan newsletter ini sebagai sumber
    const activeJobs = db.jobs.filter(j => j.active && j.sourceJid.trim().toLowerCase() === remoteJid.trim().toLowerCase());
    console.log(`[DEBUG COPIER] Jumlah tugas cocok: ${activeJobs.length}`);

    if (activeJobs.length === 0) return false;

    // Unwrap message
    let message = msg.message;
    let unwrappedFrom = null;

    if (message?.ephemeralMessage?.message) {
        message = message.ephemeralMessage.message;
        unwrappedFrom = 'ephemeralMessage';
    }
    if (message?.viewOnceMessage?.message) {
        message = message.viewOnceMessage.message;
        unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'viewOnceMessage';
    }
    if (message?.viewOnceMessageV2?.message) {
        message = message.viewOnceMessageV2.message;
        unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'viewOnceMessageV2';
    }
    if (message?.viewOnceMessageV2Extension?.message) {
        message = message.viewOnceMessageV2Extension.message;
        unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'viewOnceMessageV2Extension';
    }
    if (message?.documentWithCaptionMessage?.message) {
        message = message.documentWithCaptionMessage.message;
        unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'documentWithCaptionMessage';
    }
    if (message?.editedMessage?.message?.protocolMessage?.editedMessage) {
        message = message.editedMessage.message.protocolMessage.editedMessage;
        unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'editedMessage';
    }
    
    if (!message || message.protocolMessage) return false;

    // Deteksi Tipe & Extract Content
    const isImage = !!message.imageMessage;
    const isVideo = !!message.videoMessage;
    const isSticker = !!(message.stickerMessage || message.lottieStickerMessage);
    const isAudio = !!message.audioMessage;
    const isDocument = !!message.documentMessage;
    const isText = !!(message.conversation || message.extendedTextMessage) && !isImage && !isVideo && !isSticker && !isAudio && !isDocument;

    const textContent = 
        message.conversation || 
        message.extendedTextMessage?.text || 
        message.imageMessage?.caption || 
        message.videoMessage?.caption || 
        message.documentMessage?.caption || 
        '';

    const isLink = /(https?:\/\/[^\s]+)/g.test(textContent);
    
    // Log tipe pesan yang masuk
    const msgType = Object.keys(message || {})[0];
    console.log(`[DEBUG COPIER] Tipe: ${msgType}, isText: ${isText}, isSticker: ${isSticker}, textLen: ${textContent.length}`);

    // Jalankan tiap tugas yang cocok
    for (const job of activeJobs) {
        const s = job.settings;
        
        // Filter Dasar
        if (s.skipLinks && isLink) {
            console.log(`[DEBUG COPIER] Job ${job.id} skip: contains link`);
            continue;
        }
        if (isText && !s.allowText) {
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowText is OFF`);
            continue;
        }
        if (isImage && !s.allowImage) {
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowImage is OFF`);
            continue;
        }
        if (isVideo && !s.allowVideo) {
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowVideo is OFF`);
            continue;
        }
        if (isSticker && !s.allowSticker) {
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowSticker is OFF`);
            continue;
        }
        if (isAudio && !s.allowText) { // Audio sementara ikut allowText
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowAudio (allowText) is OFF`);
            continue;
        }
        if (isDocument && !s.allowText) { // Doc sementara ikut allowText
            console.log(`[DEBUG COPIER] Job ${job.id} skip: allowDocument (allowText) is OFF`);
            continue;
        }

        // Cek Limit Video (Maks 30MB)
        if (isVideo && message.videoMessage?.fileLength > 30 * 1024 * 1024) {
            logger.warn(`[COPIER] Video dari ${remoteJid} terlalu besar (${message.videoMessage.fileLength} bytes), skip.`);
            continue;
        }

        // Proses pengiriman async per job
        (async () => {
            try {
                let finalCaption = textContent;
                if (s.rewriteText && finalCaption) finalCaption = await rewriteWithGemini(finalCaption);

                let sendObj = null;
                if (isText) {
                    sendObj = { text: finalCaption };
                } else {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                    if (isSticker) {
                        sendObj = { sticker: await addExif(buffer, s.stickerPack, s.stickerAuthor) };
                    } else if (isImage) {
                        sendObj = { image: buffer, caption: finalCaption };
                    } else if (isVideo) {
                        sendObj = { video: buffer, caption: finalCaption };
                    } else if (isAudio) {
                        let audioBuffer = buffer;
                        let duration = message.audioMessage?.seconds || 0;
                        
                        // Jika bukan ogg/opus atau bukan ptt, konversi agar bisa di-share ke status
                        if (!message.audioMessage?.mimetype?.includes('ogg') || !message.audioMessage?.ptt) {
                            try {
                                audioBuffer = await convertToOggOpus(buffer);
                                duration = await getAudioDuration(audioBuffer);
                                if (!duration || duration < 1) duration = await getAudioDuration(buffer) || 1;
                            } catch (e) {
                                logger.error(`[COPIER] Gagal konversi audio: ${e.message}`);
                            }
                        }

                        if (!duration || duration < 1) duration = 1;

                        sendObj = { 
                            audio: audioBuffer, 
                            mimetype: 'audio/ogg; codecs=opus', 
                            ptt: true,
                            seconds: Math.floor(duration),
                            waveform: undefined,
                            contextInfo: {
                                isForwarded: true,
                                forwardingScore: 1
                            }
                        };
                    } else if (isDocument) {
                        sendObj = { document: buffer, mimetype: message.documentMessage?.mimetype, fileName: message.documentMessage?.fileName, caption: finalCaption };
                    }
                }

                if (sendObj) {
                    const sendToTarget = async () => {
                        try { await sock.sendMessage(job.targetJid, sendObj); } 
                        catch (e) { logger.error(`[COPIER] Gagal kirim ke ${job.targetJid}: ${e.message}`); }
                    };

                    if (s.delayMinutes > 0) {
                        setTimeout(sendToTarget, s.delayMinutes * 60000);
                    } else {
                        await sendToTarget();
                    }
                }
            } catch (e) { logger.error(`[COPIER] Error processing job ${job.id}: ${e.message}`); }
        })();
    }
    return true;
}

async function handleCommand(sock, remoteJid, msg, textContent, senderIsOwner) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const cleanSender = cfg.cleanNumber(sender);
    const prefix = cfg.getConfig().prefix || '.';
    
    // Normalisasi command (case-insensitive)
    const lowerText = textContent.toLowerCase().trim();
    if (!lowerText.startsWith(prefix + 'copier')) return false;

    const args = textContent.trim().split(/\s+/);
    const cmd = args[1]?.toLowerCase();
    const isVIP = db.vips.includes(cleanSender) || senderIsOwner;

    console.log(`\n[DEBUG COPIER] Command detected!`);
    console.log(`[DEBUG COPIER] Text: "${textContent}"`);
    console.log(`[DEBUG COPIER] Sender: ${cleanSender}, Owner: ${senderIsOwner}, VIP: ${isVIP}`);

    // Akses publik terbatas
    if (!isVIP && cmd !== 'status' && cmd !== 'list' && cmd !== undefined) {
        return sock.sendMessage(remoteJid, { text: `❌ Maaf, fitur Auto Copier ini terbatas. Hubungi Owner untuk mendapatkan akses.` }, { quoted: msg });
    }

    if (!cmd) {
        const menu = `🔄 *MULTI-COPIER DASHBOARD*\n\n` +
            `Fitur untuk menyalin otomatis pesan antar saluran.\n\n` +
            `*Perintah:*\n` +
            `┣⌬ ${prefix}copier add <src_jid> <target_jid>\n` +
            `┣⌬ ${prefix}copier list (Cek ID tugasmu)\n` +
            `┣⌬ ${prefix}copier status <id> (Cek detail)\n` +
            `┣⌬ ${prefix}copier set <id> <key> <val>\n` +
            `┣⌬ ${prefix}copier on/off <id>\n` +
            `┣⌬ ${prefix}copier delete <id>\n` +
            `┣⌬ ${prefix}copier deleteall (Hapus semua list)\n\n` +
            `*Keys for setting:*\n` +
            `delay (menit), rewrite (on/off), skipurl (on/off),\n` +
            `allowText, allowImage, allowVideo, allowSticker (on/off)\n\n` +
            (senderIsOwner ? `*Owner Only:*\n┣⌬ ${prefix}copier vip add/del <nomor>` : '');
        await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
        return true;
    }

    if (cmd === 'vip' && senderIsOwner) {
        const sub = args[2]?.toLowerCase();
        const num = cfg.cleanNumber(args[3]);
        if (!num) return sock.sendMessage(remoteJid, { text: `❌ Masukkan nomor!` }, { quoted: msg });
        
        if (sub === 'add') {
            if (!db.vips.includes(num)) db.vips.push(num);
            saveDB();
            await sock.sendMessage(remoteJid, { text: `✅ ${num} sekarang punya akses VIP Copier.` }, { quoted: msg });
        } else {
            db.vips = db.vips.filter(v => v !== num);
            saveDB();
            await sock.sendMessage(remoteJid, { text: `✅ Akses VIP ${num} dicabut.` }, { quoted: msg });
        }
        return true;
    }

    if (cmd === 'add') {
        const src = args[2];
        const target = args[3];
        if (!src?.endsWith('@newsletter') || !target?.endsWith('@newsletter')) {
            return sock.sendMessage(remoteJid, { text: `❌ Format: ${prefix}copier add <src_jid> <target_jid>\nGunakan JID berakhiran @newsletter` }, { quoted: msg });
        }
        const id = 'CP-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const newJob = {
            id,
            creator: cleanSender,
            sourceJid: src,
            targetJid: target,
            active: true,
            settings: {
                delayMinutes: 0,
                rewriteText: false,
                skipLinks: false,
                allowText: true,
                allowImage: true,
                allowVideo: false,
                allowSticker: true,
                stickerPack: 'Copied By Robby',
                stickerAuthor: 'Robby Bot'
            }
        };
        db.jobs.push(newJob);
        saveDB();
        await sock.sendMessage(remoteJid, { text: `✅ Tugas ditambahkan!\nID: *${id}*\nSumber: ${src}\nTarget: ${target}\n\nKetik *${prefix}copier status ${id}* untuk detail.` }, { quoted: msg });
        return true;
    }

    if (cmd === 'list') {
        const myJobs = db.jobs.filter(j => j.creator === cleanSender || senderIsOwner);
        if (myJobs.length === 0) return sock.sendMessage(remoteJid, { text: `❌ Kamu belum punya tugas copier.` }, { quoted: msg });
        let txt = `📋 *DAFTAR TUGAS COPIER KAMU*\n\n`;
        myJobs.forEach(j => {
            txt += `┣⌬ ID: *${j.id}*\n┃  Target: ${j.targetJid.substring(0,15)}...\n┃  Status: ${j.active ? '✅ AKTIF' : '❌ MATI'}\n\n`;
        });
        await sock.sendMessage(remoteJid, { text: txt }, { quoted: msg });
        return true;
    }

    if (cmd === 'status') {
        const id = args[2]?.toUpperCase();
        const job = db.jobs.find(j => j.id === id && (j.creator === cleanSender || senderIsOwner));
        if (!job) return sock.sendMessage(remoteJid, { text: `❌ Tugas dengan ID ${id} tidak ditemukan.` }, { quoted: msg });
        const s = job.settings;
        const info = `📊 *CONFIG COPIER: ${id}*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `• Status: *${job.active ? '✅ AKTIF' : '❌ MATI'}*\n` +
            `• Sumber: ${job.sourceJid}\n` +
            `• Tujuan: ${job.targetJid}\n` +
            `• Creator: ${job.creator}\n\n` +
            `*Media Terizinkan:*\n` +
            `  [ Teks: ${s.allowText ? '✅' : '❌'} ] [ Gambar: ${s.allowImage ? '✅' : '❌'} ]\n` +
            `  [ Video: ${s.allowVideo ? '✅' : '❌'} ] [ Stiker: ${s.allowSticker ? '✅' : '❌'} ]\n\n` +
            `*Lainnya:*\n` +
            `• Delay: ${s.delayMinutes} menit\n` +
            `• AI Rewrite: ${s.rewriteText ? 'ON' : 'OFF'}\n` +
            `• Skip Link: ${s.skipLinks ? 'ON' : 'OFF'}\n` +
            `• Metadata Stiker: ${s.stickerPack} | ${s.stickerAuthor}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_Gunakan perintah .copier set ${id} <key> <val> untuk mengubah._`;
        await sock.sendMessage(remoteJid, { text: info }, { quoted: msg });
        return true;
    }

    if (cmd === 'on' || cmd === 'off') {
        const id = args[2]?.toUpperCase();
        const job = db.jobs.find(j => j.id === id && (j.creator === cleanSender || senderIsOwner));
        if (!job) return sock.sendMessage(remoteJid, { text: `❌ ID tidak valid.` }, { quoted: msg });
        job.active = (cmd === 'on');
        saveDB();
        await sock.sendMessage(remoteJid, { text: `✅ Tugas ${id} telah di-*${job.active ? 'AKTIFKAN' : 'MATIKAN'}*.` }, { quoted: msg });
        return true;
    }

    if (cmd === 'delete') {
        const id = args[2]?.toUpperCase();
        const idx = db.jobs.findIndex(j => j.id === id && (j.creator === cleanSender || senderIsOwner));
        if (idx === -1) return sock.sendMessage(remoteJid, { text: `❌ ID tidak valid.` }, { quoted: msg });
        db.jobs.splice(idx, 1);
        saveDB();
        await sock.sendMessage(remoteJid, { text: `✅ Tugas ${id} berhasil dihapus.` }, { quoted: msg });
        return true;
    }

    if (cmd === 'deleteall') {
        const countBefore = db.jobs.length;
        if (senderIsOwner) {
            db.jobs = [];
        } else {
            db.jobs = db.jobs.filter(j => j.creator !== cleanSender);
        }
        const countAfter = db.jobs.length;
        const deleted = countBefore - countAfter;
        saveDB();
        await sock.sendMessage(remoteJid, { text: `✅ Berhasil menghapus ${deleted} tugas copier.` }, { quoted: msg });
        return true;
    }

    if (cmd === 'set') {
        const id = args[2]?.toUpperCase();
        const key = args[3];
        const rawVal = args.slice(4).join(' ').toLowerCase().trim();
        const job = db.jobs.find(j => j.id === id && (j.creator === cleanSender || senderIsOwner));
        if (!job) return sock.sendMessage(remoteJid, { text: `❌ ID tidak valid.` }, { quoted: msg });

        const s = job.settings;
        let success = true;
        const isOn = (rawVal === 'on' || rawVal === 'true' || rawVal === '1' || rawVal === 'aktif' || rawVal === 'yes');

        switch(key) {
            case 'delay': s.delayMinutes = parseInt(rawVal) || 0; break;
            case 'rewrite': s.rewriteText = isOn; break;
            case 'skipurl': s.skipLinks = isOn; break;
            case 'allowtext': 
            case 'allowText': s.allowText = isOn; break;
            case 'allowimage':
            case 'allowImage': s.allowImage = isOn; break;
            case 'allowvideo':
            case 'allowVideo': 
                if (isVIP) s.allowVideo = isOn; 
                else {
                    return sock.sendMessage(remoteJid, { text: `❌ Kamu tidak punya akses VIP untuk mengaktifkan fitur Video.` }, { quoted: msg });
                }
                break;
            case 'allowsticker':
            case 'allowSticker': s.allowSticker = isOn; break;
            case 'sticker': 
                const p = args.slice(4).join(' ').split('|');
                if (p.length < 2) { success = false; break; }
                s.stickerPack = p[0].trim(); s.stickerAuthor = p[1].trim();
                break;
            case 'on': 
            case 'aktif':
                job.active = true; break;
            case 'off':
            case 'mati':
                job.active = false; break;
            default: success = false;
        }

        if (success) {
            saveDB();
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil update settingan *${key}* untuk tugas ${id}.\nKetik *.copier status ${id}* untuk melihat perubahan.` }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, { text: `❌ Gagal update. Key/Value tidak dikenali.\nContoh: *.copier set ${id} allowText on*` }, { quoted: msg });
        }
        return true;
    }

    return false;
}

module.exports = { handleCopier, handleCommand };
