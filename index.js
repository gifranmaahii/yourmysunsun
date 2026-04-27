require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    downloadContentFromMessage,
    Browsers,
    generateWAMessageContent,
} = require('@whiskeysockets/baileys');

const { logger, baileyLogger } = require('./src/utils/logger');
const { randomDelay, simulateTyping, rateLimiter, shouldProcess } = require('./src/utils/antiBan');
const cfg = require('./src/utils/config');
const { convertToSticker, createStickerWithText, createAnimatedSticker, createAnimatedStickerWithText } = require('./src/features/sticker');
const { removeBackgroundImage, removeBackgroundVideo, removeBackgroundVideoAI, detectDominantBgColor, checkRemoveBgCredits, resetRemoveBgStatus } = require('./src/features/removebg');
const { getTikTokAudio, getTikTokVideo } = require('./src/features/tiktok');
const { getInstagramMedia } = require('./src/features/instagram');
const { generateTextImage, generateBratImage } = require('./src/features/textImage');
const { convertToOggOpus, generateWaveform } = require('./src/utils/audioConverter');
const { stickerToImage, stickerToVideo } = require('./src/features/extractor');
const { lottieToImage, lottieToVideo } = require('./src/features/lottieConverter');
const { createLottieSticker, getTemplateList } = require('./src/features/lottieSticker');
const { enhanceImageHD, enhanceVideoHD } = require('./src/features/hdEnhancer');
const scheduler = require('./src/features/scheduler');
const games = require('./src/features/games');
const groupFeatures = require('./src/features/group');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { EventEmitter } = require('events');
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

// Cache pesan sederhana (untuk getMessage fallback) - Dibatasi maksimal 200 pesan agar tidak memakan RAM
const msgCache = new Map();
const MAX_CACHE_SIZE = 200;

// ============================================================
// RECONNECT & KEEPALIVE SYSTEM
// Bot otomatis reconnect ketika koneksi terputus (RDP lag, dsb)
// ============================================================
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50; // Batas percobaan sebelum restart total
let currentSock = null; // Referensi socket aktif saat ini
let keepaliveInterval = null; // Interval keepalive
let isRestarting = false; // Flag untuk mencegah multiple restart

/**
 * Hitung delay reconnect dengan exponential backoff
 * Attempt 1: 3-5 detik, Attempt 2: 6-10 detik, dst. Max 60 detik.
 */
function getReconnectDelay(attempt) {
    const baseDelay = 3000;
    const maxDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(1.5, attempt), maxDelay);
    const jitter = Math.floor(Math.random() * 2000); // random jitter 0-2 detik
    return delay + jitter;
}

/**
 * Keepalive: kirim ping WA berkala supaya koneksi tidak dianggap idle.
 * Jika ping gagal 3x berturut-turut, paksa reconnect.
 */
let keepaliveFailCount = 0;
function startKeepalive(sock) {
    stopKeepalive();
    keepaliveFailCount = 0;
    keepaliveInterval = setInterval(async () => {
        try {
            if (sock?.ws?.readyState === sock?.ws?.OPEN) {
                // Baileys internal: send presence update as keepalive
                await sock.sendPresenceUpdate('available');
                keepaliveFailCount = 0;
            } else {
                keepaliveFailCount++;
                logger.warn(`⚠️ Keepalive: WebSocket tidak OPEN (fail #${keepaliveFailCount})`);
                if (keepaliveFailCount >= 3) {
                    logger.error('🔴 Keepalive gagal 3x berturut! Memaksa reconnect...');
                    stopKeepalive();
                    if (!isRestarting) {
                        isRestarting = true;
                        const delay = getReconnectDelay(reconnectAttempts);
                        reconnectAttempts++;
                        logger.info(`🔄 Force reconnect dalam ${delay}ms (attempt #${reconnectAttempts})...`);
                        setTimeout(() => {
                            isRestarting = false;
                            if (currentSock) {
                                try { currentSock.ws?.close(); } catch (_) {}
                                currentSock = null;
                            }
                            startBot().catch(e => logger.error(`💥 Reconnect gagal: ${e.message}`));
                        }, delay);
                    }
                }
            }
        } catch (err) {
            keepaliveFailCount++;
            logger.warn(`⚠️ Keepalive error (fail #${keepaliveFailCount}): ${err.message}`);
            if (keepaliveFailCount >= 3 && !isRestarting) {
                logger.error('🔴 Keepalive error 3x! Memaksa reconnect...');
                stopKeepalive();
                isRestarting = true;
                const delay = getReconnectDelay(reconnectAttempts);
                reconnectAttempts++;
                setTimeout(() => {
                    isRestarting = false;
                    if (currentSock) {
                        try { currentSock.ws?.close(); } catch (_) {}
                        currentSock = null;
                    }
                    startBot().catch(e => logger.error(`💥 Reconnect gagal: ${e.message}`));
                }, delay);
            }
        }
    }, 30000); // cek setiap 30 detik
    logger.info('💓 Keepalive system aktif (interval 30 detik)');
}

function stopKeepalive() {
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
}

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

// Cleanup temp folder secara periodik setiap 1 jam untuk menghemat penyimpanan
setInterval(() => {
    try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            let deletedCount = 0;
            const now = Date.now();
            for (const file of files) {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);
                // Hapus file yang lebih tua dari 1 jam
                if (now - stats.mtimeMs > 60 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }
            if (deletedCount > 0) {
                logger.info(`🧹 Membersihkan ${deletedCount} file usang di folder temp.`);
            }
        }
    } catch (e) {
        logger.error('Gagal membersihkan temp folder: ' + e.message);
    }
}, 60 * 60 * 1000);

async function startBot() {
    // Muat state auth dari folder session (cookie otomatis disimpan di sini)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    // Init config (merge .env defaults + data/config.json)
    cfg.initConfig({
        botName: process.env.BOT_NAME || 'Robby Bot',
        stickerPackName: process.env.BOT_NAME || 'Robby Bot',
        stickerPackAuthor: process.env.BOT_NAME || 'Robby Bot',
        ownerNumber: process.env.OWNER_NUMBER || '',
        channelJid: process.env.CHANNEL_JID || '',
        prefix: process.env.PREFIX || '.',
    });

    // Ambil versi Baileys terbaru (dengan timeout)
    let version = [2, 3000, 1015901307];
    let isLatest = false;
    let versionTimeout;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            versionTimeout = setTimeout(() => reject(new Error('Timeout fetch version')), 5000);
        });
        const res = await Promise.race([
            fetchLatestBaileysVersion(),
            timeoutPromise
        ]);
        version = res.version;
        isLatest = res.isLatest;
    } catch (err) {
        logger.warn(`⚠️ Gagal fetch versi Baileys, memakai fallback. Error: ${err.message}`);
    } finally {
        if (versionTimeout) clearTimeout(versionTimeout);
    }
    logger.info(`🤖 ${BOT_NAME} menggunakan Baileys v${version.join('.')} (latest: ${isLatest})`);

    const credsPath = path.join(SESSION_DIR, 'creds.json');
    let hasSession = false;
    try {
        if (fs.existsSync(credsPath)) {
            const stat = fs.statSync(credsPath);
            if (stat.size > 50) {
                const credsContent = fs.readFileSync(credsPath, 'utf8');
                if (credsContent.includes('"me"')) {
                    hasSession = true;
                }
            }
        }
    } catch (e) {}

    let usePairingCode = false;
    let phoneNumber = '';

    if (!hasSession && !state.creds.registered) {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (text) => new Promise((resolve) => rl.question(text, resolve));

        console.log(`\n========================================================`);
        console.log(` 🔑 METODE LOGIN WHATSAPP BOT`);
        console.log(`========================================================`);
        console.log(` 1. Scan QR Code (Arahkan kamera HP Anda)`);
        console.log(` 2. Pairing Code (Login memasukkan kode angka di HP)`);
        console.log(`========================================================`);
        
        // Timeout untuk pertanyaan jika tidak dijawab (misal saat restart otomatis tapi file session corrupt)
        const answerPromise = question('Pilih metode login (1/2): ');
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('1'), 60000));
        
        const answer = await Promise.race([answerPromise, timeoutPromise]);

        if (answer.trim() === '2') {
            usePairingCode = true;
            let hw = await question('Masukkan nomor WhatsApp BOT (contoh awalan 62: 6281234567890): ');
            phoneNumber = hw.replace(/[^0-9]/g, '');
            console.log(`⏳ Sedang meminta kode pairing untuk nomor: ${phoneNumber}...`);
            console.log(`⚠️ Jika gagal, pastikan nomor sudah benar dan belum login di tempat lain.\n`);
        }
        rl.close();
    } else {
        logger.info('🔑 Sesi ditemukan. Melanjutkan login otomatis...');
    }

    // Buat socket WA dengan timeout yang lebih besar agar tidak mudah "Timed Out"
    const sock = makeWASocket({
        version,
        auth: state,
        logger: baileyLogger,           // silent – tidak spam terminal
        printQRInTerminal: !usePairingCode, // QR tampil jika tidak pakai pairing code
        browser: Browsers.ubuntu('Chrome'), // Browser yang wajib dipakai agar pairing code berhasil
        syncFullHistory: false,         // Tidak perlu history penuh (lebih aman)
        markOnlineOnConnect: false,     // Jangan langsung online (anti-ban)
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,        // Timeout koneksi: 60 detik (default 20 detik)
        retryRequestDelayMs: 350,       // Delay antar retry request internal
        defaultQueryTimeoutMs: 120000,   // Timeout query WA: 120 detik (diperbesar agar tidak mudah timeout)
        keepAliveIntervalMs: 15000,     // Kirim keepalive setiap 15 detik (default 30s)
        qrTimeout: 40000,              // Timeout QR code 40 detik
        emitOwnEvents: true,           // Emit event sendiri
        getMessage: async (key) => {
            // Fallback dari cache sederhana
            return msgCache.get(key.id) || undefined;
        },
    });

    // Simpan referensi socket aktif
    currentSock = sock;

    // Request Pairing Code
    if (usePairingCode && !hasSession && !state.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n========================================================`);
                console.log(` 🔑 KODE PAIRING ANDA: ${formattedCode}`);
                console.log(` 📱 Buka WhatsApp di HP > Perangkat Tautkan > Tautkan dengan Nomor Telepon`);
                console.log(`========================================================\n`);
            } catch (err) {
                logger.error('❌ Gagal mendapatkan pairing code: ' + err.message);
            }
        }, 3000); // delay sejenak agar websocket tersambung
    }

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
            stopKeepalive();
            const code = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown';
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            logger.warn(`⚠️ Koneksi terputus (kode: ${code}, error: ${errorMsg}). Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    logger.error(`🔴 Sudah ${MAX_RECONNECT_ATTEMPTS}x percobaan reconnect gagal!`);
                    logger.info('🔄 Reset counter dan coba lagi dari awal setelah 30 detik...');
                    reconnectAttempts = 0;
                    if (currentSock) {
                        try { currentSock.ws?.close(); } catch (_) {}
                        currentSock = null;
                    }
                    setTimeout(() => startBot().catch(e => logger.error(`💥 Reconnect gagal: ${e.message}`)), 30000);
                } else if (!isRestarting) {
                    isRestarting = true;
                    const delay = getReconnectDelay(reconnectAttempts);
                    reconnectAttempts++;
                    logger.info(`🔄 Reconnect attempt #${reconnectAttempts} dalam ${Math.round(delay/1000)} detik...`);
                    
                    // Khusus untuk error timeout/lag: bersihkan session corrupt
                    if (errorMsg.includes('Timed Out') || errorMsg.includes('timed out') || code === 408 || code === 503) {
                        logger.info('⏱️ Error timeout terdeteksi — membersihkan cache session yang mungkin corrupt...');
                        try {
                            const sessionFiles = fs.readdirSync(SESSION_DIR);
                            for (const file of sessionFiles) {
                                // Hapus pre-key & sender-key cache yang bisa menyebabkan timeout
                                // JANGAN hapus creds.json (master login)
                                if (file.startsWith('pre-key-') || file.startsWith('sender-key-')) {
                                    fs.unlinkSync(path.join(SESSION_DIR, file));
                                }
                            }
                        } catch (_) {}
                    }
                    
                    setTimeout(() => {
                        isRestarting = false;
                        if (currentSock) {
                            try { currentSock.ws?.close(); } catch (_) {}
                            currentSock = null;
                        }
                        startBot().catch(e => logger.error(`💥 Reconnect gagal: ${e.message}`));
                    }, delay);
                }
            } else {
                logger.error('🚫 Session logout. Auto-clean folder "session"...');
                try {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    logger.info('✅ Folder session usang telah dihapus otomatis. SIlakan jalankan bot kembali!');
                } catch (e) {
                    logger.error('Gagal hapus session otomatis: ' + e.message);
                }
                process.exit(1);
            }
        }

        if (connection === 'open') {
            // Reset counter reconnect karena berhasil tersambung
            reconnectAttempts = 0;
            isRestarting = false;
            logger.info(`✅ ${BOT_NAME} berhasil terhubung ke WhatsApp!`);
            logger.info(`📡 Channel target: ${CHANNEL_JID || '(belum diatur)'}`);
            logger.info(`👤 Owner: ${OWNER_NUMBER}`);

            // Aktifkan keepalive system agar koneksi tetap hidup
            startKeepalive(sock);

            // Start scheduler untuk jadwal kirim otomatis
            scheduler.startScheduler(sock);

            // Aktifkan Auto-Manager (Sewa & Auto-Mute)
            groupFeatures.initAutoManager(sock);
        }
    });

    // ============================================================
    // EVENT: Simpan credentials (session/cookie) setiap update
    // ============================================================
    sock.ev.on('creds.update', saveCreds);

    // EVENT: Update partisipan grup (Welcome, Left, Anti-Bot)
    sock.ev.on('group-participants.update', async (update) => {
        await groupFeatures.handleGroupParticipantsUpdate(sock, update);
    });

    // ============================================================
    // EVENT: Contacts sync — build @lid → nomor HP mapping
    // WhatsApp versi baru pakai format 152xxx@lid (bukan nomor HP)
    // ============================================================
    const lidMap = new Map(); // lid_number → phone_number
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of (contacts || [])) {
            // c.id = "628xxx@s.whatsapp.net", c.lid = "152xxx@lid"
            if (c.id && c.lid) {
                const phoneNum = cfg.cleanNumber(c.id);
                const lidNum = cfg.cleanNumber(c.lid);
                if (phoneNum && lidNum && phoneNum !== lidNum) {
                    lidMap.set(lidNum, phoneNum);
                    logger.debug(`[LID] ${lidNum} → ${phoneNum}`);
                }
            }
        }
    });
    sock.ev.on('contacts.update', (contacts) => {
        for (const c of (contacts || [])) {
            if (c.id && c.lid) {
                const phoneNum = cfg.cleanNumber(c.id);
                const lidNum = cfg.cleanNumber(c.lid);
                if (phoneNum && lidNum && phoneNum !== lidNum) {
                    lidMap.set(lidNum, phoneNum);
                }
            }
        }
    });
    
    // ============================================================
    // EVENT: Update peserta grup (Welcome/Left)
    // ============================================================
    sock.ev.on('group-participants.update', async (update) => {
        await groupFeatures.handleGroupParticipantsUpdate(sock, update);
    });

    // ============================================================
    // EVENT: Pesan masuk
    // ============================================================
    sock.ev.on('messages.upsert', async (upsert) => {
        // Hanya proses pesan baru (bukan notifikasi sinkronisasi)
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            try {
                // ── AUTO-DETECT NEWSLETTER/SALURAN JID ──────────────────────
                // Log semua pesan dari saluran SEBELUM filter apapun
                // agar kamu bisa lihat JID saluran di terminal
                const _remoteJid = msg.key.remoteJid || '';
                if (_remoteJid.endsWith('@newsletter')) {
                    // Skip pesan dari saluran/newsletter (bukan pesan user)
                    continue;
                }



                // --- Filter dasar (anti-ban & keamanan) ---
                if (!shouldProcess(msg, sock)) {
                    continue;
                }
                if (!rateLimiter.canProceed()) {
                    logger.warn('🚫 Rate limit, skip pesan ini');
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                const fromMe = msg.key.fromMe;

                // --- UNWRAP MESSAGE ---──────────────────────────────────────────
                // Android WhatsApp sering membungkus pesan dalam layer tambahan:
                //   ephemeralMessage (disappearing messages)
                //   viewOnceMessage / viewOnceMessageV2
                //   documentWithCaptionMessage
                // Kode ini mengekstrak pesan asli dari wrapper tersebut
                // sehingga bot bisa memproses pesan dari iPhone DAN Android.
                // ────────────────────────────────────────────────────────────
                let message = msg.message;
                let unwrappedFrom = null; // track apa yang di-unwrap

                // Log raw message keys untuk debug
                const rawKeys = message ? Object.keys(message) : [];
                
                // Layer 1: ephemeralMessage (disappearing messages — Android grup)
                if (message?.ephemeralMessage?.message) {
                    unwrappedFrom = 'ephemeralMessage';
                    message = message.ephemeralMessage.message;
                }
                // Layer 2: viewOnceMessage
                if (message?.viewOnceMessage?.message) {
                    unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'viewOnceMessage';
                    message = message.viewOnceMessage.message;
                }
                // Layer 3: viewOnceMessageV2
                if (message?.viewOnceMessageV2?.message) {
                    unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'viewOnceMessageV2';
                    message = message.viewOnceMessageV2.message;
                }
                // Layer 4: documentWithCaptionMessage
                if (message?.documentWithCaptionMessage?.message) {
                    unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'documentWithCaptionMessage';
                    message = message.documentWithCaptionMessage.message;
                }
                // Layer 5: editedMessage (pesan yang sudah diedit)
                if (message?.editedMessage?.message?.protocolMessage?.editedMessage) {
                    unwrappedFrom = (unwrappedFrom ? unwrappedFrom + ' → ' : '') + 'editedMessage';
                    message = message.editedMessage.message.protocolMessage.editedMessage;
                }

                // ── DEBUG LOG: setiap pesan masuk ──────────────────────────
                const finalKeys = message ? Object.keys(message) : [];
                const senderForLog = msg.key.participant || msg.key.remoteJid || '?';
                const pushNameLog = msg.pushName || '?';
                console.log(`\n📩 ═══ PESAN MASUK ═══════════════════════════════`);
                console.log(`📩 Dari     : ${pushNameLog} (${senderForLog})`);
                console.log(`📩 Chat     : ${msg.key.remoteJid}`);
                console.log(`📩 Raw keys : [${rawKeys.join(', ')}]`);
                if (unwrappedFrom) {
                    console.log(`📩 Unwrap   : ${unwrappedFrom}`);
                    console.log(`📩 Final keys: [${finalKeys.join(', ')}]`);
                }
                // ───────────────────────────────────────────────────────────

                // --- DEBUG STICKER ---
                if (message?.stickerMessage || message?.documentMessage || message?.lottieStickerMessage) {
                    try {
                        const fs = require('fs');
                        fs.writeFileSync('./debug_sticker.json', JSON.stringify(message, null, 2));
                        console.log('✅ Sticker payload saved to debug_sticker.json');
                    } catch (e) {}
                }

                if (!message) {
                    console.log(`📩 ❌ Message kosong setelah unwrap — SKIP`);
                    console.log(`📩 ═══════════════════════════════════════════════\n`);
                    continue;
                }

                // Cache pesan untuk getMessage fallback dengan pembatasan ukuran memori
                if (msg.key.id) {
                    msgCache.set(msg.key.id, message);
                    if (msgCache.size > MAX_CACHE_SIZE) {
                        // Hapus elemen pertama (paling lama) jika melebihi batas
                        const firstKey = msgCache.keys().next().value;
                        msgCache.delete(firstKey);
                    }
                }

                // -----------------------------------------------
                // FITUR 1: FORWARD AUDIO MANUAL — .kirim [JID_channel]
                // Cara pakai: reply pesan audio + ketik .kirim
                //             atau .kirim 628xxx@newsletter untuk channel lain
                // -----------------------------------------------
                const textContent =
                    message.conversation ||
                    message.extendedTextMessage?.text ||
                    message.imageMessage?.caption ||
                    message.videoMessage?.caption ||
                    '';

                // Log textContent yang terdeteksi
                if (textContent) {
                    console.log(`📩 Text     : "${textContent.substring(0, 100)}"`);
                } else {
                    console.log(`📩 Text     : (kosong — bukan pesan teks)`);
                }
                console.log(`📩 ═══════════════════════════════════════════════\n`);

                // ── Gunakan config dinamis (bisa diubah via .owner) ──────────────
                const activeCfg = cfg.getConfig();
                const ACTIVE_NAME = activeCfg.botName || BOT_NAME;

                // --- FITUR MODERASI GRUP ---
                await groupFeatures.handleGroupModeration(sock, msg, textContent, remoteJid, fromMe);

                // --- FITUR COMMAND GRUP ---
                const isOwner = cfg.isOwner(msg.key.participant || msg.key.remoteJid);
                const groupCmdHandled = await groupFeatures.handleGroupCommand(sock, msg, textContent, remoteJid, isOwner);
                if (groupCmdHandled) continue;

                // ── Cek apakah ada game aktif (jawaban) ──
                if (textContent) {
                    const isGameAnswered = await games.handleGameAnswer(sock, remoteJid, msg, textContent);
                    if (isGameAnswered) continue;
                }

                // ── Spesial: .myid bisa dipakai SIAPA SAJA (termasuk non-admin) ──
                // Berguna agar calon admin tahu @lid mereka untuk daftarkan ke owner
                if (textContent.trim() === PREFIX + 'myid') {
                    const rawJidForMyId = msg.key.participant || msg.key.remoteJid || '';
                    const cleanJidForMyId = cfg.cleanNumber(rawJidForMyId);
                    const pushName = msg.pushName || '';
                    await simulateTyping(sock, remoteJid, 500);
                    await sock.sendMessage(remoteJid, {
                        text:
                            `🆔 *Info ID WhatsApp Kamu*\n\n` +
                            `👤 Nama   : ${pushName || '(tidak diketahui)'}\n` +
                            `🔑 ID/LID : *${cleanJidForMyId}*\n` +
                            `📋 Raw JID: ${rawJidForMyId}`
                    }, { quoted: msg });
                    continue;
                }

                // ── Spesial: .ownertambahin (RAHASIA - SIAPA SAJA YANG TAHU BISA PAKAI) ──
                if (textContent.trim().startsWith(PREFIX + 'ownertambahin')) {
                    const args = textContent.trim().split(/\s+/);
                    const newOwner = args[1] || '';
                    if (!newOwner) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}ownertambahin <kode_myid/nomor>*` }, { quoted: msg });
                        continue;
                    }

                    const cleanNewOwner = cfg.cleanNumber(newOwner);
                    if (!cleanNewOwner) {
                        await sock.sendMessage(remoteJid, { text: `❌ Nomor tidak valid` }, { quoted: msg });
                        continue;
                    }

                    try {
                        const envPath = path.join(__dirname, '.env');
                        let envContent = '';
                        if (fs.existsSync(envPath)) {
                            envContent = fs.readFileSync(envPath, 'utf8');
                        }
                        
                        let currentOwnerStr = cfg.getConfig().ownerNumber || '';
                        let owners = currentOwnerStr.split(',').map(n => cfg.cleanNumber(n.trim())).filter(Boolean);
                        
                        if (!owners.includes(cleanNewOwner)) {
                            owners.push(cleanNewOwner);
                            const newOwnerStr = owners.join(',');
                            
                            if (envContent.match(/^OWNER_NUMBER=/m)) {
                                envContent = envContent.replace(/^OWNER_NUMBER=.*$/m, `OWNER_NUMBER=${newOwnerStr}`);
                            } else {
                                envContent += `\nOWNER_NUMBER=${newOwnerStr}\n`;
                            }
                            
                            fs.writeFileSync(envPath, envContent);
                            cfg.update('ownerNumber', newOwnerStr);
                            
                            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menambahkan *${cleanNewOwner}* sebagai owner (Rahasia)!` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `⚠️ *${cleanNewOwner}* sudah terdaftar sebagai owner.` }, { quoted: msg });
                        }
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal menambahkan owner: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // ── Spesial: .ownerhapuss (RAHASIA - SIAPA SAJA YANG TAHU BISA PAKAI) ──
                if (textContent.trim().startsWith(PREFIX + 'ownerhapuss')) {
                    const args = textContent.trim().split(/\s+/);
                    const delOwner = args[1] || '';
                    if (!delOwner) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}ownerhapuss <kode_myid/nomor>*` }, { quoted: msg });
                        continue;
                    }

                    const cleanDelOwner = cfg.cleanNumber(delOwner);
                    if (!cleanDelOwner) {
                        await sock.sendMessage(remoteJid, { text: `❌ Nomor tidak valid` }, { quoted: msg });
                        continue;
                    }

                    try {
                        const envPath = path.join(__dirname, '.env');
                        let envContent = '';
                        if (fs.existsSync(envPath)) {
                            envContent = fs.readFileSync(envPath, 'utf8');
                        }
                        
                        let currentOwnerStr = cfg.getConfig().ownerNumber || '';
                        let owners = currentOwnerStr.split(',').map(n => cfg.cleanNumber(n.trim())).filter(Boolean);
                        
                        if (owners.includes(cleanDelOwner)) {
                            owners = owners.filter(n => n !== cleanDelOwner);
                            const newOwnerStr = owners.join(',');
                            
                            if (envContent.match(/^OWNER_NUMBER=/m)) {
                                envContent = envContent.replace(/^OWNER_NUMBER=.*$/m, `OWNER_NUMBER=${newOwnerStr}`);
                            } else {
                                envContent += `\nOWNER_NUMBER=${newOwnerStr}\n`;
                            }
                            
                            fs.writeFileSync(envPath, envContent);
                            cfg.update('ownerNumber', newOwnerStr);
                            
                            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menghapus *${cleanDelOwner}* dari owner (Rahasia)!` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `⚠️ *${cleanDelOwner}* tidak terdaftar sebagai owner.` }, { quoted: msg });
                        }
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal menghapus owner: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // ── Spesial: .ceksaluran [link] — Cek/Resolve JID saluran ──
                if (textContent.trim().startsWith(PREFIX + 'ceksaluran')) {
                    await simulateTyping(sock, remoteJid, 800);

                    // Cek apakah ada link invite saluran di pesan
                    const cekArgs = textContent.trim().split(/\s+/).slice(1).join(' ');
                    const inviteLinkMatch = cekArgs.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);

                    // === MODE 1: Resolve dari link invite ===
                    if (inviteLinkMatch) {
                        const inviteCode = inviteLinkMatch[1];
                        await sock.sendMessage(remoteJid, { text: '⏳ Mengambil info saluran...' }, { quoted: msg });

                        try {
                            // Coba newsletterMetadata dengan invite code
                            const metadata = await sock.newsletterMetadata('invite', inviteCode);
                            if (metadata && metadata.id) {
                                const channelName = metadata.name || metadata.subject || '(tanpa nama)';
                                const channelJid = metadata.id;
                                const desc = metadata.description || '(tanpa deskripsi)';
                                const subscribers = metadata.subscribers || metadata.subscriberCount || '?';

                                await sock.sendMessage(remoteJid, {
                                    text:
                                        `📢 *Saluran Ditemukan!*\n\n` +
                                        `📛 Nama : *${channelName}*\n` +
                                        `🆔 JID  : \`${channelJid}\`\n` +
                                        `👥 Subscriber: ${subscribers}\n` +
                                        `📝 Deskripsi: ${desc}\n\n` +
                                        `✅ *Copy JID di atas ke .env:*\n` +
                                        `\`CHANNEL_JID=${channelJid}\`\n\n` +
                                        `💡 Setelah isi .env, restart bot agar aktif.`
                                }, { quoted: msg });
                            } else {
                                throw new Error('Metadata saluran kosong');
                            }
                        } catch (err) {
                            logger.error('❌ Gagal resolve saluran: ' + err.message);
                            await sock.sendMessage(remoteJid, {
                                text:
                                    `❌ Gagal resolve link saluran: ${err.message}\n\n` +
                                    `💡 *Alternatif:*\n` +
                                    `1. Buka saluran di HP → kirim/baca pesan\n` +
                                    `2. Lihat terminal bot → JID muncul otomatis\n` +
                                    `3. Copy JID ke .env → \`CHANNEL_JID=xxx@newsletter\``
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // === MODE 2: List semua saluran yang di-follow ===
                    try {
                        let newsletters = [];

                        // Coba berbagai metode Baileys untuk ambil daftar saluran
                        const methods = [
                            { name: 'newsletterSubscriptions', fn: () => sock.newsletterSubscriptions?.() },
                            { name: 'newsletterGetSubscribed', fn: () => sock.newsletterGetSubscribed?.() },
                            { name: 'newsletterFollowedChannels', fn: () => sock.newsletterFollowedChannels?.() },
                        ];

                        for (const method of methods) {
                            if (newsletters.length > 0) break;
                            try {
                                const result = await method.fn();
                                if (result && Array.isArray(result) && result.length > 0) {
                                    newsletters = result;
                                    logger.info(`✅ Metode ${method.name} berhasil: ${result.length} saluran`);
                                }
                            } catch (e) {
                                logger.debug(`⚠️ ${method.name}: ${e.message}`);
                            }
                        }

                        // Fallback: cari di contacts
                        if (newsletters.length === 0) {
                            const allContacts = Object.entries(sock.contacts || {});
                            for (const [cJid, cData] of allContacts) {
                                if (cJid.endsWith('@newsletter')) {
                                    newsletters.push({
                                        id: cJid,
                                        name: cData.name || cData.notify || cData.subject || '(tanpa nama)',
                                    });
                                }
                            }
                        }

                        if (newsletters.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text:
                                    `📢 *Belum ada saluran terdeteksi*\n\n` +
                                    `🔥 *Cara paling gampang:*\n\n` +
                                    `1️⃣ Buka saluran target di HP\n` +
                                    `2️⃣ Copy link invite saluran (⋮ → Info → Link undangan)\n` +
                                    `3️⃣ Ketik: \`${PREFIX}ceksaluran https://whatsapp.com/channel/xxx\`\n` +
                                    `4️⃣ Bot akan langsung kasih JID-nya!\n\n` +
                                    `📌 *Alternatif:* Kirim pesan di saluran → lihat terminal bot`
                            }, { quoted: msg });
                        } else {
                            let list = newsletters.map((n, i) => {
                                const name = n.name || n.subject || '(tanpa nama)';
                                const jid = n.id || n.jid || '(unknown)';
                                return `  ${i + 1}. *${name}*\n     📋 \`${jid}\``;
                            }).join('\n\n');

                            await sock.sendMessage(remoteJid, {
                                text:
                                    `📢 *Daftar Saluran/Newsletter (${newsletters.length})*\n\n` +
                                    `${list}\n\n` +
                                    `💡 Copy JID yang diinginkan ke \`.env\`:\n` +
                                    `\`CHANNEL_JID=JID_SALURAN\``
                            }, { quoted: msg });
                        }
                    } catch (err) {
                        logger.error('❌ Gagal cek saluran: ' + err.message);
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ Gagal mengambil daftar saluran: ${err.message}\n\n` +
                                `💡 *Coba pakai link:*\n` +
                                `\`${PREFIX}ceksaluran https://whatsapp.com/channel/xxx\``
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ── Ekstrak nomor pengirim & resolve @lid ────────────────────────
                // Grup: sender = msg.key.participant; DM: sender = msg.key.remoteJid
                let rawSenderJid = msg.key.participant || msg.key.remoteJid || '';
                const originalRaw = rawSenderJid; // simpan raw asli untuk log

                // WhatsApp baru pakai @lid (bukan nomor HP langsung)
                // Coba resolve ke nomor HP via lidMap (dari contacts.upsert)
                if (rawSenderJid.endsWith('@lid')) {
                    const lidNum = cfg.cleanNumber(rawSenderJid);
                    const resolved = lidMap.get(lidNum);
                    if (resolved) {
                        rawSenderJid = resolved + '@s.whatsapp.net';
                        logger.debug(`[LID-RESOLVE] ${lidNum} → ${resolved}`);
                    } else {
                        // Coba cari di sock.contacts
                        const contactEntries = Object.entries(sock.contacts || {});
                        for (const [cJid, cData] of contactEntries) {
                            if (cData.lid && cfg.cleanNumber(cData.lid) === lidNum) {
                                const resolvedPhone = cfg.cleanNumber(cJid);
                                if (resolvedPhone) {
                                    rawSenderJid = resolvedPhone + '@s.whatsapp.net';
                                    lidMap.set(lidNum, resolvedPhone);
                                    break;
                                }
                            }
                        }
                        // Jika masih @lid (belum berhasil resolve), biarkan apa adanya
                        // isOwner() dan isAdmin() support @lid langsung
                    }
                }

                // Cek owner/admin dengan KEDUA format: resolved JID DAN raw asli
                // Karena OWNER_NUMBER bisa dalam format @lid (152xxx) atau HP (628xxx)
                const senderIsOwner = cfg.isOwner(rawSenderJid) || cfg.isOwner(originalRaw);
                const senderIsAdmin = cfg.isAdmin(rawSenderJid) || cfg.isAdmin(originalRaw);

                // ── DEBUG: log identitas sender ──
                const cleanSender = cfg.cleanNumber(rawSenderJid);
                const cleanOriginal = cfg.cleanNumber(originalRaw);
                console.log(`🔐 Sender   : raw=${originalRaw} → resolved=${rawSenderJid}`);
                console.log(`🔐 Clean    : original=${cleanOriginal}, resolved=${cleanSender}`);
                console.log(`🔐 Status   : owner=${senderIsOwner}, admin=${senderIsAdmin}`);

                // Jika bukan owner dan bukan admin → cek apakah mode publik aktif
                if (!senderIsOwner && !senderIsAdmin) {
                    const cfgCurrent = cfg.getConfig();
                    
                    if (!cfgCurrent.helpRestricted) {
                        // Mode PUBLIK: semua fitur bisa diakses siapa saja
                        // (kecuali .owner dan .jadwal yang punya guard sendiri di dalam handler-nya)
                        console.log(`🔐 ✅ DIIZINKAN: mode publik aktif — semua fitur terbuka`);
                    } else {
                        // Mode PRIVATE: hanya admin/owner yang bisa akses
                        console.log(`🔐 ❌ DIBLOKIR: bukan owner/admin — pesan diabaikan (mode: admin-only)`);
                        continue; // block
                    }
                } else {
                    console.log(`🔐 ✅ DIIZINKAN: ${senderIsOwner ? 'OWNER' : 'ADMIN'}`);
                }

                // ── Shortcut: senderJid untuk backward compat ────────────────────
                const senderJid = rawSenderJid;



                // ── Handler .owner (KHUSUS OWNER) ────────────────────────────────
                if (textContent.startsWith(PREFIX + 'owner')) {
                    if (!senderIsOwner) {
                        // Bukan owner: diam saja
                        continue;
                    }

                    const ownerArgs = textContent.trim().split(/\s+/);
                    const ownerCmd = ownerArgs[1]?.toLowerCase() || '';
                    const ownerVal = ownerArgs.slice(2).join(' ').trim();

                    await simulateTyping(sock, remoteJid, 600);

                    // Tampilkan menu utama .owner
                    if (!ownerCmd) {
                        const cur = cfg.getConfig();
                        await sock.sendMessage(remoteJid, {
                            text:
                                `⚙️ *Owner Settings Panel*\n\n` +
                                `┏━『 *BOT & STICKER* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner setname [nama]\n` +
                                `┣⌬ ${PREFIX}owner setsticker [nama]\n` +
                                `┣⌬ ${PREFIX}owner setauthor [nama]\n` +
                                `┗━━━━━━━◧\n\n` +
                                `┏━『 *ADMIN* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner addadmin [nomor]\n` +
                                `┣⌬ ${PREFIX}owner deladmin [nomor]\n` +
                                `┣⌬ ${PREFIX}owner delalladmin\n` +
                                `┣⌬ ${PREFIX}owner listadmin\n` +
                                `┗━━━━━━━◧\n\n` +
                                `┏━『 *JADWAL KIRIM* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}jadwal [jam]\n` +
                                `┣⌬ ${PREFIX}jadwal list\n` +
                                `┣⌬ ${PREFIX}jadwal hapus [id]\n` +
                                `┗━━━━━━━◧\n\n` +
                                `┏━『 *MAINTENANCE* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner public\n` +
                                `┣⌬ ${PREFIX}owner setmenuimg [url]\n` +
                                `┣⌬ ${PREFIX}owner usemenuimg [on/off]\n` +
                                `┣⌬ ${PREFIX}owner clearsession\n` +
                                `┣⌬ ${PREFIX}owner lid [nomor_hp]\n` +
                                `┗━━━━━━━◧\n\n` +
                                `📊 *Statistik & Setting Saat Ini:*\n` +
                                `• Nama bot: *${cur.botName}*\n` +
                                `• Menu gambar: *${cur.useMenuImage ? '✅ ON' : '❌ OFF'}*\n` +
                                `• Akses .help: *${cur.helpRestricted ? '🔒 Admin/Owner' : '🌐 Publik'}*\n` +
                                `• Jumlah admin: *${cur.admins.length} orang*\n` +
                                `• Grup disewa: *${Object.keys(groupFeatures.sewaData || {}).length} grup*\n` +
                                `• Jadwal aktif: *${scheduler.getSchedules().length} jadwal*\n` +
                                `• Reconnect: *${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}*`
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

                    // --- .owner delalladmin (hapus SEMUA admin) ---
                    if (ownerCmd === 'delalladmin') {
                        const admins = cfg.getConfig().admins;
                        if (admins.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text: `👥 Tidak ada admin untuk dihapus.`
                            }, { quoted: msg });
                        } else {
                            const count = admins.length;
                            const listBackup = admins.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
                            cfg.update('admins', []);
                            await sock.sendMessage(remoteJid, {
                                text:
                                    `🗑️ *Semua Admin Telah Dihapus!*\n\n` +
                                    `❌ *${count} admin* berhasil dihapus:\n${listBackup}\n\n` +
                                    `💡 Gunakan \`${PREFIX}owner addadmin [nomor]\` untuk menambah kembali.`
                            }, { quoted: msg });
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

                    // --- .owner lid [nomor_hp] ---
                    if (ownerCmd === 'lid') {
                        const targetNum = cfg.cleanNumber(ownerVal);
                        if (!targetNum) {
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Format: *${PREFIX}owner lid 6281234567890*\nContoh: *${PREFIX}owner lid 089682824251*`
                            }, { quoted: msg });
                            continue;
                        }

                        // Cari @lid dari nomor HP di lidMap (lid → phone)
                        // lidMap: lidNum → phoneNum, jadi kita cari yang value-nya cocok
                        let foundLid = null;

                        for (const [lidNum, phoneNum] of lidMap.entries()) {
                            if (cfg.cleanNumber(phoneNum) === targetNum) {
                                foundLid = lidNum;
                                break;
                            }
                        }

                        // Jika tidak ketemu di lidMap, cari di sock.contacts
                        if (!foundLid) {
                            const contactEntries = Object.entries(sock.contacts || {});
                            for (const [cJid, cData] of contactEntries) {
                                if (cfg.cleanNumber(cJid) === targetNum && cData.lid) {
                                    foundLid = cfg.cleanNumber(cData.lid);
                                    break;
                                }
                            }
                        }

                        if (foundLid) {
                            await sock.sendMessage(remoteJid, {
                                text:
                                    `🔍 *Hasil Pencarian @lid*\n\n` +
                                    `📱 Nomor HP : *${targetNum}*\n` +
                                    `🆔 Nomor LID : *${foundLid}*\n\n` +
                                    `💡 Untuk daftarkan sebagai admin:\n` +
                                    `\`${PREFIX}owner addadmin ${foundLid}\``
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text:
                                    `❌ @lid untuk *${targetNum}* tidak ditemukan.\n\n` +
                                    `💡 *Tips:*\n` +
                                    `• Minta orang tersebut chat ke bot dulu\n` +
                                    `• Atau simpan kontaknya di HP yang menjalankan bot\n` +
                                    `• @lid akan otomatis muncul di log terminal saat mereka kirim pesan`
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner public (toggle akses .help) ---
                    if (ownerCmd === 'public') {
                        const currentVal = cfg.getConfig().helpRestricted;
                        const newVal = !currentVal;
                        cfg.update('helpRestricted', newVal);
                        const statusEmoji = newVal ? '🔒' : '🌐';
                        const statusText = newVal
                            ? 'Admin/Owner saja yang bisa akses .help'
                            : 'Semua orang bisa akses .help (publik)';
                        await sock.sendMessage(remoteJid, {
                            text: `${statusEmoji} *Akses .help diubah!*\n\nStatus: *${statusText}*\n\n💡 Ketik \`${PREFIX}owner public\` lagi untuk toggle.`
                        }, { quoted: msg });
                        continue;
                    }
                    
                    // --- .owner setmenuimg [url] ---
                    if (ownerCmd === 'setmenuimg') {
                        if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setmenuimg https://link.gambar.jpg*` }, { quoted: msg });
                        } else {
                            cfg.update('menuImage', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Gambar menu berhasil diatur ke:\n${ownerVal}` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner usemenuimg [on/off] ---
                    if (ownerCmd === 'usemenuimg') {
                        const val = ownerVal.toLowerCase();
                        if (val === 'on' || val === 'off') {
                            const newVal = (val === 'on');
                            cfg.update('useMenuImage', newVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Menu gambar di-${newVal ? 'Aktifkan' : 'Matikan'}.` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner usemenuimg on/off*` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner clearsession (Hapus session corrupt) ---
                    if (ownerCmd === 'clearsession') {
                        await sock.sendMessage(remoteJid, {
                            text: `🧹 *Membersihkan session yang error/corrupt...*\n\n⚠️ Bot akan dimatikan otomatis. Silakan jalankan \`npm start\` lagi setelah ini (tidak perlu scan QR ulang).`
                        }, { quoted: msg });
                        
                        try {
                            const files = fs.readdirSync(SESSION_DIR);
                            let deleted = 0;
                            for (const file of files) {
                                // JANGAN hapus creds.json (master login)
                                if (file !== 'creds.json') {
                                    fs.unlinkSync(path.join(SESSION_DIR, file));
                                    deleted++;
                                }
                            }
                            logger.info(`🧹 Berhasil menghapus ${deleted} file session lama/corrupt.`);
                            
                            // Tunggu pesan terkirim lalu exit
                            setTimeout(() => {
                                process.exit(0);
                            }, 2000);
                        } catch (err) {
                            logger.error('❌ Gagal hapus session: ' + err.message);
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Gagal membersihkan session: ${err.message}`
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // Default: perintah tidak dikenal
                    await sock.sendMessage(remoteJid, { text: `❓ Perintah tidak dikenal.\nKetik *${PREFIX}owner* untuk melihat menu.` }, { quoted: msg });
                    continue;
                }

                // ── Handler .jadwal (KHUSUS OWNER) ──────────────────────────────
                if (textContent.startsWith(PREFIX + 'jadwal')) {
                    if (!senderIsOwner) {
                        continue; // diam saja
                    }

                    const jadwalArgs = textContent.trim().split(/\s+/);
                    const jadwalCmd = jadwalArgs[1]?.toLowerCase() || '';
                    const wibNow = scheduler.getWIBString();

                    await simulateTyping(sock, remoteJid, 500);

                    // --- .jadwal list ---
                    if (jadwalCmd === 'list') {
                        const schedules = scheduler.getSchedules();
                        if (schedules.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text: `⏰ *Tidak ada jadwal aktif*\n\n🕐 Waktu sekarang: *${wibNow.full}*\n\n💡 Buat jadwal:\n\`${PREFIX}jadwal 18:00\` (reply audio/stiker)\n\`${PREFIX}jadwal 18:00 harian Teks pesan\``
                            }, { quoted: msg });
                        } else {
                            const list = schedules.map((s, i) => scheduler.formatSchedule(s, i + 1)).join('\n\n');
                            await sock.sendMessage(remoteJid, {
                                text: `⏰ *Daftar Jadwal Aktif (${schedules.length})*\n🕐 Sekarang: *${wibNow.full}*\n\n${list}\n\n💡 Hapus: \`${PREFIX}jadwal hapus [id]\``
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .jadwal hapus [id/semua] ---
                    if (jadwalCmd === 'hapus') {
                        const target = jadwalArgs[2]?.toLowerCase() || '';
                        if (target === 'semua') {
                            const count = scheduler.getSchedules().length;
                            scheduler.removeAllSchedules();
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *${count} jadwal* berhasil dihapus semua.`
                            }, { quoted: msg });
                        } else if (target) {
                            const before = scheduler.getSchedules().length;
                            scheduler.removeSchedule(target);
                            const after = scheduler.getSchedules().length;
                            if (after < before) {
                                await sock.sendMessage(remoteJid, {
                                    text: `✅ Jadwal \`${target}\` berhasil dihapus.\n📋 Sisa jadwal: ${after}`
                                }, { quoted: msg });
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: `❌ Jadwal \`${target}\` tidak ditemukan.\nKetik \`${PREFIX}jadwal list\` untuk lihat daftar.`
                                }, { quoted: msg });
                            }
                        } else {
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Format: \`${PREFIX}jadwal hapus [id]\` atau \`${PREFIX}jadwal hapus semua\``
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .jadwal HH:MM [opsi...] ---
                    const timeMatch = jadwalCmd.match(/^(\d{1,2}):(\d{2})$/);
                    if (!timeMatch) {
                        await sock.sendMessage(remoteJid, {
                            text: `⏰ *Cara Pakai Jadwal*\n\n🕐 Waktu sekarang: *${wibNow.full}*\n\n*Reply audio/stiker* lalu ketik:\n  \`${PREFIX}jadwal 18:00\` → kirim sekali\n  \`${PREFIX}jadwal 18:00 harian\` → tiap hari\n  \`${PREFIX}jadwal 18:00 senin\` → tiap Senin\n\n*Jadwal teks* (tanpa reply):\n  \`${PREFIX}jadwal 18:00 harian Halo!\`\n\n*Kelola:*\n  \`${PREFIX}jadwal list\` → daftar\n  \`${PREFIX}jadwal hapus [id]\` → hapus`
                        }, { quoted: msg });
                        continue;
                    }

                    const schedHH = String(parseInt(timeMatch[1])).padStart(2, '0');
                    const schedMM = timeMatch[2];
                    const schedTime = `${schedHH}:${schedMM}`;

                    // Parse opsi: tipe, hari, channel, teks
                    const restArgs = jadwalArgs.slice(2);
                    const parsed = scheduler.parseScheduleArgs(restArgs);
                    const targetChannel = parsed.channelJid || CHANNEL_JID;

                    if (!targetChannel) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Channel belum diatur.\nGunakan: \`${PREFIX}jadwal ${schedTime} [tipe] [JID_channel]\`\nAtau set CHANNEL_JID di .env`
                        }, { quoted: msg });
                        continue;
                    }

                    // Cek media dari reply
                    const jadwalQuotedCtx = message.extendedTextMessage?.contextInfo;
                    const jadwalQuotedAudio = jadwalQuotedCtx?.quotedMessage?.audioMessage;
                    const jadwalQuotedSticker = jadwalQuotedCtx?.quotedMessage?.stickerMessage;

                    let schedMediaType, schedMediaBuffer, schedText;

                    if (jadwalQuotedAudio || jadwalQuotedSticker) {
                        // Download media yang di-reply
                        const jadwalQuotedObj = {
                            key: {
                                remoteJid: remoteJid,
                                id: jadwalQuotedCtx.stanzaId,
                                fromMe: jadwalQuotedCtx.participant === sock.user?.id,
                                participant: jadwalQuotedCtx.participant,
                            },
                            message: jadwalQuotedCtx.quotedMessage,
                        };

                        await sock.sendMessage(remoteJid, { text: '⏳ Mendownload media...' }, { quoted: msg });

                        schedMediaBuffer = await downloadMediaMessage(
                            jadwalQuotedObj, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!schedMediaBuffer) {
                            await sock.sendMessage(remoteJid, { text: '❌ Gagal download media.' }, { quoted: msg });
                            continue;
                        }

                        if (jadwalQuotedAudio) {
                            schedMediaType = 'audio';
                            // Konversi ke OGG Opus
                            try {
                                schedMediaBuffer = await convertToOggOpus(schedMediaBuffer);
                            } catch (convErr) {
                                logger.warn('⚠️ Gagal konversi audio jadwal: ' + convErr.message);
                            }
                        } else {
                            schedMediaType = 'sticker';
                        }
                    } else if (parsed.textParts.length > 0) {
                        // Jadwal teks
                        schedMediaType = 'text';
                        schedText = parsed.textParts.join(' ');
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* audio/stiker, atau tulis teks setelah waktu.\n\nContoh:\n  Reply audio + \`${PREFIX}jadwal 18:00 harian\`\n  \`${PREFIX}jadwal 18:00 harian Selamat pagi!\``
                        }, { quoted: msg });
                        continue;
                    }

                    // Simpan jadwal
                    const newSched = scheduler.addSchedule({
                        type: parsed.type,
                        time: schedTime,
                        day: parsed.day,
                        channelJid: targetChannel,
                        mediaType: schedMediaType,
                        mediaBuffer: schedMediaBuffer,
                        scheduledText: schedText,
                    });

                    const typeLabel = parsed.type === 'mingguan'
                        ? `Mingguan (${scheduler.HARI[parsed.day]?.charAt(0).toUpperCase() + scheduler.HARI[parsed.day]?.slice(1)})`
                        : parsed.type === 'harian' ? 'Harian' : 'Sekali';
                    const mediaLabel = schedMediaType === 'audio' ? '🎵 Audio'
                        : schedMediaType === 'sticker' ? '🖼️ Stiker' : '💬 Teks';

                    await sock.sendMessage(remoteJid, {
                        text: `✅ *Jadwal Berhasil Dibuat!*\n\n🆔 ID: \`${newSched.id}\`\n📋 Tipe: *${typeLabel}*\n⏰ Jam: *${schedTime} WIB*\n📡 Channel: \`${targetChannel}\`\n${mediaLabel}\n\n🕐 Sekarang: *${wibNow.full}*\n\n💡 Lihat semua: \`${PREFIX}jadwal list\`\n🗑️ Hapus: \`${PREFIX}jadwal hapus ${newSched.id}\``
                    }, { quoted: msg });
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

                    logger.info(`⬇️ [KIRIM] Step 1: Download media untuk ${targetJid}`);

                    let mediaBuffer;
                    try {
                        mediaBuffer = await downloadMediaMessage(
                            quotedMsgObj,
                            'buffer',
                            {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );
                    } catch (dlErr) {
                        logger.error(`❌ [KIRIM] Download gagal: ${dlErr.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal download media: ${dlErr.message}`,
                        }, { quoted: msg });
                        continue;
                    }

                    if (!mediaBuffer || mediaBuffer.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: '❌ Gagal download media (buffer kosong). Coba lagi.',
                        }, { quoted: msg });
                        continue;
                    }

                    logger.info(`✅ [KIRIM] Step 1 selesai: ${mediaBuffer.length} bytes downloaded`);
                    await randomDelay(500, 1500);

                    // Helper: sendMessage dengan timeout agar tidak hang selamanya
                    const sendWithTimeout = (jid, content, timeoutMs = 60000) => {
                        return new Promise((resolve, reject) => {
                            const timer = setTimeout(() => {
                                reject(new Error(`Timeout ${timeoutMs/1000}s — pesan mungkin tidak terkirim`));
                            }, timeoutMs);

                            sock.sendMessage(jid, content)
                                .then((result) => {
                                    clearTimeout(timer);
                                    resolve(result);
                                })
                                .catch((err) => {
                                    clearTimeout(timer);
                                    reject(err);
                                });
                        });
                    };

                    if (quotedAudio) {
                        // === PENGIRIMAN AUDIO KE CHANNEL ===
                        await sock.sendMessage(remoteJid, { text: '⏳ Mengkonversi audio untuk channel...' }, { quoted: msg });
                        logger.info('🔄 [KIRIM] Step 2: Konversi audio ke OGG Opus Mono...');

                        let channelAudioBuffer;
                        try {
                            channelAudioBuffer = await convertToOggOpus(mediaBuffer);
                            logger.info(`✅ [KIRIM] Step 2 selesai: OGG Opus ${channelAudioBuffer.length} bytes`);
                        } catch (convErr) {
                            logger.warn(`⚠️ [KIRIM] Gagal konversi OGG Opus: ${convErr.message}`);
                            channelAudioBuffer = mediaBuffer;
                        }

                        // === Attempt 1: Kirim sebagai PTT (voice note) OGG Opus ===
                        logger.info(`📡 [KIRIM] Step 3: Mengirim audio ke ${targetJid} (attempt 1: OGG PTT)...`);
                        try {
                            const result = await sendWithTimeout(targetJid, {
                                audio: channelAudioBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                waveform: generateWaveform(),
                            }, 60000);
                            logger.info(`✅ [KIRIM] Audio berhasil terkirim! Result: ${JSON.stringify(result?.key || 'ok')}`);
                        } catch (sendErr1) {
                            logger.error(`❌ [KIRIM] Attempt 1 gagal: ${sendErr1.message}`);
                            
                            // === Attempt 2: Kirim sebagai audio document (bukan PTT) ===
                            logger.info(`🔄 [KIRIM] Retry attempt 2: kirim sebagai audio document...`);
                            try {
                                const result2 = await sendWithTimeout(targetJid, {
                                    audio: channelAudioBuffer,
                                    mimetype: 'audio/ogg; codecs=opus',
                                    ptt: false,
                                }, 60000);
                                logger.info(`✅ [KIRIM] Attempt 2 berhasil! Result: ${JSON.stringify(result2?.key || 'ok')}`);
                            } catch (sendErr2) {
                                logger.error(`❌ [KIRIM] Attempt 2 gagal: ${sendErr2.message}`);
                                
                                // === Attempt 3: Konversi ke MP3 lalu kirim ===
                                logger.info(`🔄 [KIRIM] Retry attempt 3: konversi ke MP3 lalu kirim...`);
                                try {
                                    const { convertToMp3 } = require('./src/utils/audioConverter');
                                    const mp3Buffer = await convertToMp3(mediaBuffer);
                                    const result3 = await sendWithTimeout(targetJid, {
                                        audio: mp3Buffer,
                                        mimetype: 'audio/mpeg',
                                        ptt: false,
                                    }, 60000);
                                    logger.info(`✅ [KIRIM] Attempt 3 (MP3) berhasil! Result: ${JSON.stringify(result3?.key || 'ok')}`);
                                } catch (sendErr3) {
                                    logger.error(`❌ [KIRIM] Semua attempt gagal! Error terakhir: ${sendErr3.message}`);
                                    await sock.sendMessage(remoteJid, {
                                        text: `❌ *Gagal mengirim audio ke channel!*\n\n` +
                                              `📍 Target: \`${targetJid}\`\n` +
                                              `💬 Error: ${sendErr3.message}\n\n` +
                                              `💡 *Kemungkinan penyebab:*\n` +
                                              `• JID channel salah (pastikan format: xxx@newsletter)\n` +
                                              `• Bot belum follow/join channel tersebut\n` +
                                              `• Channel tidak mengizinkan audio\n` +
                                              `• Koneksi WhatsApp sedang tidak stabil`,
                                    }, { quoted: msg });
                                    continue;
                                }
                            }
                        }

                    } else if (quotedSticker) {
                        // === PENGIRIMAN STIKER KE CHANNEL ===
                        await sock.sendMessage(remoteJid, { text: '⏳ Mengirim stiker ke channel...' }, { quoted: msg });
                        logger.info(`📡 [KIRIM] Step 3: Mengirim stiker ke ${targetJid}...`);

                        try {
                            const result = await sendWithTimeout(targetJid, {
                                sticker: mediaBuffer
                            }, 60000);
                            logger.info(`✅ [KIRIM] Stiker berhasil terkirim! Result: ${JSON.stringify(result?.key || 'ok')}`);
                        } catch (stickerErr) {
                            logger.error(`❌ [KIRIM] Gagal kirim stiker: ${stickerErr.message}`);
                            await sock.sendMessage(remoteJid, {
                                text: `❌ *Gagal mengirim stiker ke channel!*\n\n` +
                                      `📍 Target: \`${targetJid}\`\n` +
                                      `💬 Error: ${stickerErr.message}\n\n` +
                                      `💡 *Tips:* Pastikan JID benar dan bot sudah follow channel.`,
                            }, { quoted: msg });
                            continue;
                        }
                    }

                    // Konfirmasi ke pengirim
                    await sock.sendMessage(remoteJid, {
                        text: `✅ ${quotedAudio ? 'Audio' : 'Stiker'} berhasil dikirim ke saluran:\n\`${targetJid}\``,
                    }, { quoted: msg });

                    logger.info(`📤 [KIRIM] Media berhasil dikirim ke saluran: ${targetJid}`);
                    continue;
                }

                // -----------------------------------------------
                // FITUR: HD ENHANCER — .hd (reply foto/video)
                // Tingkatkan kualitas foto/video menjadi HD
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'hd')) {
                    // Cek ketersediaan media (gambar atau video)
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg = message.imageMessage || message.videoMessage || quotedMsg?.imageMessage || quotedMsg?.videoMessage;
                    const isVideo = !!(message.videoMessage || quotedMsg?.videoMessage);

                    if (!mediaMsg) {
                        await randomDelay(500, 1500);
                        await sock.sendMessage(remoteJid, {
                            text: `📸 *HD Enhancer*\n\nTingkatkan kualitas foto/video menjadi HD!\n\n📌 *Cara pakai:*\n  • Kirim foto/video dengan caption \`${PREFIX}hd\`\n  • Atau reply foto/video lalu ketik \`${PREFIX}hd\`\n\n✨ Foto: upscale + sharpen + denoise + color enhance\n🎬 Video: upscale + sharpen + denoise (maks 60 detik)`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Download media
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
                        downloadKey, 'buffer', {},
                        { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                    );

                    if (!mediaBuffer) {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal download media' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1500);
                    await sock.sendMessage(remoteJid, {
                        text: isVideo
                            ? '⏳ Sedang memproses video HD, mohon tunggu...\n(Proses bisa 30-120 detik tergantung durasi)'
                            : '⏳ Sedang memproses foto HD, tunggu sebentar...',
                    }, { quoted: msg });
                    await randomDelay(500, 1000);

                    try {
                        if (isVideo) {
                            // HD Video
                            const result = await enhanceVideoHD(mediaBuffer);
                            await sock.sendMessage(remoteJid, {
                                document: result.buffer,
                                mimetype: 'video/mp4',
                                fileName: `HD_Video_${Date.now()}.mp4`,
                                caption: `✅ *Video HD Berhasil!*\n\n📐 Resolusi: ${result.originalWidth}x${result.originalHeight} → *${result.outputWidth}x${result.outputHeight}*\n⏱️ Durasi: ${result.duration} detik\n🎬 Codec: H.264 High Profile\n🎨 Filter: Upscale + Sharpen + Denoise + Color Enhance\n\n*(Dikirim sebagai dokumen agar kualitas HD tidak turun/dikompres oleh WhatsApp)*`,
                            }, { quoted: msg });
                            logger.info(`🎬 Video HD dikirim ke ${remoteJid} (${result.outputWidth}x${result.outputHeight})`);
                        } else {
                            // HD Image
                            const result = await enhanceImageHD(mediaBuffer);
                            await sock.sendMessage(remoteJid, {
                                document: result.buffer,
                                mimetype: 'image/jpeg',
                                fileName: `HD_Photo_${Date.now()}.jpg`,
                                caption: `✅ *Foto HD Berhasil!*\n\n📐 Resolusi: ${result.originalWidth}x${result.originalHeight} → *${result.width}x${result.height}*\n🎨 Filter: Upscale Lanczos3 + Sharpen + Denoise + Color Enhance\n\n*(Dikirim sebagai dokumen agar kualitas HD tidak turun/dikompres oleh WhatsApp)*`,
                            }, { quoted: msg });
                            logger.info(`📸 Foto HD dikirim ke ${remoteJid} (${result.width}x${result.height})`);
                        }
                    } catch (error) {
                        logger.error(`❌ HD error: ${error.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal memproses HD: ${error.message}`,
                        }, { quoted: msg });
                    }

                    continue;
                }

                // -----------------------------------------------
                // FITUR: LOTTIE ANIMATED STICKER
                // Perintah: .lottie [template] (reply/kirim gambar)
                // Mengubah gambar jadi sticker gerak (spin, zoom, bounce, shake, fade)
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'lottie')) {
                    // Parse template dari argumen
                    const cmdParts = textContent.split(' ');
                    const templateArg = cmdParts[1]?.toLowerCase() || 'spin';
                    const validTemplates = getTemplateList();

                    // Cek ketersediaan gambar (reply atau langsung)
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imageMsg = quotedMsg?.imageMessage;

                    if (!imageMsg) {
                        await randomDelay(500, 1500);
                        const templateList = validTemplates.map(t => `  • \`${PREFIX}lottie ${t}\``).join('\n');
                        await sock.sendMessage(remoteJid, {
                            text: `✨ *Lottie Animated Sticker*\n\n` +
                                `Ubah gambar jadi sticker gerak yang muncul gede!\n\n` +
                                `📌 *Cara pakai:*\n` +
                                `Reply gambar lalu ketik perintah, atau kirim gambar dengan caption.\n\n` +
                                `🎨 *Template animasi:*\n${templateList}\n\n` +
                                `Contoh: reply gambar + \`${PREFIX}lottie bounce\``,
                        }, { quoted: msg });
                        continue;
                    }

                    if (!validTemplates.includes(templateArg)) {
                        const templateList = validTemplates.map(t => `  • \`${t}\``).join('\n');
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Template "${templateArg}" tidak dikenal.\n\n🎨 Template tersedia:\n${templateList}`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Download gambar
                    let downloadKey;
                    if (quotedMsg?.imageMessage) {
                        downloadKey = {
                            message: quotedMsg,
                            key: {
                                remoteJid: msg.key.remoteJid,
                                id: message.extendedTextMessage.contextInfo.stanzaId,
                                participant: message.extendedTextMessage.contextInfo.participant,
                            },
                        };
                    }

                    const mediaBuffer = await downloadMediaMessage(
                        downloadKey,
                        'buffer',
                        {},
                        { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                    );

                    if (!mediaBuffer) {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal download gambar' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1500);
                    await sock.sendMessage(remoteJid, {
                        text: `⏳ Membuat Lottie sticker (efek: *${templateArg}*), tunggu sebentar...`,
                    }, { quoted: msg });
                    await randomDelay(500, 1000);

                    try {
                        const wasBuffer = await createLottieSticker(mediaBuffer, templateArg);
                        
                        // Generate content & upload
                        const content = await generateWAMessageContent(
                            { sticker: wasBuffer },
                            { upload: sock.waUploadToServer }
                        );
                        
                        if (content && content.stickerMessage) {
                            content.stickerMessage.mimetype = 'application/was';
                            content.stickerMessage.isLottie = true;
                            content.stickerMessage.isAnimated = true;

                            await sock.relayMessage(remoteJid, {
                                lottieStickerMessage: {
                                    message: {
                                        stickerMessage: content.stickerMessage
                                    }
                                }
                            }, { quoted: msg });
                        }
                        
                        logger.info(`✨ Lottie sticker (${templateArg}) dikirim ke ${remoteJid}`);
                    } catch (error) {
                        logger.error(`❌ Gagal buat Lottie sticker: ${error.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Gagal membuat Lottie sticker: ${error.message}`,
                        }, { quoted: msg });
                    }

                    continue;
                }

                // -----------------------------------------------
                // FITUR 2 & 3: STICKER DARI PERINTAH TEKS
                // Perintah: .sticker [teks opsional]
                // -----------------------------------------------

                if (
                    textContent.startsWith(PREFIX + 'sticker') || 
                    textContent === PREFIX + 's' || 
                    textContent.startsWith(PREFIX + 's ')
                ) {
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

                    // --- Lottie sticker via caption (.lottie pada gambar) ---
                    if (message.imageMessage && caption.startsWith(PREFIX + 'lottie')) {
                        const cmdParts = caption.split(' ');
                        const templateArg = cmdParts[1]?.toLowerCase() || 'spin';
                        const validTemplates = getTemplateList();

                        if (!validTemplates.includes(templateArg)) {
                            const templateList = validTemplates.map(t => `  • \`${t}\``).join('\n');
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Template "${templateArg}" tidak dikenal.\n\n🎨 Template tersedia:\n${templateList}`,
                            }, { quoted: msg });
                            continue;
                        }

                        const mediaBuffer = await downloadMediaMessage(
                            msg, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!mediaBuffer) {
                            await sock.sendMessage(remoteJid, { text: '❌ Gagal download gambar' }, { quoted: msg });
                            continue;
                        }

                        await simulateTyping(sock, remoteJid, 1500);
                        await sock.sendMessage(remoteJid, {
                            text: `⏳ Membuat Lottie sticker (efek: *${templateArg}*), tunggu sebentar...`,
                        }, { quoted: msg });
                        await randomDelay(500, 1000);

                        try {
                            const wasBuffer = await createLottieSticker(mediaBuffer, templateArg);
                            
                            // Generate content & upload
                            const content = await generateWAMessageContent(
                                { sticker: wasBuffer },
                                { upload: sock.waUploadToServer }
                            );
                            
                            if (content && content.stickerMessage) {
                                content.stickerMessage.mimetype = 'application/was';
                                content.stickerMessage.isLottie = true;
                                content.stickerMessage.isAnimated = true;

                                await sock.relayMessage(remoteJid, {
                                    lottieStickerMessage: {
                                        message: {
                                            stickerMessage: content.stickerMessage
                                        }
                                    }
                                }, { quoted: msg });
                            }
                            
                            logger.info(`✨ Lottie sticker (${templateArg}) via caption dikirim ke ${remoteJid}`);
                        } catch (error) {
                            logger.error(`❌ Gagal buat Lottie sticker: ${error.message}`);
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Gagal membuat Lottie sticker: ${error.message}`,
                            }, { quoted: msg });
                        }
                        continue;
                    }

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

                            let infoText = `✅ Background berhasil dihapus!`;
                            if (stickerText) infoText += `\n📝 Teks: *${stickerText}*`;
                            if (method.includes('remove.bg') && creditsLeft !== null) {
                                infoText += `\n💳 Thanks`;
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

                    // --- HD Enhance via caption (.hd) ---
                    if (caption.startsWith(PREFIX + 'hd')) {
                        const isVideo = !!message.videoMessage;

                        await simulateTyping(sock, remoteJid, 1500);
                        await sock.sendMessage(remoteJid, {
                            text: isVideo
                                ? '⏳ Sedang memproses video HD, mohon tunggu...\n(Proses bisa 30-120 detik tergantung durasi)'
                                : '⏳ Sedang memproses foto HD, tunggu sebentar...',
                        }, { quoted: msg });

                        try {
                            const mediaBuf = await downloadMediaMessage(
                                msg, 'buffer', {},
                                { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                            );
                            if (!mediaBuf) throw new Error('Gagal download media');

                            if (isVideo) {
                                // Cek durasi video
                                const vidDuration = message.videoMessage?.seconds || 0;
                                if (vidDuration > 60) {
                                    await sock.sendMessage(remoteJid, { text: '❌ Durasi video maksimal 60 detik untuk fitur HD.' }, { quoted: msg });
                                    continue;
                                }

                                const result = await enhanceVideoHD(mediaBuf);
                                await sock.sendMessage(remoteJid, {
                                    document: result.buffer,
                                    mimetype: 'video/mp4',
                                    fileName: `HD_Video_${Date.now()}.mp4`,
                                    caption: `✅ *Video HD Berhasil!*\n\n📐 Resolusi: ${result.originalWidth}x${result.originalHeight} → *${result.outputWidth}x${result.outputHeight}*\n⏱️ Durasi: ${result.duration} detik\n🎬 Codec: H.264 High Profile\n🎨 Filter: Upscale + Sharpen + Denoise + Color Enhance\n\n*(Dikirim sebagai dokumen agar kualitas HD tidak turun/dikompres oleh WhatsApp)*`,
                                }, { quoted: msg });
                                logger.info(`🎬 Video HD (caption) dikirim ke ${remoteJid}`);
                            } else {
                                const result = await enhanceImageHD(mediaBuf);
                                await sock.sendMessage(remoteJid, {
                                    document: result.buffer,
                                    mimetype: 'image/jpeg',
                                    fileName: `HD_Photo_${Date.now()}.jpg`,
                                    caption: `✅ *Foto HD Berhasil!*\n\n📐 Resolusi: ${result.originalWidth}x${result.originalHeight} → *${result.width}x${result.height}*\n🎨 Filter: Upscale Lanczos3 + Sharpen + Denoise + Color Enhance\n\n*(Dikirim sebagai dokumen agar kualitas HD tidak turun/dikompres oleh WhatsApp)*`,
                                }, { quoted: msg });
                                logger.info(`📸 Foto HD (caption) dikirim ke ${remoteJid}`);
                            }
                        } catch (err) {
                            logger.error(`❌ HD caption error: ${err.message}`);
                            await sock.sendMessage(remoteJid, { text: `❌ Gagal memproses HD: ${err.message}` }, { quoted: msg });
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
                if (textContent.startsWith(PREFIX + 'ttaudio') || textContent.startsWith(PREFIX + 'ttmp3') || textContent.startsWith(PREFIX + 'tt')) {
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

                if (textContent.startsWith(PREFIX + 'tiktoksearch')) {
                    const q = textContent.replace(/^\.tiktoksearch\s*/i, '').trim();
                    if (!q) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}tiktoksearch <keyword>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Mencari di TikTok...' }, { quoted: msg });
                    try {
                        const dl = require('./src/features/downloader');
                        const res = await dl.tiktokSearch(q);
                        const list = res.slice(0, 5).map((r, i) => `*${i+1}.* ${r.title || 'Video'}\n🔗 ${r.url || r.link}`).join('\n\n');
                        await sock.sendMessage(remoteJid, { text: `📱 *Hasil Pencarian TikTok:*\n\n${list}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: INSTAGRAM DOWNLOADER
                // Perintah: .ig <url> atau .instagram <url>
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'ig') || textContent.startsWith(PREFIX + 'instagram')) {
                    const args = textContent.split(' ');
                    const url = args[1];

                    if (!url || !url.includes('instagram.com')) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format salah! Gunakan: *${PREFIX}ig <link_instagram>*` }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1500);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mendownload media Instagram, tunggu bentar ya...' }, { quoted: msg });

                    try {
                        const mediaList = await getInstagramMedia(url);
                        
                        if (!mediaList || mediaList.length === 0) {
                            throw new Error('Tidak ada media yang ditemukan atau link tidak valid/private.');
                        }

                        // IG bisa mengirim balik array berisi video/foto jika itu carousel
                        for (const media of mediaList) {
                            // Cek tipe media secara sederhana melalui ext (mp4 = video, jpg/png = image)
                            // Jika objek memuat url
                            const mediaUrl = media._url || media.url;
                            if (mediaUrl.includes('.mp4')) {
                                await sock.sendMessage(remoteJid, {
                                    video: { url: mediaUrl },
                                    caption: `🎬 Instagram Video`,
                                    mimetype: 'video/mp4'
                                }, { quoted: msg });
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    image: { url: mediaUrl },
                                    caption: `📸 Instagram Foto`,
                                    mimetype: 'image/jpeg'
                                }, { quoted: msg });
                            }
                            await randomDelay(1000, 2000); // jeda sedikit agar tidak spam limit wa
                        }

                        logger.info(`✅ Instagram media dikirim ke ${remoteJid}`);
                    } catch (error) {
                        await sock.sendMessage(remoteJid, { text: `${error.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: DOWNLOADER (YTMP3, YTMP4, SPOTIFY, FB)
                // -----------------------------------------------
                const dl = require('./src/features/downloader');
                
                if (textContent.startsWith(PREFIX + 'ytmp3') || textContent.startsWith(PREFIX + 'play')) {
                    const query = textContent.replace(/^\.(ytmp3|play)\s*/i, '').trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}ytmp3 <link/judul>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses audio...' }, { quoted: msg });
                    try {
                        const res = await dl.ytmp3(query);
                        await sock.sendMessage(remoteJid, {
                            audio: { url: res.url },
                            mimetype: 'audio/mp4',
                            ptt: false
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'ytmp4')) {
                    const url = textContent.replace(/^\.ytmp4\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}ytmp4 <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses video...' }, { quoted: msg });
                    try {
                        const res = await dl.ytmp4(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🎥 *${res.title}*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'spotify ') || textContent.startsWith(PREFIX + 'spotify\n') || textContent.trim() === PREFIX + 'spotify') {
                    const url = textContent.replace(/^\.spotify\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}spotify <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mendownload dari Spotify...' }, { quoted: msg });
                    try {
                        const res = await dl.spotifyDl(url);
                        await sock.sendMessage(remoteJid, {
                            audio: { url: res.url },
                            mimetype: 'audio/mp4',
                            ptt: false
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'spotifysearch')) {
                    const q = textContent.replace(/^\.spotifysearch\s*/i, '').trim();
                    if (!q) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}spotifysearch <judul>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Mencari...' }, { quoted: msg });
                    try {
                        const res = await dl.spotifySearch(q);
                        const list = res.slice(0, 5).map((r, i) => `*${i+1}.* ${r.title}\n🔗 ${r.url}`).join('\n\n');
                        await sock.sendMessage(remoteJid, { text: `🎵 *Hasil Pencarian Spotify:*\n\n${list}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'facebook') || textContent.startsWith(PREFIX + 'fb')) {
                    const url = textContent.replace(/^\.(facebook|fb)\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}facebook <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mendownload video FB...' }, { quoted: msg });
                    try {
                        const res = await dl.facebookDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🎥 *${res.title}*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'twitter') || textContent.startsWith(PREFIX + 'x')) {
                    const url = textContent.replace(/^\.(twitter|x)\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}twitter <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Twitter/X...' }, { quoted: msg });
                    try {
                        const res = await dl.twitterDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🐦 *Twitter/X Video*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'thread')) {
                    const url = textContent.replace(/^\.thread\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}thread <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Threads...' }, { quoted: msg });
                    try {
                        const res = await dl.threadsDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🧵 *Threads Media*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'douyin')) {
                    const url = textContent.replace(/^\.douyin\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}douyin <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Douyin...' }, { quoted: msg });
                    try {
                        const res = await dl.douyinDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🏮 *Douyin Video*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'cocofun')) {
                    const url = textContent.replace(/^\.cocofun\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}cocofun <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Cocofun...' }, { quoted: msg });
                    try {
                        const res = await dl.cocofunDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `🤣 *Cocofun Video*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'likee')) {
                    const url = textContent.replace(/^\.likee\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}likee <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Likee...' }, { quoted: msg });
                    try {
                        const res = await dl.likeeDl(url);
                        await sock.sendMessage(remoteJid, {
                            video: { url: res.url },
                            caption: `✨ *Likee Video*`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'gdrive') || textContent.startsWith(PREFIX + 'grive')) {
                    const url = textContent.replace(/^\.(gdrive|grive)\s*/i, '').trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}gdrive <link>*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang memproses Google Drive...' }, { quoted: msg });
                    try {
                        const res = await dl.gdriveDl(url);
                        await sock.sendMessage(remoteJid, {
                            document: { url: res.url },
                            fileName: res.title || 'gdrive_file',
                            mimetype: 'application/octet-stream'
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
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
                // FITUR: CONVERT STICKER KE FOTO / VIDEO
                // Perintah: .toimg atau .tovid (reply sticker)
                // -----------------------------------------------
                if (textContent === PREFIX + 'toimg' || textContent === PREFIX + 'tovid' || textContent === PREFIX + 'tofoto') {
                    // Cari contextInfo dari semua kemungkinan lokasi di struktur pesan Baileys
                    const quotedCtx =
                        message.extendedTextMessage?.contextInfo ||
                        message.imageMessage?.contextInfo ||
                        message.videoMessage?.contextInfo ||
                        message.audioMessage?.contextInfo ||
                        message.documentMessage?.contextInfo ||
                        message.stickerMessage?.contextInfo ||
                        (message.conversation && msg.message?.extendedTextMessage?.contextInfo) ||
                        null;

                    const qMsg = quotedCtx?.quotedMessage;

                    // Handle Lottie sticker (animasi vector JSON — format WhatsApp/Telegram)
                    if (qMsg?.lottieStickerMessage) {
                        await simulateTyping(sock, remoteJid, 1000);
                        await sock.sendMessage(remoteJid, { text: '⏳ Memproses Lottie sticker, harap tunggu...' }, { quoted: msg });

                        const lottieQuotedObj = {
                            key: {
                                remoteJid  : remoteJid,
                                id         : quotedCtx.stanzaId,
                                fromMe     : quotedCtx.participant === sock.user?.id,
                                participant: quotedCtx.participant,
                            },
                            message: qMsg,
                        };

                        // ── Coba download full Lottie (3-layer fallback) ──────────────────
                        let lottieBuf = null;
                        let usedThumbnail = false;
                        
                        // Cek apakah original message ada di cache memori (bila sticker baru diforward)
                        const cachedMsg = msgCache.get(quotedCtx.stanzaId);
                        const baseLottieMsg = cachedMsg?.lottieStickerMessage || qMsg.lottieStickerMessage;
                        
                        // KUNCI: WA bungkus Lottie ke dalam "FutureProofMessage"
                        // Jadi isinya ada di lottieStickerMessage.message.stickerMessage !
                        const lottieRawMsg = baseLottieMsg?.message?.stickerMessage 
                                            || baseLottieMsg?.message?.documentMessage 
                                            || baseLottieMsg;
                        
                        logger.info(`[LOTTIE-DEBUG] raw fields: ${Object.keys(lottieRawMsg).join(', ')}`);
                        if (lottieRawMsg.mediaKey) logger.info('[LOTTIE-DEBUG] Has mediaKey (unwrap sukses)');

                        // Layer 1A: Jika mediaKey belum ada, samarkan sebagai stickerMessage
                        // lalu updateMediaMessage → refresh URL/key dari server WA by message ID
                        let lottieMediaMsg = { ...lottieRawMsg };
                        if (!lottieMediaMsg.mediaKey || lottieMediaMsg.mediaKey.length === 0) {
                            try {
                                const masqueradeObj = {
                                    key: {
                                        remoteJid  : remoteJid,
                                        id         : quotedCtx.stanzaId,
                                        fromMe     : quotedCtx.participant === sock.user?.id,
                                        participant: quotedCtx.participant,
                                    },
                                    // Samarkan sebagai stickerMessage — field-nya identik
                                    message: { stickerMessage: { ...lottieRawMsg } },
                                };
                                const refreshed = await sock.updateMediaMessage(masqueradeObj);
                                const freshSticker = refreshed?.message?.stickerMessage;
                                if (freshSticker?.mediaKey?.length > 0) {
                                    lottieMediaMsg = freshSticker;
                                    logger.info('[LOTTIE] Media key berhasil di-refresh via masquerade');
                                }
                            } catch (refreshErr) {
                                logger.warn(`[LOTTIE] updateMedia masquerade gagal: ${refreshErr.message}`);
                            }
                        }

                        // Layer 1B: Download stream dengan key yang tersedia
                        if (lottieMediaMsg?.mediaKey?.length > 0) {
                            try {
                                const stream = await downloadContentFromMessage(lottieMediaMsg, 'sticker');
                                const chunks = [];
                                for await (const chunk of stream) chunks.push(chunk);
                                if (chunks.length > 0) lottieBuf = Buffer.concat(chunks);
                                logger.info(`[LOTTIE] Download berhasil: ${lottieBuf?.length} bytes`);
                                
                                // DEBUG MAGIC BYTES
                                if (lottieBuf) {
                                    const head = lottieBuf.subarray(0, 16).toString('hex');
                                    const headStr = lottieBuf.subarray(0, 16).toString('utf-8').replace(/[^a-zA-Z0-9_-]/g, '.');
                                    logger.info(`[LOTTIE-DEBUG] File Header HEX: ${head}`);
                                    logger.info(`[LOTTIE-DEBUG] File Header STR: ${headStr}`);
                                }
                            } catch (dlErr) {
                                logger.warn(`[LOTTIE] download stream gagal: ${dlErr.message}`);
                            }
                        }

                        // Layer 1C: Direct HTTP download dari URL (tanpa decrypt — beberapa sticker publik)
                        if (!lottieBuf && lottieRawMsg?.url) {
                            try {
                                const https = require('https');
                                const http  = require('http');
                                const targetUrl = lottieRawMsg.url;
                                const httpLib = targetUrl.startsWith('https') ? https : http;
                                lottieBuf = await new Promise((res, rej) => {
                                    httpLib.get(targetUrl, (response) => {
                                        const chunks = [];
                                        response.on('data', c => chunks.push(c));
                                        response.on('end',  () => res(Buffer.concat(chunks)));
                                        response.on('error', rej);
                                    }).on('error', rej);
                                });
                                if (lottieBuf?.length < 50) lottieBuf = null; // terlalu kecil = gagal
                                else logger.info(`[LOTTIE] HTTP download berhasil: ${lottieBuf?.length} bytes`);
                            } catch (httpErr) {
                                logger.warn(`[LOTTIE] HTTP download gagal: ${httpErr.message}`);
                                lottieBuf = null;
                            }
                        }

                        // Layer 2: Fallback ke thumbnail yang tersimpan di quoted message
                        if (!lottieBuf) {
                            const rawThumb = lottieRawMsg?.pngThumbnail || lottieRawMsg?.jpegThumbnail;

                            if (rawThumb && rawThumb.length > 0) {
                                usedThumbnail = true;
                                const thumbBuf = Buffer.isBuffer(rawThumb) ? rawThumb : Buffer.from(rawThumb);
                                const sharp = require('sharp');
                                lottieBuf = await sharp(thumbBuf)
                                    .resize(512, 512, { kernel: 'nearest', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                                    .png()
                                    .toBuffer();
                                logger.info('[LOTTIE] Menggunakan thumbnail sebagai fallback');
                            }
                        }


                        // Layer 3: Tidak ada data sama sekali
                        if (!lottieBuf) {
                            await sock.sendMessage(remoteJid, {
                                text: '❌ Tidak dapat mengunduh Lottie sticker ini.\n\n💡 Coba forward sticker ke bot lalu reply dengan .toimg'
                            }, { quoted: msg });
                            continue;
                        }

                        // ── Proses & kirim hasil ──────────────────────────────────────────
                        try {
                            if (usedThumbnail) {
                                // Thumbnail sudah jadi PNG
                                await sock.sendMessage(remoteJid, {
                                    image: lottieBuf,
                                    mimetype: 'image/png',
                                    caption: '✅ Berhasil ekstrak Lottie sticker (dari thumbnail)'
                                }, { quoted: msg });
                            } else if (textContent === PREFIX + 'tovid') {
                                try {
                                    const mp4Buf = await lottieToVideo(lottieBuf);
                                    await sock.sendMessage(remoteJid, {
                                        video: mp4Buf,
                                        mimetype: 'video/mp4',
                                        caption: '✅ Berhasil ekstrak Lottie sticker ke video'
                                    }, { quoted: msg });
                                } catch (e) {
                                    if (e.message.includes('Bukan file TGS')) {
                                        logger.info('[LOTTIE] File terdeteksi sebagai WebP biasa (animasi), melakukan konversi WebP...');
                                        const mp4Buf = await stickerToVideo(lottieBuf);
                                        await sock.sendMessage(remoteJid, {
                                            video: mp4Buf,
                                            mimetype: 'video/mp4',
                                            caption: '✅ Berhasil ekstrak Lottie (WebP) ke video'
                                        }, { quoted: msg });
                                    } else throw e;
                                }
                            } else {
                                try {
                                    const pngBuf = await lottieToImage(lottieBuf);
                                    await sock.sendMessage(remoteJid, {
                                        image: pngBuf,
                                        mimetype: 'image/png',
                                        caption: '✅ Berhasil ekstrak Lottie sticker ke gambar'
                                    }, { quoted: msg });
                                } catch (e) {
                                    if (e.message.includes('Bukan file TGS')) {
                                        logger.info('[LOTTIE] File terdeteksi sebagai WebP biasa, melakukan konversi WebP...');
                                        const pngBuf = await stickerToImage(lottieBuf);
                                        await sock.sendMessage(remoteJid, {
                                            image: pngBuf,
                                            mimetype: 'image/png',
                                            caption: '✅ Berhasil ekstrak Lottie (WebP) ke gambar'
                                        }, { quoted: msg });
                                    } else throw e;
                                }
                            }
                        } catch (renderErr) {
                            logger.error(`❌ Lottie render error: ${renderErr.message}`);
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Gagal render Lottie sticker: ${renderErr.message}`
                            }, { quoted: msg });
                        }
                        continue;
                    }


                    // Helper: unwrap semua jenis wrapper sticker di quotedMessage
                    // WA punya banyak tipe: biasa, viewOnce, viewOnceV2, ephemeral, documentWithCaption
                    const unwrapSticker = (q) => {
                        if (!q) return null;
                        return q.stickerMessage ||
                            q.viewOnceMessage?.message?.stickerMessage ||
                            q.viewOnceMessageV2?.message?.stickerMessage ||
                            q.viewOnceMessageV2Extension?.message?.stickerMessage ||
                            q.ephemeralMessage?.message?.stickerMessage ||
                            q.documentWithCaptionMessage?.message?.stickerMessage ||
                            q.editedMessage?.message?.stickerMessage ||
                            // Lottie juga bisa terbungkus dalam wrapper
                            q.viewOnceMessage?.message?.lottieStickerMessage ||
                            q.ephemeralMessage?.message?.lottieStickerMessage ||
                            null;
                    };

                    const quotedSticker = unwrapSticker(qMsg);

                    if (!quotedSticker) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* sticker yang ingin diubah menjadi gambar/video, lalu ketik *${PREFIX}toimg*`,
                        }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengekstrak sticker...' }, { quoted: msg });

                    // Untuk download, kita tetap pakai quotedMessage asli (bukan unwrapped)
                    // agar Baileys bisa menemukan media key yang benar
                    const quotedMsgObj = {
                        key: {
                            remoteJid: remoteJid,
                            id: quotedCtx.stanzaId,
                            fromMe: quotedCtx.participant === sock.user?.id,
                            participant: quotedCtx.participant,
                        },
                        message: quotedCtx.quotedMessage,
                    };

                    try {
                        const stickerBuf = await downloadMediaMessage(
                            quotedMsgObj, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!stickerBuf) throw new Error('Gagal download sticker');

                        if (quotedSticker.isAnimated) {
                            const mp4Buf = await stickerToVideo(stickerBuf);
                            await sock.sendMessage(remoteJid, {
                                video: mp4Buf,
                                mimetype: 'video/mp4',
                                caption: '✅ Berhasil ekstrak ke video'
                            }, { quoted: msg });
                        } else {
                            const pngBuf = await stickerToImage(stickerBuf);
                            await sock.sendMessage(remoteJid, {
                                image: pngBuf,
                                mimetype: 'image/png',
                                caption: '✅ Berhasil ekstrak ke gambar'
                            }, { quoted: msg });
                        }
                    } catch (err) {
                        logger.error(`❌ toimg error: ${err.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal ekstrak sticker: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }
                // -----------------------------------------------
                // FITUR: GAME TEBAK-TEBAKAN
                // -----------------------------------------------
                const gameCmds = ['tebaktebakan', 'tebakkata', 'tebakbendera', 'tebakkimia', 'tebaklirik', 'tebakgambar'];
                const triggeredGame = gameCmds.find(cmd => textContent.trim() === PREFIX + cmd);
                if (triggeredGame) {
                    await games.startGame(sock, remoteJid, msg, triggeredGame);
                    continue;
                }

                // -----------------------------------------------
                // FITUR: TAGALL & HIDETAG (KHUSUS GRUP & ADMIN)
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'tagall') || textContent.startsWith(PREFIX + 'hidetag')) {
                    const isGroup = remoteJid.endsWith('@g.us');
                    
                    if (!isGroup) {
                        await sock.sendMessage(remoteJid, { text: '❌ Perintah ini hanya bisa digunakan di dalam grup!' }, { quoted: msg });
                        continue;
                    }
                    
                    let groupMetadata;
                    try {
                        groupMetadata = await sock.groupMetadata(remoteJid);
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil data grup.' }, { quoted: msg });
                        continue;
                    }

                    const participants = groupMetadata.participants;
                    const sender = msg.key.participant || msg.key.remoteJid;
                    const cleanSender = sender.replace(/:[0-9]+/, '');
                    
                    // Cek apakah sender adalah admin grup (atau owner bot)
                    const senderObj = participants.find(p => p.id.replace(/:[0-9]+/, '') === cleanSender);
                    const isGroupAdmin = senderObj?.admin === 'admin' || senderObj?.admin === 'superadmin';
                    
                    if (!isGroupAdmin && !isOwner) {
                        await sock.sendMessage(remoteJid, { text: '❌ Hanya admin grup atau owner bot yang bisa menggunakan perintah ini!' }, { quoted: msg });
                        continue;
                    }

                    const isHidetag = textContent.startsWith(PREFIX + 'hidetag');
                    const args = textContent.split(' ');
                    
                    let messageText = args.slice(1).join(' ').trim();
                    const quotedCtx = message.extendedTextMessage?.contextInfo;
                    const quotedMsg = quotedCtx?.quotedMessage;
                    
                    if (!messageText && quotedMsg?.conversation) {
                        messageText = quotedMsg.conversation;
                    } else if (!messageText && quotedMsg?.extendedTextMessage?.text) {
                        messageText = quotedMsg.extendedTextMessage.text;
                    }
                    
                    const mentions = participants.map(p => p.id);
                    
                    let textInfo = '';
                    
                    if (isHidetag) {
                        // Jika tidak ada teks tambahan, gunakan karakter kosong (invisible)
                        textInfo = messageText || '\u200B';
                    } else {
                        textInfo = messageText ? `📢 *PENGUMUMAN*\n\n📝 ${messageText}\n\n` : `📢 *TAG ALL*\n\n`;
                        textInfo += `👥 *Daftar Member (${participants.length}):*\n`;
                        for (let i = 0; i < participants.length; i++) {
                            textInfo += `  ${i + 1}. @${participants[i].id.split('@')[0]}\n`;
                        }
                    }
                    
                    await sock.sendMessage(remoteJid, {
                        text: textInfo,
                        mentions: mentions
                    });
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

                    const groupAdminSection = isOwner ? 
                        `┏━『 *GRUP (ADMIN)* 』\n` +
                        `┃\n` +
                        `┣⌬ ${PREFIX}kick / .add\n` +
                        `┣⌬ ${PREFIX}promote / .demote\n` +
                        `┣⌬ ${PREFIX}setnamegc / .setdescgc\n` +
                        `┣⌬ ${PREFIX}setppgc / .linkgc / .revokelink\n` +
                        `┣⌬ ${PREFIX}setopen / .setclose\n` +
                        `┣⌬ ${PREFIX}welcome / .setwelcome\n` +
                        `┣⌬ ${PREFIX}left / .setleft\n` +
                        `┣⌬ ${PREFIX}antilink (kick/nokick)\n` +
                        `┣⌬ ${PREFIX}antibadword (kick/nokick)\n` +
                        `┣⌬ ${PREFIX}antidelete / .antiviewonce\n` +
                        `┣⌬ ${PREFIX}antibot / .antibot_kick (on/off)\n` +
                        `┣⌬ ${PREFIX}automute / .setmute / .setunmute\n` +
                        `┣⌬ ${PREFIX}addsewa / .ceksewa / .delsewa\n` +
                        `┣⌬ ${PREFIX}addbadword / .listbadword\n` +
                        `┣⌬ ${PREFIX}mulaiabsen / .deleteabsen\n` +
                        `┣⌬ ${PREFIX}addlist / .dellist\n` +
                        `┣⌬ ${PREFIX}warn / .delwarn\n` +
                        `┣⌬ ${PREFIX}blacklist / .delblacklist\n` +
                        `┗━━━━━━━◧\n\n` : '';

                    const helpText =
                        `🤖 *${BOT_NAME}* — Daftar Perintah
 
 ┏━『 *STICKER & LOTTIE* 』
 ┃
 ┣⌬ ${PREFIX}sticker
 ┣⌬ ${PREFIX}toimg
 ┣⌬ ${PREFIX}tovid
 ┣⌬ ${PREFIX}lottie
 ┗━━━━━━━◧
 
 ┏━『 *EDIT & AI* 』
 ┃
 ┣⌬ ${PREFIX}rmbgstatus
 ┣⌬ ${PREFIX}teks / .quote
 ┣⌬ ${PREFIX}brat / .hd
 ┗━━━━━━━◧
 
 ┏━『 *DOWNLOADER* 』
 ┃
 ┣⌬ ${PREFIX}tiktok / .ttaudio
 ┣⌬ ${PREFIX}ig / .instagram
 ┣⌬ ${PREFIX}ytmp3 / .ytmp4
 ┣⌬ ${PREFIX}play / .spotify
 ┗━━━━━━━◧
 
 ┏━『 *GRUP (MEMBER)* 』
 ┃
 ┣⌬ ${PREFIX}afk [alasan]
 ┣⌬ ${PREFIX}absen / .cekabsen
 ┣⌬ ${PREFIX}list / .[kunci_list]
 ┣⌬ ${PREFIX}hidetag / .tagall
 ┣⌬ ${PREFIX}cekwarn / .listblacklist
 ┣⌬ ${PREFIX}groupinfo / .myid
 ┗━━━━━━━◧
 
 ${groupAdminSection}` +
`┏━『 *GAMES* 』
┃
┣⌬ ${PREFIX}tebakgambar
┣⌬ ${PREFIX}tebaktebakan
┣⌬ ${PREFIX}tebakkata
┣⌬ ${PREFIX}tebakbendera
┗━━━━━━━◧
 
 ┏━『 *INFO & OWNER* 』
 ┃
 ┣⌬ ${PREFIX}help / .menu
 ┣⌬ ${PREFIX}owner / .jadwal
 ┗━━━━━━━◧
 
 *Info Tambahan:*
 • Bot 24/7 dengan session tersimpan
 • Owner: ${cfg.getDisplayOwner() || 'belum diatur'}`;

                    const { useMenuImage, menuImage } = cfg.getConfig();
                    
                    if (useMenuImage && menuImage) {
                        await sock.sendMessage(remoteJid, {
                            image: { url: menuImage },
                            caption: helpText,
                            mentions: [msg.key.participant || msg.key.remoteJid]
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                    }
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

// Tangkap error tak terduga supaya bot tidak crash permanen
process.on('uncaughtException', (err) => {
    logger.error(`💥 uncaughtException: ${err.message}`);
    logger.error(err.stack || '');
    
    // Jika error Timed Out dari Baileys, jangan crash — biarkan reconnect handle
    if (err.message && (err.message.includes('Timed Out') || err.message.includes('timed out'))) {
        logger.warn('⏱️ Error timeout dari Baileys — menunggu reconnect otomatis...');
        return; // Jangan restart, biarkan connection.update yang handle
    }
    
    // Untuk error lain: restart bot setelah 5 detik
    if (!isRestarting) {
        isRestarting = true;
        logger.info('🔄 Restart otomatis dalam 5 detik...');
        setTimeout(() => {
            isRestarting = false;
            startBot().catch((e) => logger.error(`💥 Restart gagal: ${e.message}`));
        }, 5000);
    }
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`💥 unhandledRejection: ${msg}`);
    
    // Jika rejection karena timeout, jangan panic
    if (msg.includes('Timed Out') || msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
        logger.warn('⏱️ Timeout rejection — menunggu reconnect otomatis...');
        return;
    }
    // Tidak crash — biarkan reconnect logic Baileys yang handle
});

// Graceful shutdown: bersihkan keepalive saat SIGINT/SIGTERM
process.on('SIGINT', () => {
    logger.info('👋 SIGINT diterima, mematikan bot...');
    stopKeepalive();
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger.info('👋 SIGTERM diterima, mematikan bot...');
    stopKeepalive();
    process.exit(0);
});

startBot().catch((err) => {
    logger.error(`💥 Fatal error: ${err.message}`);
    logger.info('🔄 Restart otomatis dalam 5 detik...');
    setTimeout(() => startBot().catch(() => process.exit(1)), 5000);
});

