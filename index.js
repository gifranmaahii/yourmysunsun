require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { logger, baileyLogger } = require('./src/utils/logger');
const { randomDelay, simulateTyping, rateLimiter, shouldProcess } = require('./src/utils/antiBan');
const cfg = require('./src/utils/config');
const { convertToSticker, createStickerWithText, createAnimatedSticker, createAnimatedStickerWithText } = require('./src/features/sticker');
const { removeBackgroundImage, removeBackgroundVideo, removeBackgroundVideoAI, detectDominantBgColor, checkRemoveBgCredits, resetRemoveBgStatus } = require('./src/features/removebg');
const { getTikTokAudio, getTikTokVideo } = require('./src/features/tiktok');
const { generateTextImage, generateBratImage } = require('./src/features/textImage');
const { convertToOggOpus, generateWaveform } = require('./src/utils/audioConverter');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

// ============================================================
// KONFIGURASI
// ============================================================
const CHANNEL_JID = process.env.CHANNEL_JID || '';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
const BOT_NAME = process.env.BOT_NAME || 'Robby Bot';
const PREFIX = process.env.PREFIX || '.';

// Folder penyimpanan sesi (cookie / auth) - akan di-persist untuk login 1x
const SESSION_DIR = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Cache pesan sederhana (untuk getMessage fallback)
const msgCache = new Map();

// ============================================================
// HELPER: Ekstrak frame pertama dari video (untuk auto-detect bg color)
// ============================================================
const ffmpegPath = require('fluent-ffmpeg');
const { randomBytes: _rb } = require('crypto');

async function extractFirstFrame(videoBuffer) {
    const { randomBytes } = require('crypto');
    const tempId = randomBytes(6).toString('hex');
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inPath = path.join(tempDir, `ff_in_${tempId}.mp4`);
    const outPath = path.join(tempDir, `ff_out_${tempId}.png`);

    return new Promise((resolve, reject) => {
        try {
            fs.writeFileSync(inPath, videoBuffer);
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg(inPath)
                .outputOptions(['-vframes', '1', '-f', 'image2'])
                .on('end', () => {
                    try {
                        const buf = fs.readFileSync(outPath);
                        try { fs.unlinkSync(inPath); } catch (_) { }
                        try { fs.unlinkSync(outPath); } catch (_) { }
                        resolve(buf);
                    } catch (e) { reject(e); }
                })
                .on('error', (err) => {
                    try { fs.unlinkSync(inPath); } catch (_) { }
                    try { fs.unlinkSync(outPath); } catch (_) { }
                    reject(err);
                })
                .save(outPath);
        } catch (e) {
            try { fs.unlinkSync(inPath); } catch (_) { }
            reject(e);
        }
    });
}

// ============================================================
// HELPER: Tambah EXIF ke buffer WebP (untuk sticker animated)
// ============================================================
async function addExifToWebp(webpBuffer) {
    try {
        const webp = require('node-webpmux');
        // Baca nama sticker dari config (bisa diubah via .owner setsticker)
        const { stickerPackName, stickerPackAuthor, botName: _bn } = cfg.getConfig();
        const img = new webp.Image();
        await img.load(webpBuffer);
        const json = {
            'sticker-pack-id': 'robby-bot',
            'sticker-pack-name': stickerPackName || 'Robby Bot',
            'sticker-pack-publisher': stickerPackAuthor || 'Robby Bot',
            'emojis': ['🎬']
        };
        const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
        const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
        const exif = Buffer.concat([exifAttr, jsonBuff]);
        exif.writeUIntLE(jsonBuff.length, 14, 4);
        img.exif = exif;
        return await img.save(null);
    } catch (_) {
        return webpBuffer;
    }
}

// ============================================================
// HELPER: Tambah teks ke sticker remove-bg (preserves transparency)
// Menggunakan sharp + SVG composite agar background tetap transparan
// ============================================================
async function addTextToRmbgSticker(pngBuffer, text) {
    if (!text || !text.trim()) return pngBuffer;

    const sharp = require('sharp');

    // Resize ke 512x512 fit:contain dengan background transparan
    const base = await sharp(pngBuffer)
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .ensureAlpha()
        .png()
        .toBuffer();

    const safeText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 60); // maks 60 karakter

    const fontSize = Math.max(24, Math.min(48, Math.floor(480 / safeText.length)));
    const bannerH = fontSize + 24;
    const bannerY = 512 - bannerH - 8; // teks di bawah gambar

    // Banner putih semi-transparan dengan teks hitam tebal
    const svgBanner = Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="512" height="${bannerH}">
            <rect x="0" y="0" width="512" height="${bannerH}"
                  fill="white" fill-opacity="0.85" rx="10" ry="10"/>
            <text x="256" y="${fontSize + 4}"
                  font-family="Arial Black,Arial,sans-serif"
                  font-size="${fontSize}" font-weight="900"
                  fill="#111" text-anchor="middle">${safeText}</text>
        </svg>
    `);

    return await sharp(base)
        .composite([{ input: svgBanner, top: bannerY, left: 0 }])
        .png()
        .toBuffer();
}

// ============================================================
// START BOT
// ============================================================
async function startBot() {
    // Muat state auth dari folder session (cookie otomatis disimpan di sini)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    // Init config (merge .env defaults + data/config.json)
    cfg.initConfig({
        botName:           process.env.BOT_NAME       || 'Robby Bot',
        stickerPackName:   process.env.BOT_NAME       || 'Robby Bot',
        stickerPackAuthor: process.env.BOT_NAME       || 'Robby Bot',
        ownerNumber:       process.env.OWNER_NUMBER   || '',
        channelJid:        process.env.CHANNEL_JID    || '',
        prefix:            process.env.PREFIX         || '.',
    });

    // Ambil versi Baileys terbaru
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`🤖 ${BOT_NAME} menggunakan Baileys v${version} (latest: ${isLatest})`);

    // Buat socket WA
    const sock = makeWASocket({
        version,
        auth: state,
        logger: baileyLogger,           // silent – tidak spam terminal
        printQRInTerminal: true,        // QR tampil di terminal untuk scan 1x
        browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
        syncFullHistory: false,         // Tidak perlu history penuh (lebih aman)
        markOnlineOnConnect: false,     // Jangan langsung online (anti-ban)
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
            // Fallback dari cache sederhana
            return msgCache.get(key.id) || undefined;
        },
    });

    // ============================================================
    // EVENT: Update koneksi
    // ============================================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Tampilkan QR code di terminal menggunakan qrcode-terminal
            qrcode.generate(qr, { small: true });
            logger.info('📱 Scan QR code di atas untuk login WhatsApp');
            logger.info('💾 Setelah login, sesi akan disimpan otomatis (tidak perlu scan ulang)');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            logger.warn(`⚠️ Koneksi terputus (kode: ${code}). Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                // Reconnect dengan delay supaya tidak terlalu agresif (anti-ban)
                const delay = Math.floor(Math.random() * 5000) + 3000;
                logger.info(`🔄 Mencoba reconnect dalam ${delay}ms...`);
                setTimeout(startBot, delay);
            } else {
                logger.error('🚫 Session logout. Hapus folder "session" dan scan QR ulang.');
            }
        }

        if (connection === 'open') {
            logger.info(`✅ ${BOT_NAME} berhasil terhubung ke WhatsApp!`);
            logger.info(`📡 Channel target: ${CHANNEL_JID || '(belum diatur)'}`);
            logger.info(`👤 Owner: ${OWNER_NUMBER}`);
        }
    });

    // ============================================================
    // EVENT: Simpan credentials (session/cookie) setiap update
    // ============================================================
    sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // EVENT: Pesan masuk
    // ============================================================
    sock.ev.on('messages.upsert', async (upsert) => {
        // Hanya proses pesan baru (bukan notifikasi sinkronisasi)
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            try {
                // [DEBUG] Log setiap pesan masuk sebelum difilter
                const _dbgFrom = msg.key?.remoteJid || 'unknown';
                const _dbgFromMe = msg.key?.fromMe;
                const _dbgTs = msg.messageTimestamp;
                const _dbgNow = Math.floor(Date.now() / 1000);
                const _dbgAge = _dbgNow - parseInt(_dbgTs?.toString() || '0');
                console.log(`[MSG-IN] from=${_dbgFrom} fromMe=${_dbgFromMe} age=${_dbgAge}s type=${upsert.type}`);

                // --- Filter dasar (anti-ban & keamanan) ---
                if (!shouldProcess(msg, sock)) {
                    console.log(`[MSG-SKIP] shouldProcess=false`);
                    continue;
                }
                if (!rateLimiter.canProceed()) {
                    logger.warn('🚫 Rate limit, skip pesan ini');
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                const message = msg.message;

                if (!message) {
                    console.log(`[MSG-SKIP] message=null`);
                    continue;
                }

                // Cache pesan untuk getMessage fallback
                if (msg.key.id) msgCache.set(msg.key.id, message);

                // -----------------------------------------------
                // FITUR 1: FORWARD AUDIO MANUAL — .kirim [JID_channel]
                // Cara pakai: reply pesan audio + ketik .kirim
                //             atau .kirim 628xxx@newsletter untuk channel lain
                // -----------------------------------------------
                const textContent =
                    message.conversation ||
                    message.extendedTextMessage?.text ||
                    '';

                // ── Gunakan config dinamis (bisa diubah via .owner) ──────────────
                const activeCfg   = cfg.getConfig();
                const ACTIVE_NAME = activeCfg.botName || BOT_NAME;

                // ── Ekstrak nomor pengirim & cek akses ───────────────────────────
                // Grup: pengirim dari msg.key.participant; DM: dari remoteJid
                const senderJid    = msg.key.participant || msg.key.remoteJid || '';
                const senderIsOwner = cfg.isOwner(senderJid);
                const senderIsAdmin = cfg.isAdmin(senderJid);

                // Jika bukan owner dan bukan admin → abaikan pesan ini
                if (!senderIsOwner && !senderIsAdmin) {
                    continue; // diam, jangan balas
                }

                // ── Handler .owner (KHUSUS OWNER) ────────────────────────────────
                if (textContent.startsWith(PREFIX + 'owner')) {
                    if (!senderIsOwner) {
                        // Bukan owner: diam saja
                        continue;
                    }

                    const ownerArgs  = textContent.trim().split(/\s+/);
                    const ownerCmd   = ownerArgs[1]?.toLowerCase() || '';
                    const ownerVal   = ownerArgs.slice(2).join(' ').trim();

                    await simulateTyping(sock, remoteJid, 600);

                    // Tampilkan menu utama .owner
                    if (!ownerCmd) {
                        const cur = cfg.getConfig();
                        await sock.sendMessage(remoteJid, { text:
`⚙️ *Owner Settings Panel*

📛 *Bot & Sticker*
  \`${PREFIX}owner setname [nama]\` → ubah nama bot
  \`${PREFIX}owner setsticker [nama]\` → ubah nama sticker pack
  \`${PREFIX}owner setauthor [nama]\` → ubah author sticker

👥 *Admin*
  \`${PREFIX}owner addadmin [nomor]\` → tambah admin
  \`${PREFIX}owner deladmin [nomor]\` → hapus admin
  \`${PREFIX}owner listadmin\` → daftar admin

📊 *Settingan Saat Ini:*
  • Nama bot: *${cur.botName}*
  • Sticker pack: *${cur.stickerPackName}*
  • Sticker author: *${cur.stickerPackAuthor}*
  • Jumlah admin: *${cur.admins.length} orang*
  • Owner: *${cur.ownerNumber}*`
                        }, { quoted: msg });
                        continue;
                    }

                    // --- .owner setname ---
                    if (ownerCmd === 'setname') {
                        if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setname NamaBot*` }, { quoted: msg });
                        } else {
                            cfg.update('botName', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Nama bot diubah menjadi: *${ownerVal}*` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner setsticker ---
                    if (ownerCmd === 'setsticker') {
                        if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setsticker NamaPackSticker*` }, { quoted: msg });
                        } else {
                            cfg.update('stickerPackName', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Nama sticker pack: *${ownerVal}*\n📌 Berlaku untuk sticker baru (sticker lama tidak berubah)` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner setauthor ---
                    if (ownerCmd === 'setauthor') {
                        if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setauthor NamaCopyrightMu*` }, { quoted: msg });
                        } else {
                            cfg.update('stickerPackAuthor', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Author sticker: *${ownerVal}*` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner addadmin ---
                    if (ownerCmd === 'addadmin') {
                        const num = ownerArgs[2] || '';
                        if (!num) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner addadmin 6281234567890*` }, { quoted: msg });
                        } else {
                            const admins = cfg.addAdmin(num);
                            await sock.sendMessage(remoteJid, { text: `✅ *${cfg.cleanNumber(num)}* ditambahkan sebagai admin!\n👥 Total admin: ${admins.length}` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner deladmin ---
                    if (ownerCmd === 'deladmin') {
                        const num = ownerArgs[2] || '';
                        if (!num) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner deladmin 6281234567890*` }, { quoted: msg });
                        } else {
                            const admins = cfg.removeAdmin(num);
                            await sock.sendMessage(remoteJid, { text: `✅ *${cfg.cleanNumber(num)}* dihapus dari admin.\n👥 Sisa admin: ${admins.length}` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner listadmin ---
                    if (ownerCmd === 'listadmin') {
                        const admins = cfg.getConfig().admins;
                        if (admins.length === 0) {
                            await sock.sendMessage(remoteJid, { text: `👥 Belum ada admin.\nGunakan *${PREFIX}owner addadmin [nomor]* untuk menambah.` }, { quoted: msg });
                        } else {
                            const list = admins.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
                            await sock.sendMessage(remoteJid, { text: `👥 *Daftar Admin (${admins.length} orang):*\n${list}` }, { quoted: msg });
                        }
                        continue;
                    }

                    // Default: perintah tidak dikenal
                    await sock.sendMessage(remoteJid, { text: `❓ Perintah tidak dikenal.\nKetik *${PREFIX}owner* untuk melihat menu.` }, { quoted: msg });
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'kirim')) {
                    // Ambil JID target dari argumen, atau pakai default dari .env
                    const parts = textContent.trim().split(/\s+/);
                    const targetJid = parts[1]?.trim() || CHANNEL_JID;

                    if (!targetJid) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Channel belum diatur.\nGunakan: *${PREFIX}kirim <JID_channel>*\nContoh: ${PREFIX}kirim 628xxx@newsletter`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Periksa apakah user me-reply audio atau sticker
                    const quotedCtx = message.extendedTextMessage?.contextInfo;
                    const quotedAudio = quotedCtx?.quotedMessage?.audioMessage;
                    const quotedSticker = quotedCtx?.quotedMessage?.stickerMessage;

                    if (!quotedAudio && !quotedSticker) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* pesan audio/voice note atau stiker, lalu ketik *${PREFIX}kirim* [jid_saluran]`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Buat ulang objek pesan quoted agar bisa di-download
                    const quotedMsgObj = {
                        key: {
                            remoteJid: remoteJid,
                            id: quotedCtx.stanzaId,
                            fromMe: quotedCtx.participant === sock.user?.id,
                            participant: quotedCtx.participant,
                        },
                        message: quotedCtx.quotedMessage,
                    };

                    await simulateTyping(sock, remoteJid, 800);

                    logger.info(`⬇️ Mulai download media yang di-reply untuk dikirim ke ${targetJid}`);

                    const mediaBuffer = await downloadMediaMessage(
                        quotedMsgObj,
                        'buffer',
                        {},
                        { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                    );

                    if (!mediaBuffer) {
                        await sock.sendMessage(remoteJid, {
                            text: '❌ Gagal download media. Coba lagi.',
                        }, { quoted: msg });
                        continue;
                    }

                    await randomDelay(500, 1500);

                    if (quotedAudio) {
                        // PENGIRIMAN AUDIO KE CHANNEL
                        await sock.sendMessage(remoteJid, { text: '⏳ Mengkonversi audio untuk channel...' }, { quoted: msg });
                        logger.info('🔄 Mengkonversi audio ke OGG Opus Mono untuk channel...');

                        let channelAudioBuffer;
                        try {
                            channelAudioBuffer = await convertToOggOpus(mediaBuffer);
                            logger.info(`✅ Konversi OGG Opus Mono berhasil: ${channelAudioBuffer.length} bytes`);
                        } catch (convErr) {
                            logger.warn(`⚠️ Gagal konversi OGG Opus, kirim buffer asli: ${convErr.message}`);
                            channelAudioBuffer = mediaBuffer;
                        }

                        logger.info(`📡 Mengirim OGG Opus ke channel: ${targetJid}`);
                        await sock.sendMessage(targetJid, {
                            audio: channelAudioBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                            waveform: generateWaveform(),
                        });

                    } else if (quotedSticker) {
                        // PENGIRIMAN STIKER KE CHANNEL
                        await sock.sendMessage(remoteJid, { text: '⏳ Mengirim stiker ke channel...' }, { quoted: msg });
                        logger.info(`📡 Mengirim stiker ke channel: ${targetJid}`);

                        await sock.sendMessage(targetJid, {
                            sticker: mediaBuffer
                        });
                    }

                    // Konfirmasi ke pengirim
                    await sock.sendMessage(remoteJid, {
                        text: `✅ ${quotedAudio ? 'Audio' : 'Stiker'} berhasil dikirim ke saluran:\n\`${targetJid}\``,
                    }, { quoted: msg });

                    logger.info(`📤 Media berhasil dikirim ke saluran: ${targetJid}`);
                    continue;
                }

                // -----------------------------------------------
                // FITUR 2 & 3: STICKER DARI PERINTAH TEKS
                // Perintah: .sticker [teks opsional]
                // -----------------------------------------------

                if (textContent.startsWith(PREFIX + 'sticker') || textContent.startsWith(PREFIX + 's')) {
                    // Ambil teks opsional setelah command
                    const cmdParts = textContent.split(' ');
                    const stickerText = cmdParts.slice(1).join(' ').trim();

                    // Cek ketersediaan media (gambar atau video)
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg = message.imageMessage || message.videoMessage || quotedMsg?.imageMessage || quotedMsg?.videoMessage;

                    const isVideo = message.videoMessage || quotedMsg?.videoMessage;

                    if (!mediaMsg) {
                        await randomDelay(500, 1500);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Kirim gambar/video sambil ketik perintah, atau quote gambar/video dengan perintah:\n\n*${PREFIX}sticker* - sticker biasa/gerak\n*${PREFIX}sticker teks kamu* - sticker dengan teks di atas (hanya untuk gambar)`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Batasi durasi jika video (mencegah rendering yang terlalu lama)
                    const videoDuration = isVideo?.seconds || 0;
                    if (isVideo && videoDuration > 10) {
                        await sock.sendMessage(remoteJid, { text: '❌ Durasi video maksimal 10 detik untuk dijadikan sticker gerak.' }, { quoted: msg });
                        continue;
                    }

                    // Download gambar atau video
                    // Sesuaikan root key object agar dapat di-download dengan benar walau dari quote
                    let downloadKey;
                    if (message.imageMessage || message.videoMessage) {
                        downloadKey = msg;
                    } else if (quotedMsg?.imageMessage || quotedMsg?.videoMessage) {
                        downloadKey = {
                            message: quotedMsg,
                            key: {
                                remoteJid: msg.key.remoteJid,
                                id: message.extendedTextMessage.contextInfo.stanzaId,
                                participant: message.extendedTextMessage.contextInfo.participant
                            }
                        };
                    }

                    const mediaBuffer = await downloadMediaMessage(
                        downloadKey,
                        'buffer',
                        {},
                        { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                    );

                    if (!mediaBuffer) {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal download media' }, { quoted: msg });
                        continue;
                    }

                    // Simulate typing sebelum reply (anti-ban & UX)
                    await simulateTyping(sock, remoteJid, 1500);
                    if (isVideo) {
                        await sock.sendMessage(remoteJid, { text: '⏳ Sedang membuat sticker gerak, harap tunggu...' }, { quoted: msg });
                    }
                    await randomDelay(800, 2000);

                    // Konversi ke sticker
                    let stickerBuffer;
                    try {
                        if (isVideo) {
                            if (stickerText) {
                                stickerBuffer = await createAnimatedStickerWithText(mediaBuffer, stickerText);
                            } else {
                                stickerBuffer = await createAnimatedSticker(mediaBuffer);
                            }
                        } else if (stickerText) {
                            // Sticker diam dengan teks di atas
                            stickerBuffer = await createStickerWithText(mediaBuffer, stickerText);
                        } else {
                            // Sticker biasa
                            stickerBuffer = await convertToSticker(mediaBuffer);
                        }

                        // Kirim sticker
                        await sock.sendMessage(remoteJid, {
                            sticker: stickerBuffer,
                        }, { quoted: msg });
                        logger.info(`🎨 Sticker${isVideo ? ' gerak' : ''} dikirim ke ${remoteJid}${stickerText ? ` dengan teks: "${stickerText}"` : ''}`);
                    } catch (error) {
                        await sock.sendMessage(remoteJid, { text: '❌ Terjadi kesalahan saat memproses sticker' }, { quoted: msg });
                    }

                    continue;
                }

                // -----------------------------------------------
                // FITUR: Perintah melalui gambar yang dikirim langsung
                // Jika ada imageMessage dengan caption .sticker
                // -----------------------------------------------
                if (message.imageMessage || message.videoMessage) {
                    const mediaMessageDetails = message.imageMessage || message.videoMessage;
                    const caption = mediaMessageDetails.caption || '';

                    // --- Sticker via caption ---
                    if (caption.startsWith(PREFIX + 'sticker') || caption.startsWith(PREFIX + 's')) {
                        const cmdParts = caption.split(' ');
                        const stickerText = cmdParts.slice(1).join(' ').trim();
                        const isVideo = !!message.videoMessage;

                        const videoDuration = message.videoMessage?.seconds || 0;
                        if (isVideo && videoDuration > 10) {
                            await sock.sendMessage(remoteJid, { text: '❌ Durasi video maksimal 10 detik untuk dijadikan sticker gerak.' }, { quoted: msg });
                            continue;
                        }

                        const mediaBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!mediaBuffer) {
                            await sock.sendMessage(remoteJid, { text: '❌ Gagal download media' }, { quoted: msg });
                            continue;
                        }

                        await simulateTyping(sock, remoteJid, 1200);
                        if (isVideo) {
                            await sock.sendMessage(remoteJid, { text: '⏳ Sedang membuat sticker gerak, harap tunggu...' }, { quoted: msg });
                        }
                        await randomDelay(600, 1800);

                        let stickerBuffer;
                        try {
                            if (isVideo) {
                                if (stickerText) {
                                    stickerBuffer = await createAnimatedStickerWithText(mediaBuffer, stickerText);
                                } else {
                                    stickerBuffer = await createAnimatedSticker(mediaBuffer);
                                }
                            } else if (stickerText) {
                                stickerBuffer = await createStickerWithText(mediaBuffer, stickerText);
                            } else {
                                stickerBuffer = await convertToSticker(mediaBuffer);
                            }

                            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                            logger.info(`🎨 Sticker${isVideo ? ' gerak' : ''} (dari media) dikirim ke ${remoteJid}`);
                        } catch (error) {
                            await sock.sendMessage(remoteJid, { text: '❌ Terjadi kesalahan saat memproses sticker' }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- Remove Background Gambar via caption (.rmbg [teks_opsional]) ---
                    if (
                        message.imageMessage &&
                        (caption.startsWith(PREFIX + 'rmbg') &&
                            !caption.startsWith(PREFIX + 'rmbgv'))
                    ) {
                        // Parse teks dari caption: ".rmbg Hello World" → stickerText = "Hello World"
                        const capParts = caption.trim().split(/\s+/);
                        const stickerText = capParts.slice(1).join(' ').trim();

                        await simulateTyping(sock, remoteJid, 800);
                        await sock.sendMessage(remoteJid, { text: '⏳ Sedang menghapus background gambar...' }, { quoted: msg });

                        try {
                            const imgBuf = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                            if (!imgBuf) throw new Error('Gagal download gambar');

                            const { buffer: noBgBuffer, method, creditsLeft } = await removeBackgroundImage(imgBuf);

                            // Tambah teks jika ada
                            const finalBuffer = stickerText
                                ? await addTextToRmbgSticker(noBgBuffer, stickerText)
                                : noBgBuffer;

                            const stickerBuffer = await convertToSticker(finalBuffer);
                            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });

                            let infoText = `✅ Background berhasil dihapus!\n📌 Metode: *${method}*`;
                            if (stickerText) infoText += `\n📝 Teks: *${stickerText}*`;
                            if (method.includes('remove.bg') && creditsLeft !== null) {
                                infoText += `\n💳 Sisa kredit: *${creditsLeft}*`;
                            } else if (method === 'AI Lokal') {
                                infoText += `\n🤖 Gratis & unlimited`;
                            }
                            await sock.sendMessage(remoteJid, { text: infoText }, { quoted: msg });
                            logger.info(`🎨 Sticker remove-bg dikirim ke ${remoteJid}`);
                        } catch (err) {
                            logger.error(`❌ rmbg caption error: ${err.message}`);
                            await sock.sendMessage(remoteJid, { text: `❌ Gagal hapus background: ${err.message}` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- Remove Background Video via caption (.rmbgv [warna]) ---
                    if (
                        message.videoMessage &&
                        caption.startsWith(PREFIX + 'rmbgv')
                    ) {
                        const capArgs = caption.trim().split(/\s+/);
                        const bgColorArg = capArgs[1] ? capArgs[1].replace('#', '').toLowerCase() : null;

                        const vidDuration = message.videoMessage?.seconds || 0;
                        if (vidDuration > 10) {
                            await sock.sendMessage(remoteJid, { text: '❌ Durasi video maksimal 10 detik.' }, { quoted: msg });
                            continue;
                        }

                        await simulateTyping(sock, remoteJid, 800);

                        try {
                            const vidBuf = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                            if (!vidBuf) throw new Error('Gagal download video');

                            let webpBuffer;
                            if (bgColorArg) {
                                await sock.sendMessage(remoteJid, { text: `⏳ Chromakey bg #${bgColorArg}...` }, { quoted: msg });
                                webpBuffer = await removeBackgroundVideo(vidBuf, bgColorArg, 0.15, 0.05);
                            } else {
                                await sock.sendMessage(remoteJid, { text: `⏳ Memproses AI remove background video...\n\n⚠️ Proses 30-90 detik, mohon tunggu ☕` }, { quoted: msg });
                                webpBuffer = await removeBackgroundVideoAI(vidBuf);
                            }

                            const stickerBuf = await addExifToWebp(webpBuffer);
                            await sock.sendMessage(remoteJid, { sticker: stickerBuf }, { quoted: msg });
                            logger.info(`🎬 Animated sticker remove-bg video dikirim ke ${remoteJid}`);
                        } catch (err) {
                            logger.error(`❌ rmbgv caption error: ${err.message}`);
                            await sock.sendMessage(remoteJid, { text: `❌ Gagal hapus background video: ${err.message}` }, { quoted: msg });
                        }
                        continue;
                    }
                }


                // -----------------------------------------------
                // FITUR: CEK JID SALURAN — .cekjid
                // Cara 1: Forward pesan dari saluran ke sini, lalu ketik .cekjid
                // Cara 2: Reply pesan dari saluran lalu ketik .cekjid
                // Cara 3: Ketik .cekjid di dalam saluran (jika bot admin)
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'cekjid')) {
                    await randomDelay(400, 900);

                    const foundJids = new Set();

                    // Cek 1: Apakah pesan ini dikirim langsung dari sebuah saluran
                    if (remoteJid.endsWith('@newsletter')) {
                        foundJids.add(remoteJid);
                    }

                    // Cek 2: Dari contextInfo (reply/quote ke pesan asal saluran)
                    const ctx = message.extendedTextMessage?.contextInfo;
                    if (ctx) {
                        // remoteJid dari pesan yang di-quote
                        if (ctx.remoteJid && ctx.remoteJid.endsWith('@newsletter')) {
                            foundJids.add(ctx.remoteJid);
                        }
                        // participant bisa berisi JID channel dalam beberapa kasus
                        if (ctx.participant && ctx.participant.endsWith('@newsletter')) {
                            foundJids.add(ctx.participant);
                        }
                    }

                    // Cek 3: Dari pesan yang di-forward (forwardingScore > 0)
                    // Baileys menyimpan info asal forward di berbagai tipe pesan
                    const checkForwardedJid = (msgObj) => {
                        if (!msgObj) return;
                        // Cek semua kemungkinan field yang menyimpan JID asal
                        const sources = [
                            msgObj.extendedTextMessage?.contextInfo?.remoteJid,
                            msgObj.imageMessage?.contextInfo?.remoteJid,
                            msgObj.videoMessage?.contextInfo?.remoteJid,
                            msgObj.audioMessage?.contextInfo?.remoteJid,
                            msgObj.documentMessage?.contextInfo?.remoteJid,
                            msgObj.stickerMessage?.contextInfo?.remoteJid,
                        ];
                        sources.forEach(jid => {
                            if (jid && jid.endsWith('@newsletter')) foundJids.add(jid);
                        });
                    };
                    checkForwardedJid(message);

                    // Cek 4: Dari quoted message di dalam reply
                    if (ctx?.quotedMessage) {
                        checkForwardedJid(ctx.quotedMessage);
                    }

                    if (foundJids.size === 0) {
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❓ *Cara cek JID Saluran:*\n\n` +
                                `*Cara 1 (termudah):*\n` +
                                `  1. Buka saluran WhatsApp-mu\n` +
                                `  2. Forward salah satu postingan dari saluran itu ke chat ini\n` +
                                `  3. Ketik \`${PREFIX}cekjid\`\n\n` +
                                `*Cara 2:*\n` +
                                `  1. Reply pesan dari saluran\n` +
                                `  2. Ketik \`${PREFIX}cekjid\``,
                        }, { quoted: msg });
                    } else {
                        const jidList = [...foundJids].map(j => `  \`${j}\``).join('\n');
                        await sock.sendMessage(remoteJid, {
                            text:
                                `📡 *JID Saluran ditemukan:*\n\n` +
                                `${jidList}\n\n` +
                                `💡 Salin JID di atas dan isi ke \`.env\`:\n` +
                                `\`CHANNEL_JID=<JID_di_atas>\`\n\n` +
                                `Atau langsung pakai saat kirim audio:\n` +
                                `\`${PREFIX}kirim <JID_di_atas>\``,
                        }, { quoted: msg });
                        logger.info(`📡 JID Saluran ditemukan: ${[...foundJids].join(', ')}`);
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: TEKS → GAMBAR — .teks [tulisan kamu]
                // Contoh: .teks sibuk itu cuma alasan aja dek
                // Output: gambar PNG dengan teks justified (mirip quote card)
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'teks') || textContent.startsWith(PREFIX + 'quote')) {
                    const inputText = textContent.replace(/^\.teks\s*|^\.quote\s*/i, '').trim();

                    if (!inputText) {
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ Tulis teks setelah perintah!\n\n` +
                                `Contoh:\n` +
                                `  *${PREFIX}teks sibuk itu cuma alasan aja dek*\n` +
                                `  *${PREFIX}teks lu kira gue peduli?*\n\n` +
                                `📝 Pisahkan baris dengan *|* untuk line break:\n` +
                                `  *${PREFIX}teks baris pertama|baris kedua*`
                        }, { quoted: msg });
                        continue;
                    }

                    // Ganti | dengan spasi (untuk line break manual, bisa dikembangkan nanti)
                    const cleanText = inputText.replace(/\|/g, ' ');

                    await simulateTyping(sock, remoteJid, 600);
                    await sock.sendMessage(remoteJid, { text: '🖼️ Membuat gambar dari teks...' }, { quoted: msg });

                    try {
                        const imgBuffer = generateTextImage(cleanText);

                        await randomDelay(300, 800);
                        await sock.sendMessage(remoteJid, {
                            image: imgBuffer,
                            mimetype: 'image/png',
                            caption: `📝 *${cleanText.slice(0, 60)}${cleanText.length > 60 ? '...' : ''}*`,
                        }, { quoted: msg });

                        logger.info(`🖼️ Text image dikirim ke ${remoteJid}`);
                    } catch (err) {
                        logger.error(`❌ teks error: ${err.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal buat gambar: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: BRAT TEXT — .brat [teks]
                // Style bratgenerator.com: bg putih, teks hitam bold justified
                // Output: sticker langsung
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'brat')) {
                    const bratInput = textContent.replace(/^\.brat\s*/i, '').trim();

                    if (!bratInput) {
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ Tulis teks setelah perintah!\n\n` +
                                `Contoh:\n` +
                                `  *${PREFIX}brat sibuk itu cuma alasan aja dek*\n` +
                                `  *${PREFIX}brat lu kira gue peduli?*\n\n` +
                                `📌 Output langsung jadi sticker`
                        }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 500);
                    await sock.sendMessage(remoteJid, { text: '🖼️ Membuat brat sticker...' }, { quoted: msg });

                    try {
                        const imgBuffer = generateBratImage(bratInput);
                        // Selalu kirim sebagai sticker langsung
                        const stickerBuffer = await convertToSticker(imgBuffer);
                        await randomDelay(300, 700);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                        logger.info(`🟢 Brat sticker dikirim ke ${remoteJid}`);
                    } catch (err) {
                        logger.error(`❌ brat error: ${err.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal buat brat: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: TIKTOK TO AUDIO — .ttaudio [link]
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'ttaudio') || textContent.startsWith(PREFIX + 'tt')) {
                    const args = textContent.trim().split(/\s+/);
                    const url = args[1];

                    if (!url || !url.includes('tiktok.com')) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Harap sertakan link TikTok.\n\nContoh:\n*${PREFIX}ttaudio https://vt.tiktok.com/xxxxxx*`
                        }, { quoted: msg });
                        continue;
                    }

                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengekstrak audio dari TikTok...' }, { quoted: msg });
                    await simulateTyping(sock, remoteJid, 1000);

                    try {
                        const tikTokData = await getTikTokAudio(url);

                        // ================================================
                        // STRATEGI DUAL FORMAT:
                        // 1. Kirim ke USER sebagai PTT (OGG Opus) — bisa diplay di chat biasa
                        // 2. Langsung kirim ke CHANNEL sebagai MP3 audio doc — kompatibel channel
                        // ================================================

                        await sock.sendMessage(remoteJid, { text: '🔄 Memproses audio TikTok...' }, { quoted: msg });

                        // Konversi ke OGG Opus Mono 48kHz (1 format untuk semua tujuan)
                        const oggBuffer = await convertToOggOpus(tikTokData.buffer);

                        // Kirim ke user sebagai PTT voice note
                        await sock.sendMessage(remoteJid, {
                            audio: oggBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                            waveform: generateWaveform()
                        }, { quoted: msg });

                        await randomDelay(800, 1500);

                        // Otomatis kirim ke channel sebagai OGG Opus ptt:true (jika CHANNEL_JID diset)
                        if (CHANNEL_JID) {
                            logger.info(`📡 Mengirim OGG Opus ke channel: ${CHANNEL_JID}`);
                            await sock.sendMessage(CHANNEL_JID, {
                                audio: oggBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                waveform: generateWaveform(),
                            });
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *${tikTokData.title}*\n👤 @${tikTokData.author}\n\n📡 Audio sudah otomatis dikirim ke saluran!`,
                            });
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *${tikTokData.title}* (@${tikTokData.author})\n\n💡 Untuk kirim ke saluran, *reply Voice Note* di atas lalu ketik:\n*${PREFIX}kirim*`,
                            });
                        }

                    } catch (err) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal mengambil audio: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: TIKTOK VIDEO DOWNLOADER
                // Perintah: .tiktok <url> atau .ttvideo <url>
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'tiktok') || textContent.startsWith(PREFIX + 'ttvideo')) {
                    const args = textContent.split(' ');
                    const url = args[1];

                    if (!url || !url.includes('tiktok.com')) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format salah! Gunakan: *${PREFIX}tiktok <link_tiktok>*` }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1500);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mendownload video TikTok, tunggu bentar ya...' }, { quoted: msg });

                    try {
                        const tiktokData = await getTikTokVideo(url);

                        await sock.sendMessage(remoteJid, {
                            video: tiktokData.buffer,
                            caption: `🎬 *${tiktokData.title}*\n👤 *${tiktokData.author}*`,
                            mimetype: 'video/mp4'
                        }, { quoted: msg });

                        logger.info(`✅ Video TikTok dikirim ke ${remoteJid}`);
                    } catch (error) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal memproses video: ${error.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: REMOVE BACKGROUND GAMBAR — .rmbg
                // Kirim/quote gambar + ketik .rmbg → sticker transparan
                // -----------------------------------------------
                if (
                    textContent.startsWith(PREFIX + 'rmbg') &&
                    !textContent.startsWith(PREFIX + 'rmbgv') &&
                    !textContent.startsWith(PREFIX + 'rmbgstatus') &&
                    !textContent.startsWith(PREFIX + 'rmbgreset')
                ) {
                    // Cek apakah ada gambar
                    const quotedMsg2 = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imageMsg = message.imageMessage || quotedMsg2?.imageMessage;

                    if (!imageMsg) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Kirim gambar + ketik *${PREFIX}rmbg*, atau quote gambar lalu ketik *${PREFIX}rmbg*`
                        }, { quoted: msg });
                        continue;
                    }

                    if (!process.env.REMOVEBG_API_KEY) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *REMOVEBG_API_KEY* belum diisi!\n\nDaftar gratis di: https://www.remove.bg/api\nLalu isi di file *.env*:\n\`REMOVEBG_API_KEY=kunci_api_kamu\``
                        }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang menghapus background gambar, tunggu sebentar...' }, { quoted: msg });

                    let dlKey2;
                    if (message.imageMessage) {
                        dlKey2 = msg;
                    } else {
                        dlKey2 = {
                            message: quotedMsg2,
                            key: {
                                remoteJid: msg.key.remoteJid,
                                id: message.extendedTextMessage.contextInfo.stanzaId,
                                participant: message.extendedTextMessage.contextInfo.participant
                            }
                        };
                    }

                    try {
                        const imgBuf = await downloadMediaMessage(
                            dlKey2, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!imgBuf) throw new Error('Gagal download gambar');

                        // Hapus background via remove.bg atau AI lokal (fallback otomatis)
                        const { buffer: noBgBuffer, method, creditsLeft } = await removeBackgroundImage(imgBuf);

                        // Konversi PNG transparan → WebP sticker 512x512
                        const finalBuffer2 = stickerText ? await addTextToRmbgSticker(noBgBuffer, stickerText) : noBgBuffer;
                        const stickerBuffer = await convertToSticker(finalBuffer2);

                        await randomDelay(500, 1000);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });

                        // Info metode yang dipakai
                        let infoText = `✅ Background berhasil dihapus!\n📌 Metode: *${method}*`;
                        if (method === 'remove.bg API' && creditsLeft !== null) {
                            infoText += `\n💳 Sisa kredit remove.bg: *${creditsLeft}*`;
                            if (creditsLeft <= 5) {
                                infoText += `\n⚠️ Kredit hampir habis! Otomatis beralih ke AI lokal saat habis.`;
                            }
                        } else if (method === 'AI Lokal') {
                            infoText += `\n🤖 Gratis & unlimited (tanpa API key)`;
                        }
                        await sock.sendMessage(remoteJid, { text: infoText }, { quoted: msg });

                    } catch (err) {
                        logger.error(`❌ rmbg error: ${err.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal hapus background: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: REMOVE BACKGROUND VIDEO — .rmbgv
                // Kirim/quote video + ketik .rmbgv [warna_bg] → animated sticker transparan
                // Contoh: .rmbgv ffffff  (bg putih)
                //         .rmbgv 00ff00  (green screen)
                //         .rmbgv        (auto-detect)
                // -----------------------------------------------
                if (
                    textContent.startsWith(PREFIX + 'rmbgv') ||
                    (message.videoMessage && (message.videoMessage.caption || '').startsWith(PREFIX + 'rmbgv'))
                ) {
                    const cmdText = textContent || message.videoMessage?.caption || '';
                    const args = cmdText.trim().split(/\s+/);
                    // Warna bg dari argumen (hex tanpa #), misal: ffffff, 00ff00
                    const bgColorArg = args[1] ? args[1].replace('#', '').toLowerCase() : null;

                    const quotedMsg3 = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const videoMsg = message.videoMessage || quotedMsg3?.videoMessage;

                    if (!videoMsg) {
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ Kirim/quote video + ketik perintah:\n\n` +
                                `  *${PREFIX}rmbgv* → auto-deteksi warna background\n` +
                                `  *${PREFIX}rmbgv ffffff* → hapus bg putih\n` +
                                `  *${PREFIX}rmbgv 00ff00* → green screen\n` +
                                `  *${PREFIX}rmbgv 0000ff* → blue screen\n\n` +
                                `⚠️ Hanya bekerja untuk video dengan background WARNA SOLID`
                        }, { quoted: msg });
                        continue;
                    }

                    const vidDuration = videoMsg.seconds || 0;
                    if (vidDuration > 10) {
                        await sock.sendMessage(remoteJid, { text: '❌ Durasi video maksimal 10 detik.' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses video, menghapus background...' }, { quoted: msg });

                    let dlKey3;
                    if (message.videoMessage) {
                        dlKey3 = msg;
                    } else {
                        dlKey3 = {
                            message: quotedMsg3,
                            key: {
                                remoteJid: msg.key.remoteJid,
                                id: message.extendedTextMessage.contextInfo.stanzaId,
                                participant: message.extendedTextMessage.contextInfo.participant
                            }
                        };
                    }

                    try {
                        const vidBuf = await downloadMediaMessage(
                            dlKey3, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!vidBuf) throw new Error('Gagal download video');

                        let webpBuffer;
                        if (bgColorArg) {
                            await sock.sendMessage(remoteJid, { text: `⏳ Chromakey bg #${bgColorArg}...` }, { quoted: msg });
                            webpBuffer = await removeBackgroundVideo(vidBuf, bgColorArg, 0.15, 0.05);
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `⏳ Memproses AI remove background video...\n\n🔸 Proses 30-90 detik tergantung panjang video\n🔸 Tidak perlu tentukan warna background\n☕ Mohon tunggu...`
                            }, { quoted: msg });
                            webpBuffer = await removeBackgroundVideoAI(vidBuf);
                        }

                        const stickerBuf = await addExifToWebp(webpBuffer);
                        await randomDelay(300, 800);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuf }, { quoted: msg });
                        logger.info(`🎬 Animated sticker remove-bg video (AI) dikirim ke ${remoteJid}`);

                    } catch (err) {
                        logger.error(`❌ rmbgv error: ${err.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal hapus background video: ${err.message}`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: CEK STATUS REMOVE BG — .rmbgstatus
                // -----------------------------------------------
                if (textContent === PREFIX + 'rmbgstatus' || textContent === PREFIX + 'rmbgreset') {
                    const isReset = textContent === PREFIX + 'rmbgreset';

                    if (isReset) {
                        resetRemoveBgStatus();
                    }

                    const status = await checkRemoveBgCredits();
                    let statusText = `📊 *Status Remove Background*\n\n`;

                    if (!status.hasKey) {
                        statusText += `🔑 API Key: *Tidak ada*\n`;
                        statusText += `🤖 Mode saat ini: *AI Lokal (gratis & unlimited)*\n`;
                    } else {
                        statusText += `🔑 Terdaftar: *${status.keys.length} API Key*\n`;
                        statusText += `🤖 Mode saat ini: *${status.allExhausted ? 'AI Lokal (karena semua key habis/mati)' : `API (Key #${status.activeKeyIndex + 1})`}*\n\n`;

                        statusText += `*Detail API Keys:*\n`;
                        status.keys.forEach((api, index) => {
                            const isCurrent = index === status.activeKeyIndex && !status.allExhausted;
                            const statusLabel = api.exhausted ? '❌ Habis/Mati' : (isCurrent ? '🔄 Sedang dipakai' : '⏳ Menunggu');
                            statusText += `[${index + 1}] ${api.key.substring(0, 5)}... → ${statusLabel}\n`;

                            // Tampilkan jika pernah dipakai bot di sesi ini dan kreditnya diketahui
                            if (api.creditsLeft !== null) {
                                statusText += `    └ Sisa Kredit: ${api.creditsLeft}\n`;
                            }
                        });

                        statusText += `\n🔄 Sistem Otomatis: API Keys dipakai bergantian (rotasi). Jika semua habis → pindah AI Lokal.`;
                        if (status.allExhausted) {
                            statusText += `\n\n🔃 Ketik *${PREFIX}rmbgreset* jika Anda baru menambah quota di API key lama`;
                        }
                    }

                    await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg });
                    continue;
                }

                // -----------------------------------------------
                // BANTUAN: .help atau .menu
                // -----------------------------------------------
                if (
                    textContent === PREFIX + 'help' ||
                    textContent === PREFIX + 'menu' ||
                    textContent === PREFIX + 'main'
                ) {
                    await simulateTyping(sock, remoteJid, 1000);
                    await randomDelay(500, 1200);

                    const helpText =
                        `🤖 *${BOT_NAME}* — Daftar Perintah

━━━━━━━━━━━━━━━━━━━
📌 *STICKER*
━━━━━━━━━━━━━━━━━━━
Kirim/quote foto atau video + ketik:
  \`${PREFIX}sticker\` → sticker biasa / animasi
  \`${PREFIX}sticker teksmu\` → sticker + teks

━━━━━━━━━━━━━━━━━━━
✂️ *REMOVE BACKGROUND*
━━━━━━━━━━━━━━━━━━━
🖼️ *Gambar → Sticker transparan (AI):*
  \`${PREFIX}rmbg\` → hapus bg (tanpa teks)
  \`${PREFIX}rmbg Kata-kata\` → hapus bg + teks di sticker
  \`${PREFIX}rmbgstatus\` → cek status/sisa kredit API
  \`${PREFIX}rmbgreset\` → reset status API key

🎬 *Video → Animated sticker (AI):*
  \`${PREFIX}rmbgv\` → hapus bg otomatis dengan AI
  \`${PREFIX}rmbgv ffffff\` → chromakey bg putih solid
  \`${PREFIX}rmbgv 00ff00\` → chromakey green screen

━━━━━━━━━━━━━━━━━━━
🖊️ *TEKS → GAMBAR / STICKER*
━━━━━━━━━━━━━━━━━━━
  \`${PREFIX}teks tulisanmu\` → gambar quote card (justified)
  \`${PREFIX}quote tulisanmu\` → sama dengan .teks
  \`${PREFIX}brat tulisanmu\` → sticker gaya (putih, Arial Narrow, lowercase)

━━━━━━━━━━━━━━━━━━━
🎬 *TIKTOK DOWNLOADER*
━━━━━━━━━━━━━━━━━━━
  \`${PREFIX}tiktok <link>\` → download video tanpa watermark
  \`${PREFIX}ttaudio <link>\` → ekstrak audio/musik

━━━━━━━━━━━━━━━━━━━
📡 *SALURAN / CHANNEL*
━━━━━━━━━━━━━━━━━━━
  \`${PREFIX}kirim\` → reply voice note/stiker → kirim ke channel
  \`${PREFIX}kirim 628xxx@newsletter\` → kirim ke channel lain
  \`${PREFIX}cekjid\` → cek JID saluran (forward postingan dulu)

━━━━━━━━━━━━━━━━━━━
ℹ️ *INFO*
━━━━━━━━━━━━━━━━━━━
  • Bot 24/7 dengan session tersimpan
  • Prefix: *${PREFIX}*
  • Owner: ${OWNER_NUMBER || 'belum diatur'}`;

                    await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                }

            } catch (err) {
                logger.error(`❌ Error proses pesan: ${err.message}`);
                logger.error(err.stack);
            }
        }
    });

    return sock;
}

// ============================================================
// JALANKAN BOT
// ============================================================
startBot().catch((err) => {
    logger.error(`💥 Fatal error: ${err.message}`);
    process.exit(1);
});
