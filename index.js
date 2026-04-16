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
const { convertToSticker, createStickerWithText, createAnimatedSticker, createAnimatedStickerWithText } = require('./src/features/sticker');
const { getTikTokAudio, getTikTokVideo } = require('./src/features/tiktok');
const { convertToOggOpus, generateWaveform } = require('./src/utils/audioConverter');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

// ============================================================
// KONFIGURASI
// ============================================================
const CHANNEL_JID   = process.env.CHANNEL_JID   || '';
const OWNER_NUMBER  = process.env.OWNER_NUMBER   || '';
const BOT_NAME      = process.env.BOT_NAME       || 'Robby Bot';
const PREFIX        = process.env.PREFIX         || '.';

// Folder penyimpanan sesi (cookie / auth) - akan di-persist untuk login 1x
const SESSION_DIR = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Cache pesan sederhana (untuk getMessage fallback)
const msgCache = new Map();

// ============================================================
// START BOT
// ============================================================
async function startBot() {
    // Muat state auth dari folder session (cookie otomatis disimpan di sini)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

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
                // --- Filter dasar (anti-ban & keamanan) ---
                if (!shouldProcess(msg, sock)) continue;
                if (!rateLimiter.canProceed()) {
                    logger.warn('🚫 Rate limit, skip pesan ini');
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                const message   = msg.message;

                if (!message) continue;

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

                if (textContent.startsWith(PREFIX + 'kirim')) {
                    // Ambil JID target dari argumen, atau pakai default dari .env
                    const parts       = textContent.trim().split(/\s+/);
                    const targetJid   = parts[1]?.trim() || CHANNEL_JID;

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
                    const cmdParts   = textContent.split(' ');
                    const stickerText = cmdParts.slice(1).join(' ').trim();

                    // Cek ketersediaan media (gambar atau video)
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg  = message.imageMessage || message.videoMessage || quotedMsg?.imageMessage || quotedMsg?.videoMessage;
                    
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
                    if (caption.startsWith(PREFIX + 'sticker') || caption.startsWith(PREFIX + 's')) {
                        const cmdParts    = caption.split(' ');
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
                // BANTUAN: .help atau .menu
                // -----------------------------------------------
                if (textContent === PREFIX + 'help' || textContent === PREFIX + 'menu') {
                    await simulateTyping(sock, remoteJid, 1000);
                    await randomDelay(500, 1200);

                    const helpText = `🤖 *${BOT_NAME}* - Daftar Perintah\n\n` +
                        `📌 *Sticker*\n` +
                        `  • Kirim/quote gambar atau video + ketik:\n` +
                        `    \`${PREFIX}sticker\` → sticker biasa / gerak\n` +
                        `    \`${PREFIX}sticker teksmu\` → sticker + teks di atas\n\n` +
                        `🎵 *Kirim Audio/Stiker ke Saluran*\n` +
                        `  • Reply pesan voice note ATAU stiker, lalu ketik:\n` +
                        `    \`${PREFIX}kirim\` → kirim ke channel default (${CHANNEL_JID || 'belum diatur'})\n` +
                        `    \`${PREFIX}kirim 628xxx@newsletter\` → kirim ke channel pilihan\n\n` +
                        `🎬 *TikTok Downloader*\n` +
                        `  • Download video TikTok tanpa watermark:\n` +
                        `    \`${PREFIX}tiktok <link_tiktok>\`\n` +
                        `  • Ekstrak sound/music dari TikTok:\n` +
                        `    \`${PREFIX}ttaudio <link_tiktok>\`\n\n` +
                        `📡 *Cek JID Saluran*\n` +
                        `  • Forward postingan dari saluran ke sini, lalu ketik:\n` +
                        `    \`${PREFIX}cekjid\` → tampilkan JID saluran tersebut\n\n` +
                        `ℹ️ *Info*\n` +
                        `  • Bot berjalan 24/7 dengan session tersimpan\n` +
                        `  • Owner: ${OWNER_NUMBER || 'belum diatur'}`;

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
