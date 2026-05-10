require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Helper untuk kirim notifikasi ke Telegram (mendukung main & child bots)
const notifyTelegram = (message) => {
    // Jika sesi utama, gunakan event emitter (lebih efisien)
    if (typeof SESSION_NAME !== 'undefined' && SESSION_NAME === 'session') {
        if (global.botEvents) global.botEvents.emit('telegram_message', message);
    } else {
        // Untuk bot anak, kirim langsung via API ke semua ID terdaftar
        const tgPath = path.join(__dirname, '.env_telegram');
        if (fs.existsSync(tgPath)) {
            const content = fs.readFileSync(tgPath, 'utf8');
            const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(.*)/);
            const ownerMatch = content.match(/TELEGRAM_OWNER_ID=(.*)/);
            if (tokenMatch && ownerMatch) {
                const token = tokenMatch[1].trim();
                const ownerIds = ownerMatch[1].trim().split(',');
                const axios = require('axios');
                for (const id of ownerIds) {
                    if (id.trim()) {
                        axios.get(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id.trim()}&text=${encodeURIComponent(message)}&parse_mode=Markdown`).catch(() => {});
                    }
                }
            }
        }
    }
};

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

const tools = require('./src/features/tools');
const { logger, baileyLogger } = require('./src/utils/logger');
const { exec } = require('child_process');

// --- PENDENGAR PERINTAH INTERNAL (Untuk Telegram Control) ---
if (!global.botEvents) {
    const { EventEmitter } = require('events');
    global.botEvents = new EventEmitter();
}
const { randomDelay, simulateTyping, rateLimiter, shouldProcess } = require('./src/utils/antiBan');
const cfg = require('./src/utils/config');
const { 
    convertToSticker, 
    createStickerWithText, 
    createAnimatedSticker, 
    createAnimatedStickerWithText,
    createCircleSticker,
    createRoundedSticker,
    createMemeSticker,
    createFilteredSticker,
    addExif
} = require('./src/features/sticker');
const { removeBackgroundImage, removeBackgroundVideo, removeBackgroundVideoAI, detectDominantBgColor, checkRemoveBgCredits, resetRemoveBgStatus } = require('./src/features/removebg');
const { getTikTokAudio, getTikTokVideo } = require('./src/features/tiktok');
const { getInstagramMedia } = require('./src/features/instagram');
const { generateTextImage, generateBratImage } = require('./src/features/textImage');
const { generateFakeThumbnail } = require('./src/features/fakePreview');
const { convertToOggOpus, convertToMp3, generateWaveform, getAudioDuration } = require('./src/utils/audioConverter');
const { stickerToImage, stickerToVideo } = require('./src/features/extractor');
const { lottieToImage, lottieToVideo } = require('./src/features/lottieConverter');
const { createLottieSticker, getTemplateList } = require('./src/features/lottieSticker');
const sanka = require('./src/features/sanka');
const { enhanceImageHD, enhanceVideoHD } = require('./src/features/hdEnhancer');
const scheduler = require('./src/features/scheduler');
const games = require('./src/features/games');
const statusFeatures = require('./src/features/status');
const { applyVoiceFilter } = require('./src/features/voiceChanger');
const groupFeatures = require('./src/features/group');
const { createLyricSticker, createLyricStickerStatic, createStickerCover, parseColor: parseLyricColor, parseGradient: parseLyricGradient, LYRIC_FONT_KEYS, LYRIC_THEME_KEYS, LYRIC_EFFECT_KEYS, LYRIC_ANIM_KEYS } = require('./src/features/lyricSticker');
const _lyricFontSet   = new Set(LYRIC_FONT_KEYS.concat(['georgia','classic','elegan','romantis','heavy','tebal','besar','comic','fun','lucu','santai','clean','rapi','compact','tahoma','sans','biasa','arial','mono','typewriter','ketik','mesin','courier','trebo','stylish','trebuchet','verdana','impact']));
const _lyricThemeSet  = new Set(LYRIC_THEME_KEYS);
const _lyricEffectSet = new Set(LYRIC_EFFECT_KEYS);
const _lyricAnimSet   = new Set(LYRIC_ANIM_KEYS);

const ryzumi = require('./src/features/ryzumi');
const channelCopier = require('./src/features/channelCopier');
const abstract = require('./src/features/abstract');
const phonespecs = require('./src/features/phonespecs');
const limit = require('./src/features/limit');
const qrcode = require('qrcode-terminal');
const { EventEmitter } = require('events');

// ============================================================
// KONFIGURASI
// ============================================================
const minimist = require('minimist');
const botManager = require('./src/features/botManager');

// Parsing argumen CLI (untuk multi-session)
const argv = minimist(process.argv.slice(2));
const SESSION_NAME = argv.session || argv._[0] || 'session';
const SESSION_PATH = path.join(__dirname, SESSION_NAME === 'session' ? 'session' : `sessions/${SESSION_NAME}`);

// Start Telegram Control ONLY for main session and if not disabled
if (SESSION_NAME === 'session' && !process.env.DISABLE_TELEGRAM && !argv['no-tg']) {
    try {
        require('./telegramControl.js');
        console.log('🤖 Telegram Remote Control Integrated & Started.');
    } catch (e) {
        console.error('❌ Failed to start Telegram Control:', e.message);
    }
}

if (SESSION_NAME !== 'session' && !fs.existsSync(path.join(__dirname, 'sessions'))) {
    fs.mkdirSync(path.join(__dirname, 'sessions'));
}

const CHANNEL_JID = process.env.CHANNEL_JID || '';
const OWNER_NUMBER = argv.owner || argv._[1] || process.env.OWNER_NUMBER || '';
// Owner pertama adalah owner utama untuk tampilan, sisanya adalah shadow owner
const PRIMARY_OWNER = OWNER_NUMBER.split(',')[0] || '';
const BOT_NAME = process.env.BOT_NAME || 'Robby Bot';
const PREFIX = process.env.PREFIX || '.';

// Folder penyimpanan sesi (cookie / auth) - akan di-persist untuk login 1x
const SESSION_DIR = SESSION_PATH;
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

global.botEvents.on('console_command', (data) => {
    const input = data.toString().trim();
    if (input === 'git_pull') {
        console.log('🔄 [REMOTE] Menjalankan Update dari GitHub (Node.js)...');
        (async () => {
            try {
                const https = require('https');
                const AdmZip = require('adm-zip');
                const zipUrl = 'https://codeload.github.com/gifranmaahii/yourmysunsun/zip/refs/heads/master';
                const zipPath = path.join(__dirname, '_update.zip');
                await new Promise((resolve, reject) => {
                    const follow = (url, depth = 0) => {
                        if (depth > 5) return reject(new Error('Too many redirects'));
                        https.get(url, (res) => {
                            if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location, depth + 1);
                            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                            const out = fs.createWriteStream(zipPath);
                            res.pipe(out);
                            out.on('finish', resolve);
                            out.on('error', reject);
                        }).on('error', reject);
                    };
                    follow(zipUrl);
                });
                console.log('📦 Zip downloaded, extracting...');
                const zip = new AdmZip(zipPath);
                const entries = zip.getEntries();
                const prefix = 'yourmysunsun-master/';
                const skip = ['session/', 'sessions/', 'data/', '.env', '.env_telegram', 'node_modules/'];
                for (const entry of entries) {
                    const name = entry.entryName;
                    if (!name.startsWith(prefix)) continue;
                    const rel = name.slice(prefix.length);
                    if (!rel) continue;
                    if (skip.some(s => rel.startsWith(s))) continue;
                    const dest = path.join(__dirname, rel);
                    if (entry.isDirectory) { fs.mkdirSync(dest, { recursive: true }); continue; }
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.writeFileSync(dest, entry.getData());
                }
                fs.unlinkSync(zipPath);
                console.log('✅ Update selesai, restart...');
                if (global.botEvents) global.botEvents.emit('telegram_message', '✅ *Update berhasil!* Bot akan restart dalam 3 detik...');
                setTimeout(() => process.exit(1), 3000);
            } catch (e) {
                console.error(`❌ Update Error: ${e.message}`);
                if (global.botEvents) global.botEvents.emit('telegram_message', `❌ Update gagal: ${e.message.slice(0,300)}`);
            }
        })();
    }
    if (input === 'logout_bot') {
        console.log('🗑️ [REMOTE] Menghapus sesi bot dari Telegram...');
        const sessionPath = path.join(__dirname, SESSION_NAME === 'session' ? 'session' : `sessions/${SESSION_NAME}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('✅ Sesi berhasil dihapus.');
            process.exit(1);
        } else {
            console.log('❌ Folder sesi tidak ditemukan.');
        }
    }
    if (input === 'restart_all_bots') {
        console.log('🔄 [REMOTE] Merestart SEMUA bot anak dari Telegram...');
        exec('npx pm2 restart "/^bot_/"', (err) => {
            if (err) return console.error(`❌ Restart All Error: ${err.message}`);
            console.log('✅ Semua bot anak berhasil direstart.');
        });
    }
    if (input.startsWith('restart_bot_ku ')) {
        const target = input.replace('restart_bot_ku ', '');
        const botName = target.startsWith('bot_') ? target : `bot_${target.replace(/[^0-9]/g, '')}`;
        console.log(`🔄 [REMOTE] Merestart bot anak: ${botName}...`);
        exec(`npx pm2 restart ${botName}`, (err) => {
            if (err) return console.error(`❌ Restart Bot Error: ${err.message}`);
            console.log(`✅ Bot ${botName} berhasil direstart.`);
        });
    }
    if (input.startsWith('add_bot ')) {
        const args = input.replace('add_bot ', '').split(' ');
        if (args.length >= 4) {
            const [phone, nameRaw, days, owner] = args;
            const name = nameRaw.replace(/_/g, ' ');
            console.log(`🚀 [REMOTE] Menambah bot anak: ${name} (${phone}) untuk ${days} hari...`);
            const targetJid = PRIMARY_OWNER.includes('@') ? PRIMARY_OWNER : `${PRIMARY_OWNER}@s.whatsapp.net`;
            botManager.addChildBot(currentSock, targetJid, phone, name, days, owner, 'pairing', true);
        }
    }
    if (input.startsWith('add_bot_qr ')) {
        const args = input.replace('add_bot_qr ', '').split(' ');
        if (args.length >= 4) {
            const [phone, nameRaw, days, owner] = args;
            const name = nameRaw.replace(/_/g, ' ');
            console.log(`🚀 [REMOTE] Menambah bot anak via QR: ${name} (${phone}) untuk ${days} hari...`);
            const targetJid = PRIMARY_OWNER.includes('@') ? PRIMARY_OWNER : `${PRIMARY_OWNER}@s.whatsapp.net`;
            botManager.addChildBot(currentSock, targetJid, phone, name, days, owner, 'qr', true);
        }
    }
    if (input === 'list_bots') {
        console.log('📋 [REMOTE] list_bots ditangani langsung di telegramControl.js');
    }
    if (input.startsWith('delete_bot ') || input.startsWith('delete_bots ')) {
        const target = input.replace(/delete_bots? /, '').trim();
        console.log(`🗑️ [REMOTE] Menghapus bot anak: ${target}`);
        const fakeSock2 = { sendMessage: (_jid, msgObj) => {
            const txt = (msgObj && msgObj.text) ? msgObj.text : JSON.stringify(msgObj);
            if (global.botEvents) global.botEvents.emit('telegram_message', txt);
            return Promise.resolve();
        }};
        const targetJid = PRIMARY_OWNER.includes('@') ? PRIMARY_OWNER : `${PRIMARY_OWNER}@s.whatsapp.net`;
        botManager.deleteChildBot(fakeSock2, targetJid, target).catch(e => {
            if (global.botEvents) global.botEvents.emit('telegram_message', `❌ Error delete bot: ${e.message}`);
        });
    }
    if (input.startsWith('pair_bot ')) {
        const num = input.replace('pair_bot ', '').trim();
        console.log(`🔑 [REMOTE] Menyiapkan pairing code untuk: ${num}`);
        fs.writeFileSync(path.join(__dirname, 'pairing.json'), JSON.stringify({ number: num }));
        const sessionPath = path.join(__dirname, SESSION_NAME === 'session' ? 'session' : `sessions/${SESSION_NAME}`);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        process.exit(1);
    }
});

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

// Timer Pembersihan Temp & Cek Expired Bot Anak (Setiap 1 jam)
setInterval(async () => {
    try {
        // 1. Bersihkan folder temp
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            let deletedCount = 0;
            const now = Date.now();
            for (const file of files) {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > 60 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }
            if (deletedCount > 0) logger.info(`🧹 Membersihkan ${deletedCount} file temp.`);
        }

        // 2. Cek Expired Bot Anak (Hanya dijalankan oleh Bot Utama)
        if (SESSION_NAME === 'session') {
            const bots = botManager.getChildBots();
            const { exec } = require('child_process');
            let changed = false;
            
            for (const bot of bots) {
                if (bot.status === 'active' && new Date() > new Date(bot.expiryAt)) {
                    logger.warn(`🚨 Bot Anak ${bot.name} (${bot.phone}) telah EXPIRED! Mematikan proses...`);
                    exec(`npx pm2 stop bot_${bot.phone}`);
                    bot.status = 'expired';
                    changed = true;
                }
            }
            if (changed) botManager.saveChildBots(bots);
        }
    } catch (e) {
        logger.error('Gagal menjalankan maintenance timer: ' + e.message);
    }
}, 60 * 60 * 1000);

async function startBot() {
    // Inisialisasi bot anak jika ini adalah sesi utama (Panel Pterodactyl)
    if (SESSION_NAME === 'session') {
        try {
            await botManager.initChildBots();
            // Jalankan monitoring setiap 10 menit
            setInterval(() => {
                if (currentSock) botManager.monitorChildBots(currentSock);
            }, 10 * 60 * 1000);
        } catch (e) {
            console.error('❌ Gagal inisialisasi bot anak:', e.message);
        }
    }

    // Muat state auth dari folder session (cookie otomatis disimpan di sini)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    // Init config (merge .env defaults + data/config.json)
    cfg.initConfig({
        botName: process.env.BOT_NAME || 'Robby Bot',
        stickerPackName: process.env.BOT_NAME || 'Robby Bot',
        stickerPackAuthor: process.env.BOT_NAME || 'Robby Bot',
        ownerNumber: process.env.OWNER_NUMBER || '',
        channelJid: process.env.CHANNEL_JID || '',
        prefix: process.env.PREFIX || '.',
    }, SESSION_NAME);

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
    
    if (SESSION_NAME === 'session') {
        logger.info(`🤖 ${BOT_NAME} menggunakan Baileys v${version.join('.')} (latest: ${isLatest})`);
    } else {
        logger.info(`🤖 Bot Anak [${SESSION_NAME}] menggunakan Baileys v${version.join('.')}`);
    }

    const credsPath = path.join(SESSION_PATH, 'creds.json');
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

    if (!hasSession) {
        // Cek file pairing.json (dari Telegram Remote)
        const pairingFile = path.join(__dirname, 'pairing.json');
        if (fs.existsSync(pairingFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(pairingFile));
                usePairingCode = true;
                phoneNumber = String(data.number).replace(/[^0-9]/g, '');
                fs.unlinkSync(pairingFile); // Hapus agar tidak pairing ulang terus
                logger.info(`🔑 Pairing mode aktif via pairing.json untuk: ${phoneNumber}`);
            } catch (e) {
                logger.error('❌ Gagal membaca pairing.json: ' + e.message);
            }
        }

        if (argv.qr) {
            usePairingCode = false;
            console.log(' 📱 QR Mode aktif via flag --qr.');
        } else if (!usePairingCode && (argv.pairing || (SESSION_NAME === 'session' && process.env.PAIRING_NUMBER))) {
            usePairingCode = true;
            phoneNumber = String(argv.pairing || process.env.PAIRING_NUMBER).replace(/[^0-9]/g, '');
            logger.info(`🔑 Pairing mode otomatis menggunakan nomor: ${phoneNumber}`);
        } else if (!usePairingCode) {
            // Jika bukan TTY (terminal interaktif), default ke QR untuk keamanan (biar gak hang di PM2)
            if (!process.stdin.isTTY) {
                console.log(' 📱 Non-interactive terminal detected. Defaulting to QR Mode.');
                usePairingCode = false;
            } else {
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                const question = (text) => new Promise(resolve => readline.question(text, resolve));

                console.log(`\n========================================================`);
                console.log(` 🤖 LOGIN ${BOT_NAME.toUpperCase()} [${SESSION_NAME}]`);
                console.log(`========================================================`);
                console.log(` 1. QR Code (Scan langsung)`);
                console.log(` 2. Pairing Code (Masukkan nomor HP)`);
                console.log(`========================================================`);
                
                const choice = await question(' 🛠️ Pilih metode login (1/2): ');
                
                if (choice === '2') {
                    usePairingCode = true;
                    const num = await question(' 📞 Masukkan nomor WhatsApp (contoh: 628123456789): ');
                    phoneNumber = num.replace(/[^0-9]/g, '');
                    if (!phoneNumber) {
                        console.log(' ❌ Nomor tidak valid! Mengalihkan ke QR Code...');
                        usePairingCode = false;
                    }
                } else {
                    console.log(' 📱 Menyiapkan QR Code...');
                    usePairingCode = false;
                }
                readline.close();
            }
        }
    } else {
        logger.info('🔑 Sesi valid ditemukan. Melanjutkan login otomatis...');
    }

    // Buat socket WA
    // Gunakan Browsers.windows('Desktop') agar muncul tulisan "Windows" dan warna Hijau
    const browserConfig = usePairingCode
        ? Browsers.ubuntu('Chrome') 
        : Browsers.windows('Desktop');
    
    logger.info(`🌐 Browser config: ${JSON.stringify(browserConfig)} (pairing: ${usePairingCode})`);

    // Ambil konfigurasi Low RAM
    const IS_LOW_RAM = argv['low-ram'] || false;
    if (IS_LOW_RAM) {
        logger.info(`🍃 [MODE ENTENG] Mengaktifkan pengoptimalan memori untuk bot ${SESSION_NAME}...`);
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger: baileyLogger,
        printQRInTerminal: !usePairingCode,
        browser: browserConfig,
        syncFullHistory: !IS_LOW_RAM, // Matikan sinkronisasi history kalau mode enteng
        markOnlineOnConnect: true, // Paksa tetap Hijau (Online) meskipun mode enteng agar Bos tidak bingung
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        getMessage: async (key) => {
            return msgCache.get(key.id) || undefined;
        },
    });

    currentSock = sock;

    // Request Pairing Code — tunggu WebSocket + handshake selesai, lalu minta kode 1x
    let pairingTimer = null;
    if (usePairingCode && !hasSession && !state.creds.registered) {

        // Tunggu WebSocket benar-benar terhubung (maks 5 detik)
        console.log(' ⏳ Menunggu koneksi WebSocket ke server WhatsApp...');
        let wsReady = false;
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (sock.ws?.readyState === sock.ws?.OPEN) {
                wsReady = true;
                console.log(' ✅ WebSocket terhubung!');
                break;
            }
            console.log(` ⏳ Menunggu koneksi... (${i + 1}/5)`);
        }

        if (!wsReady) {
            console.log(' ❌ WebSocket gagal terhubung. Coba jalankan ulang bot.');
        } else {
            // Tunggu 2 detik saja agar handshake internal WA selesai
            console.log(' ⏳ Menunggu handshake selesai (2 detik)...');
            await new Promise(r => setTimeout(r, 2000));

            // Fungsi request pairing — hanya dipanggil 1x, retry jika gagal
            const requestPairing = async (attempt = 1) => {
                try {
                    console.log(` ⏳ Meminta kode pairing ke server WhatsApp... (percobaan ke-${attempt})`);
                    const code = await sock.requestPairingCode(phoneNumber);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`\n========================================================`);
                    console.log(` 🔑 KODE PAIRING ANDA: ${formattedCode}`);
                    console.log(`PAIRING_CODE: ${formattedCode}`);
                    console.log(` 📞 Nomor: ${phoneNumber}`);
                    console.log(` 💡 Buka WhatsApp HP → Setelan → Perangkat Tertaut`);
                    console.log(`    → Tautkan Perangkat → Tautkan dengan nomor telepon`);
                    console.log(` ⏳ Kode berlaku ±2 menit.`);
                    console.log(`========================================================\n`);
                } catch (err) {
                    logger.error('❌ Gagal mendapatkan pairing code: ' + err.message);
                    if (attempt < 3) {
                        const retryDelay = attempt * 5000;
                        console.log(` ⚠️ Mencoba ulang dalam ${retryDelay / 1000} detik...`);
                        setTimeout(() => requestPairing(attempt + 1), retryDelay);
                    } else {
                        console.log(' ❌ Gagal 3x. Coba jalankan ulang bot dengan: npm start');
                    }
                }
            };

            await requestPairing();
        }
    }

    // ============================================================
    // EVENT: Update koneksi
    // ============================================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Tampilkan QR code di terminal menggunakan qrcode-terminal
            if (!usePairingCode) {
                console.log(`\nRAW_QR_CODE:${qr}\n`);
                qrcode.generate(qr, { small: true });
                logger.info('📱 Scan QR code di atas untuk login WhatsApp');
                logger.info('💾 Setelah login, sesi akan disimpan otomatis (tidak perlu scan ulang)');
            }
        }

        if (connection === 'close') {
            stopKeepalive();
            const code = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown';
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            logger.warn(`⚠️ Koneksi terputus (kode: ${code}, error: ${errorMsg}). Reconnect: ${shouldReconnect}`);
            
            if (code === DisconnectReason.loggedOut) {
                notifyTelegram(`🚫 *Bot Terputus (LOGOUT)*\n\n📱 Sesi: ${SESSION_NAME}\n⚠️ Status: Sesi dihapus dari HP.`);
            } else {
                notifyTelegram(`⚠️ *Koneksi Terputus!*\n\n📱 Sesi: ${SESSION_NAME}\n❌ Error: ${errorMsg}\n🔄 Reconnect: ${shouldReconnect ? 'Ya' : 'Tidak'}`);
            }

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
                // Logika Reconnect yang Lebih Tangguh
                isRestarting = true;
                const delay = getReconnectDelay(reconnectAttempts);
                reconnectAttempts++;
                
                // Jika error timeout atau lag, bersihkan file pre-key/sender-key yang bermasalah
                if (errorMsg.includes('Timed Out') || errorMsg.includes('timed out') || code === 408 || code === 503) {
                    logger.warn('⏱️ Koneksi Timeout! Membersihkan cache session agar lancar kembali...');
                    try {
                        const files = fs.readdirSync(SESSION_DIR);
                        for (const file of files) {
                            if (file.startsWith('pre-key-') || file.startsWith('sender-key-')) {
                                fs.unlinkSync(path.join(SESSION_DIR, file));
                            }
                        }
                    } catch (_) {}
                }

                logger.info(`🔄 Mencoba Reconnect #${reconnectAttempts} dalam ${Math.round(delay/1000)} detik...`);
                
                setTimeout(() => {
                    isRestarting = false;
                    if (currentSock) {
                        try { currentSock.ws?.close(); } catch (_) {}
                        currentSock = null;
                    }
                    startBot().catch(e => {
                        logger.error(`💥 Reconnect gagal: ${e.message}`);
                        // Jika gagal parah pun, jangan exit. Coba lagi nanti.
                        setTimeout(() => startBot(), 10000);
                    });
                }, delay);
                }
            } else {
                // Jika benar-benar Logout (un-linked dari HP)
                logger.error('🚫 Session Logout atau Tidak Valid. Menghapus folder session...');
                try {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                } catch (_) {}
                
                logger.warn('⚠️ Bot terhenti karena Logout. Mencoba restart untuk scan ulang...');
                setTimeout(() => startBot(), 5000);
            }
        }

        if (connection === 'open') {
            // Hentikan timer pairing jika ada
            if (pairingTimer) {
                clearInterval(pairingTimer);
                pairingTimer = null;
            }

            // Reset counter reconnect karena berhasil tersambung
            reconnectAttempts = 0;
            isRestarting = false;
            const botNumber = sock.user.id.split(':')[0];
            console.log(`\n========================================================`);
            console.log(` ✅ SUCCESS: ${BOT_NAME} [${SESSION_NAME}]`);
            console.log(` 📱 Nomor   : ${botNumber}`);
            console.log(` 🟢 Status  : TERHUBUNG!`);
            console.log(`========================================================\n`);
            
            logger.info(`✅ ${BOT_NAME} berhasil terhubung ke WhatsApp!`);
            logger.info(`📡 Channel target: ${CHANNEL_JID || '(belum diatur)'}`);
            logger.info(`👤 Owner: ${OWNER_NUMBER}`);

            // Aktifkan keepalive system agar koneksi tetap hidup
            startKeepalive(sock);

            // Start scheduler untuk jadwal kirim otomatis
            scheduler.startScheduler(sock);

            // Aktifkan Auto-Manager (Sewa & Auto-Mute)
            groupFeatures.initAutoManager(sock);
            
            notifyTelegram(`✅ *Bot WhatsApp Terhubung!*\n\n👤 Nama: ${BOT_NAME}\n📱 Sesi: ${SESSION_NAME}\n🟢 Status: Online`);
        }
    });

    // ============================================================
    // EVENT: Simpan credentials (session/cookie) setiap update
    // ============================================================
    sock.ev.on('creds.update', saveCreds);

    // ── AUTO ACCEPT ADMIN SALURAN via newsletter events ──────────────────────
    const _autoAcceptAdminInvite = async (rawMsg) => {
        try {
            const m = rawMsg?.message || rawMsg || {};
            const invite = m.newsletterAdminInviteMessage ||
                m.ephemeralMessage?.message?.newsletterAdminInviteMessage ||
                m.viewOnceMessage?.message?.newsletterAdminInviteMessage;
            if (!invite) return;

            const channelJid  = invite.newsletterJid;
            const channelName = invite.newsletterName || 'Saluran';
            logger.info(`[AUTO-ADMIN] ✅ Undangan admin: ${channelName} (${channelJid})`);

            // Kirim notif hanya ke sender yang kirim invite (bukan semua owner)
            const senderJid = rawMsg?.key?.remoteJid || rawMsg?.key?.participant;

            const notifText = `📢 *UNDANGAN ADMIN SALURAN MASUK!*\n\n` +
                `📛 Saluran: *${channelName}*\n` +
                `🔑 JID: \`${channelJid}\`\n\n` +
                `⚠️ Accept manual dari HP ya, WhatsApp blokir auto-accept via API.\n\n` +
                `Setelah accept, ketik:\n` +
                `\`.accsaluran https://whatsapp.com/channel/${channelJid.split('@')[0]}\``;

            if (senderJid) {
                await sock.sendMessage(senderJid, { text: notifText }).catch(() => {});
            }

            const success = false; // placeholder agar log di bawah tetap jalan

            if (success) cfg.update('channelJid', channelJid);
        } catch (e) {
            logger.error('[AUTO-ADMIN] Error: ' + e.message);
        }
    };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            await _autoAcceptAdminInvite(m);
        }
    });

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
        // DEBUG LOG: Cek apakah event upsert masuk
        console.log(`\n📥 [EVENT] messages.upsert type=${upsert.type}, count=${upsert.messages?.length || 0}`);
        
        // Hanya proses pesan baru (bukan notifikasi sinkronisasi)
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            try {
                const _remoteJid = msg.key.remoteJid || '';
                const _fromMe = msg.key.fromMe || false;
                const _sender = msg.key.participant || _remoteJid;
                
                // LOG CHAT (Tampilkan semua untuk debug agar Bos bisa lihat ID-nya)
                const isNewsletter = _remoteJid.endsWith('@newsletter');
                const isOwner = cfg.isOwner(_sender) || _fromMe; // Bot sendiri dianggap owner juga
                
                console.log(`\n💬 [CHAT-IN] From: ${_sender}, isOwner: ${isOwner}, JID: ${_remoteJid}`);
                
                // --- Filter dasar (anti-ban & keamanan) ---
                // Jika bukan owner/dari bot sendiri, cek filter anti-ban (pesan lama, dsb)
                if (!isOwner && !shouldProcess(msg, sock)) {
                    console.log(`🚫 [FILTER] Pesan diabaikan oleh shouldProcess`);
                    continue;
                }

                // Newsletter: cek dulu apakah channelCopier mau tangkap
                if (isNewsletter) {
                    try {
                        await channelCopier.handleCopier(sock, msg);
                    } catch (e) {
                        logger.error(`[COPIER] Error: ${e.message}`);
                    }
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

                // ── [EKSPERIMENTAL] AUTO ACCEPT ADMIN SALURAN ────────────────────
                // Cek di original message (sebelum unwrap) DAN current message
                const _origMsg = msg.message || {};
                const _newsletterInvite = message?.newsletterAdminInviteMessage ||
                    _origMsg?.newsletterAdminInviteMessage ||
                    _origMsg?.ephemeralMessage?.message?.newsletterAdminInviteMessage ||
                    _origMsg?.viewOnceMessage?.message?.newsletterAdminInviteMessage;

                if (_newsletterInvite) {
                    try {
                        const invite = _newsletterInvite;
                        const channelJid = invite.newsletterJid;
                        const channelName = invite.newsletterName || 'Saluran';
                        logger.info(`[AUTO-ADMIN] Raw keys: ${JSON.stringify(Object.keys(_origMsg))}`);
                        
                        logger.info(`[AUTO-ADMIN] 🚨 Terdeteksi undangan admin untuk saluran: ${channelName} (${channelJid})`);
                        
                        // Dump payload ke file untuk analisis (jaga-jaga kalau cara ini gagal)
                        require('fs').writeFileSync('./debug_admin_invite.json', JSON.stringify(msg, null, 2));

                        await sock.sendMessage(remoteJid, {
                            text: `🤖 *[EKSPERIMEN] Undangan Admin Terdeteksi!*\n\n` +
                                  `Target: *${channelName}*\n` +
                                  `Mencoba bypass sistem untuk auto-accept... ⏳`
                        }, { quoted: msg });

                        const queryWithTimeout = (queryObj, timeoutMs = 8000) => {
                            return Promise.race([
                                sock.query(queryObj),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                            ]);
                        };

                        let success = false;

                        // Percobaan 1: Action = accept_invite
                        try {
                            await queryWithTimeout({
                                tag: 'iq',
                                attrs: { id: sock.generateMessageTag(), type: 'set', xmlns: 'newsletter', to: channelJid },
                                content: [{ tag: 'accept_invite', attrs: {} }]
                            });
                            success = true;
                        } catch (e1) {
                            // Percobaan 2: role = ADMIN
                            try {
                                await queryWithTimeout({
                                    tag: 'iq',
                                    attrs: { id: sock.generateMessageTag(), type: 'set', xmlns: 'newsletter', to: channelJid },
                                    content: [{ tag: 'accept', attrs: { role: 'ADMIN' } }]
                                });
                                success = true;
                            } catch (e2) {
                                // Percobaan 3: action = accept
                                try {
                                    await queryWithTimeout({
                                        tag: 'iq',
                                        attrs: { id: sock.generateMessageTag(), type: 'set', xmlns: 'newsletter', to: channelJid },
                                        content: [{ tag: 'participant', attrs: { action: 'accept' } }]
                                    });
                                    success = true;
                                } catch (e3) {
                                    logger.warn('[AUTO-ADMIN] Semua metode bypass gagal.');
                                }
                            }
                        }

                        if (success) {
                            await sock.sendMessage(remoteJid, { text: `✅ *BERHASIL!* Bot sukses melakukan auto-accept tanpa klik manual.` }, { quoted: msg });
                            cfg.update('channelJid', channelJid);
                        } else {
                            await sock.sendMessage(remoteJid, { text: `⚠️ *Bypass Gagal.* Sistem XMPP WhatsApp menolak auto-accept.\nSilakan tetap klik "Accept" manual.` }, { quoted: msg });
                        }

                    } catch (err) {
                        logger.error('[AUTO-ADMIN] Error: ' + err.message);
                    }
                }
                // ────────────────────────────────────────────────────────────

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
                        // Update msg.key agar handler fitur (seperti group.js) juga melihat nomor HP-nya
                        if (msg.key.participant) msg.key.participant = rawSenderJid;
                        else if (!remoteJid.endsWith('@g.us')) msg.key.remoteJid = rawSenderJid;
                        
                        logger.debug(`[LID-RESOLVE] ${lidNum} → ${resolved}`);
                    } else {
                        // Coba cari di sock.contacts
                        const contactEntries = Object.entries(sock.contacts || {});
                        for (const [cJid, cData] of contactEntries) {
                            if (cData.lid && cfg.cleanNumber(cData.lid) === lidNum) {
                                const resolvedPhone = cfg.cleanNumber(cJid);
                                if (resolvedPhone) {
                                    rawSenderJid = resolvedPhone + '@s.whatsapp.net';
                                    if (msg.key.participant) msg.key.participant = rawSenderJid;
                                    else if (!remoteJid.endsWith('@g.us')) msg.key.remoteJid = rawSenderJid;
                                    
                                    lidMap.set(lidNum, resolvedPhone);
                                    break;
                                }
                            }
                        }
                    }
                }

                // Cek owner/admin dengan KEDUA format: resolved JID DAN raw asli
                const senderIsOwner = cfg.isOwner(rawSenderJid) || cfg.isOwner(originalRaw);
                const senderIsAdmin = cfg.isAdmin(rawSenderJid) || cfg.isAdmin(originalRaw);

                // --- LIMIT CHECK ---
                const isAuthorized = senderIsOwner || senderIsAdmin;
                const limitStatus = limit.checkLimit(rawSenderJid, isAuthorized);
                
                // Hanya cek limit jika pesan diawali prefix (perintah)
                if (textContent.startsWith(PREFIX) && limitStatus.isLimit) {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ *Lɪᴍɪᴛ Tᴇʀᴄᴀᴘᴀɪ!*\n\n` +
                              `Maaf, kamu sudah mencapai batas penggunaan bot hari ini (*${activeCfg.limitCount}* perintah).\n\n` +
                              `💡 Limit akan direset otomatis setiap jam 00:00 WIB.\n` +
                              `👑 Hubungi Owner untuk upgrade ke Premium.` 
                    }, { quoted: msg });
                    continue;
                }
                
                // Tambahkan usage jika pesan diawali prefix (perintah)
                if (textContent.startsWith(PREFIX)) {
                    limit.addUsage(rawSenderJid, isAuthorized);
                }

                // Log identitas sender (untuk memantau @lid)
                console.log(`🔐 Sender   : raw=${originalRaw} → resolved=${rawSenderJid}`);
                console.log(`🔐 Status   : owner=${senderIsOwner}, admin=${senderIsAdmin}`);

                // --- FITUR MODERASI GRUP ---
                await groupFeatures.handleGroupModeration(sock, msg, textContent, remoteJid, fromMe);

                // --- FITUR COMMAND GRUP ---
                const groupCmdHandled = await groupFeatures.handleGroupCommand(sock, msg, textContent, remoteJid, senderIsOwner);
                if (groupCmdHandled) continue;

                // --- FITUR MULTI-COPIER ---
                if (textContent.toLowerCase().startsWith(PREFIX + 'copier')) {
                    console.log(`[DEBUG] Copier command detected in index.js: "${textContent}"`);
                }
                const copierHandled = await channelCopier.handleCommand(sock, remoteJid, msg, textContent, senderIsOwner);
                if (copierHandled) {
                    console.log(`[DEBUG] Copier command handled: ${textContent}`);
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

                    const helpText = `🤖 *${cfg.getConfig().botName}* — Daftar Perintah

┏━『 *STICKER & LOTTIE* 』
┃
┣⌬ ${PREFIX}sticker — Buat sticker dari foto/video
┣⌬ ${PREFIX}qc — Quotly sticker (balon chat)
┣⌬ ${PREFIX}toimg / ${PREFIX}tovid — Sticker → foto/video
┣⌬ ${PREFIX}lottie / ${PREFIX}ssearch — Sticker animasi Lottie
┣⌬ ${PREFIX}hd — Perjelas/upscale gambar
┗━━━━━━━◧

┏━『 *🎵 STICKER LIRIK* 』
┃
┣⌬ ${PREFIX}stickerlirik — Sticker lirik animasi per baris
┣⌬ ${PREFIX}stickerlirik2 — Sticker lirik tampil bertahap
┣⌬ ${PREFIX}stickercover — Sticker cover judul lagu
┃
┃ Ketik tanpa teks untuk lihat semua opsi & tutorial
┗━━━━━━━◧

┏━『 *RYZUMI PREMIUM AI* 』
┃
┣⌬ ${PREFIX}ai [tanya] — Chat AI canggih
┣⌬ ${PREFIX}gemini [tanya] — Google Gemini AI
┣⌬ ${PREFIX}flux [deskripsi] — Generate gambar AI
┣⌬ ${PREFIX}remini — Perjelas foto buram
┗━━━━━━━◧

┏━『 *DOWNLOADER* 』
┃
┣⌬ ${PREFIX}tiktok / ${PREFIX}ttaudio — Download TikTok
┣⌬ ${PREFIX}ig / ${PREFIX}instagram — Download Instagram
┣⌬ ${PREFIX}ytmp3 / ${PREFIX}ytmp4 — Download YouTube
┣⌬ ${PREFIX}play / ${PREFIX}pinvideo — Cari & download lagu
┗━━━━━━━◧

┏━『 *GRUP & ADMIN* 』
┃
┣⌬ ${PREFIX}kick / ${PREFIX}add / ${PREFIX}warn
┣⌬ ${PREFIX}promote / ${PREFIX}demote
┣⌬ ${PREFIX}setnamegc / ${PREFIX}setopen
┣⌬ ${PREFIX}linkgc / ${PREFIX}revokelink
┣⌬ ${PREFIX}antilink / ${PREFIX}antilinkgc
┣⌬ ${PREFIX}antilinkch / ${PREFIX}antikick
┣⌬ ${PREFIX}antibot / ${PREFIX}welcome 
┣⌬ ${PREFIX}antidelete / ${PREFIX}tagall
┣⌬ ${PREFIX}hidetag / ${PREFIX}groupinfo
┣⌬ ${PREFIX}afk / ${PREFIX}absen / ${PREFIX}list
┗━━━━━━━◧

┏━『 *TOOLS & SEARCH* 』
┃
┣⌬ ${PREFIX}ss [url] / ${PREFIX}sholat
┣⌬ ${PREFIX}stalkig / ${PREFIX}stalktt / ${PREFIX}stalkgh
┣⌬ ${PREFIX}google / ${PREFIX}pin
┣⌬ ${PREFIX}gempa / ${PREFIX}news / ${PREFIX}cuaca
┣⌬ ${PREFIX}jokes / ${PREFIX}quotes / ${PREFIX}doa
┣⌬ ${PREFIX}kbbi / ${PREFIX}wiki / ${PREFIX}tr
┣⌬ ${PREFIX}tts / ${PREFIX}shortlink
┣⌬ ${PREFIX}lacakno / ${PREFIX}cekno / ${PREFIX}kurs
┣⌬ ${PREFIX}timezone / ${PREFIX}phone / ${PREFIX}gsm
┗━━━━━━━◧

┏━『 *GAMES (2000+ Soal!)* 』
┃
┣⌬ ${PREFIX}tebakgambar / ${PREFIX}tebaklirik
┣⌬ ${PREFIX}tebaktebakan / ${PREFIX}tebakbendera
┣⌬ ${PREFIX}asahotak / ${PREFIX}siapakahaku
┣⌬ ${PREFIX}susunkata / ${PREFIX}math / ${PREFIX}tod
┣⌬ ${PREFIX}gamelist — Daftar lengkap game
┗━━━━━━━◧

┏━『 *AUDIO & SALURAN* 』
┃
┣⌬ ${PREFIX}kirim / ${PREFIX}ceksaluran
┣⌬ ${PREFIX}accsaluran [link]
┣⌬ ${PREFIX}tovn [filter] — Voice note dengan efek
┣⌬ ${PREFIX}copier — Multi-Copier Saluran
┣⌬ ${PREFIX}caraupload — Tutorial upload ke saluran
┗━━━━━━━◧

💡 *Tips:* Ketik perintah tanpa tanda kurung.
Ketik perintah sendiri (tanpa argumen) untuk melihat tutorial lengkapnya.
• Owner: ${cfg.getDisplayOwner() || 'belum diatur'}`;

                    const { useMenuImage, menuImage } = cfg.getConfig();
                    
                    if (useMenuImage && menuImage) {
                        try {
                            await sock.sendMessage(remoteJid, {
                                image: { url: menuImage },
                                caption: helpText,
                                mentions: [msg.key.participant || msg.key.remoteJid]
                            }, { quoted: msg });
                        } catch (imgErr) {
                            logger.error(`⚠️ Gagal mengirim gambar menu (URL error): ${imgErr.message}`);
                            // Fallback ke teks jika gambar gagal
                            await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                            await sock.sendMessage(remoteJid, { text: `⚠️ *Catatan:* Gambar menu gagal dimuat. Pastikan file gambar atau link valid.` }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                    }
                    continue;
                }


                // ============================================================
                // FITUR RYZUMI PREMIUM
                // ============================================================
                
                // 1. AI CHAT (.ai / .gemini)
                if (textContent.startsWith(PREFIX + 'ai') || textContent.startsWith(PREFIX + 'gemini')) {
                    const isGemini = textContent.startsWith(PREFIX + 'gemini');
                    const prompt = textContent.slice(isGemini ? (PREFIX + 'gemini').length : (PREFIX + 'ai').length).trim();
                    if (!prompt) {
                        await sock.sendMessage(remoteJid, { text: `💬 Mau tanya apa?\nContoh: *${PREFIX}${isGemini ? 'gemini' : 'ai'} cara masak rendang*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                    try {
                        const response = await ryzumi.aiChat(prompt, isGemini ? 'gemini' : 'chatgpt');
                        await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 2. SSWEB (.ss)
                if (textContent.startsWith(PREFIX + 'ss ') || textContent.trim() === PREFIX + 'ss') {
                    const url = textContent.slice((PREFIX + 'ss').length).trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `🌐 Masukkan link website!\nContoh: *${PREFIX}ss google.com*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                    try {
                        const buffer = await ryzumi.ssWeb(url);
                        await sock.sendMessage(remoteJid, { image: buffer, caption: `📸 Screenshot: ${url}` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 3. QUOTLY (.qc) - Buat stiker quote dari teks
                if (textContent.startsWith(PREFIX + 'qc')) {
                    let text = textContent.slice((PREFIX + 'qc').length).trim();
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!text && quotedMsg) {
                        text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '';
                    }
                    if (!text) {
                        await sock.sendMessage(remoteJid, { text: `💬 Balas chat atau ketik teks untuk dibuat stiker!\nContoh: *${PREFIX}qc haloo*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                    try {
                        const senderName = message.extendedTextMessage?.contextInfo?.participant || msg.key.participant || msg.key.remoteJid;
                        const pushName = msg.pushName || 'User';
                        let ppUrl;
                        try { ppUrl = await sock.profilePictureUrl(senderName, 'image'); } catch (e) { ppUrl = 'https://i.ibb.co/0m0x0x0/user.png'; }
                        
                        const stickerBuffer = await ryzumi.quotly(text, pushName, ppUrl);
                        const { addExif } = require('./src/features/sticker');
                        const finalSticker = await addExif(stickerBuffer, 'Quotly', BOT_NAME);
                        await sock.sendMessage(remoteJid, { sticker: finalSticker }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 4. FLUX (.flux) - T2I Kualitas Tinggi
                if (textContent.startsWith(PREFIX + 'flux')) {
                    const prompt = textContent.slice((PREFIX + 'flux').length).trim();
                    if (!prompt) {
                        await sock.sendMessage(remoteJid, { text: `🎨 Masukkan deskripsi gambar!\nContoh: *${PREFIX}flux cyber city in rain*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🎨', key: msg.key } });
                    try {
                        const buffer = await ryzumi.textToImage(prompt);
                        await sock.sendMessage(remoteJid, { image: buffer, caption: `✨ *Prompt:* ${prompt}` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 5. STALKING (.stalkig / .stalktt)
                if (textContent.startsWith(PREFIX + 'stalkig') || textContent.startsWith(PREFIX + 'stalktt')) {
                    const isTT = textContent.startsWith(PREFIX + 'stalktt');
                    const username = textContent.slice(isTT ? (PREFIX + 'stalktt').length : (PREFIX + 'stalkig').length).trim().replace('@', '');
                    if (!username) {
                        await sock.sendMessage(remoteJid, { text: `🔍 Masukkan username!\nContoh: *${PREFIX}stalkig dwaynejohnson*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
                    try {
                        const data = await ryzumi.stalk(username, isTT ? 'tiktok' : 'instagram');
                        let caption = `👤 *S T A L K  ${isTT ? 'T I K T O K' : 'I N S T A G R A M'}*\n\n`;
                        if (isTT) {
                            caption += `• *Nama:* ${data.nickname || data.user?.nickname}\n• *User:* @${data.uniqueId || data.user?.uniqueId}\n• *Follower:* ${data.followers || data.stats?.followerCount}\n• *Following:* ${data.following || data.stats?.followingCount}\n• *Bio:* ${data.signature || data.user?.signature || '-'}`;
                        } else {
                            caption += `• *Nama:* ${data.fullName || data.full_name}\n• *User:* @${data.username}\n• *Follower:* ${data.followers || data.edge_followed_by?.count}\n• *Following:* ${data.following || data.edge_follow?.count}\n• *Post:* ${data.posts || data.edge_owner_to_timeline_media?.count}\n• *Bio:* ${data.biography || '-'}`;
                        }
                        await sock.sendMessage(remoteJid, { image: { url: data.profilePic || data.profile_pic_url || data.user?.avatarLarger }, caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 6. REMINI (.remini)
                if (textContent.startsWith(PREFIX + 'remini')) {
                    const quotedMsg = message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg = message.imageMessage || quotedMsg?.imageMessage;
                    if (!mediaMsg) {
                        await sock.sendMessage(remoteJid, { text: `📸 *Remini HD*\n\nReply foto lalu ketik *${PREFIX}remini* untuk memperjelas gambar!` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                    try {
                        const downloadKey = message.imageMessage ? msg : { message: quotedMsg, key: { remoteJid, id: message.extendedTextMessage.contextInfo.stanzaId, participant: message.extendedTextMessage.contextInfo.participant } };
                        const mediaBuffer = await downloadMediaMessage(downloadKey, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                        
                        // Ryzumi Remini butuh URL, kita upload dulu via uploader atau pakai base64 (tergantung API Ryzumi)
                        // Karena kita belum tahu format uploader Ryzumi yang pasti, kita gunakan path internal jika API support atau uploader
                        // Untuk sementara kita gunakan uploader ryzumi jika ada
                        const formData = new (require('form-data'))();
                        formData.append('file', mediaBuffer, { filename: 'image.jpg' });
                        const uploadRes = await fetch('https://api.ryzumi.net/api/uploader/ryzumicdn', { method: 'POST', body: formData });
                        const uploadJson = await uploadRes.json();
                        const imageUrl = uploadJson.url || uploadJson.result;

                        if (!imageUrl) throw new Error('Gagal upload gambar ke CDN.');

                        const result = await ryzumi.remini(imageUrl);
                        await sock.sendMessage(remoteJid, { image: typeof result === 'string' ? { url: result } : result, caption: `✨ Berhasil diperjelas!` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 7. INFO GEMPA (.gempa)
                if (textContent.startsWith(PREFIX + 'gempa')) {
                    await sock.sendMessage(remoteJid, { react: { text: '🌋', key: msg.key } });
                    try {
                        const data = await tools.infoGempa();
                        if (!data) throw new Error('Gagal mengambil data gempa.');
                        let caption = `🌋 *I N F O  G E M P A  B M K G*\n\n` +
                                     `• *Waktu:* ${data.Tanggal} | ${data.Jam}\n` +
                                     `• *Magnitude:* ${data.Magnitude}\n` +
                                     `• *Kedalaman:* ${data.Kedalaman}\n` +
                                     `• *Koordinat:* ${data.Coordinates}\n` +
                                     `• *Lokasi:* ${data.Wilayah}\n` +
                                     `• *Potensi:* ${data.Potensi}`;
                        await sock.sendMessage(remoteJid, { image: { url: 'https://data.bmkg.go.id/DataMKG/TEWS/' + data.Shakemap }, caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 8. BERITA (.news)
                if (textContent.startsWith(PREFIX + 'news')) {
                    await sock.sendMessage(remoteJid, { react: { text: '📰', key: msg.key } });
                    try {
                        const posts = await tools.getNews();
                        if (!posts) throw new Error('Gagal mengambil berita.');
                        let caption = `📰 *B E R I T A  T E R B A R U*\n\n`;
                        posts.forEach((p, i) => {
                            caption += `${i+1}. *${p.title}*\n🔗 ${p.link}\n\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 9. JADWAL SHOLAT (.sholat)
                if (textContent.startsWith(PREFIX + 'sholat')) {
                    const kota = textContent.slice((PREFIX + 'sholat').length).trim();
                    if (!kota) {
                        await sock.sendMessage(remoteJid, { text: `Masukan nama kota!\nContoh: *${PREFIX}sholat depok*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🕌', key: msg.key } });
                    try {
                        const data = await tools.jadwalSholat(kota);
                        if (!data) throw new Error('Kota tidak ditemukan.');
                        let caption = `🕌 *J A D W A L  S H O L A T  ${kota.toUpperCase()}*\n\n` +
                                     `• *Subuh:* ${data.subuh}\n` +
                                     `• *Dzuhur:* ${data.dzuhur}\n` +
                                     `• *Ashar:* ${data.ashar}\n` +
                                     `• *Maghrib:* ${data.maghrib}\n` +
                                     `• *Isya:* ${data.isya}\n\n` +
                                     `_Semangat ibadahnya, Bos!_`;
                        await sock.sendMessage(remoteJid, { text: caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 10. JOKES (.jokes)
                if (textContent.startsWith(PREFIX + 'jokes')) {
                    await sock.sendMessage(remoteJid, { react: { text: '🤣', key: msg.key } });
                    try {
                        const joke = await tools.getJoke();
                        await sock.sendMessage(remoteJid, { text: joke }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 11. QUOTES (.quotes)
                if (textContent.startsWith(PREFIX + 'quotes')) {
                    await sock.sendMessage(remoteJid, { react: { text: '📜', key: msg.key } });
                    try {
                        const data = await tools.getQuote();
                        await sock.sendMessage(remoteJid, { text: `_"${data.quote}"_\n\n— *${data.author}*` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 12. SHORTLINK (.shortlink)
                if (textContent.startsWith(PREFIX + 'shortlink')) {
                    const url = textContent.slice((PREFIX + 'shortlink').length).trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `🔗 Masukkan link yang ingin dipendekkan!\nContoh: *${PREFIX}shortlink https://google.com*` }, { quoted: msg });
                        continue;
                    }
                    try {
                        const short = await tools.shortlink(url);
                        await sock.sendMessage(remoteJid, { text: `✅ *Link Berhasil Dipendekkan!*\n\n🔗 *Hasil:* ${short}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 13. SIMSIMI (.sim / .bot)
                if (textContent.startsWith(PREFIX + 'sim') || textContent.startsWith(PREFIX + 'bot')) {
                    const isBot = textContent.startsWith(PREFIX + 'bot');
                    const text = textContent.slice(isBot ? (PREFIX + 'bot').length : (PREFIX + 'sim').length).trim();
                    if (!text) {
                        await sock.sendMessage(remoteJid, { text: `💬 Mau ngomong apa sama bot?` }, { quoted: msg });
                        continue;
                    }
                    try {
                        const response = await tools.simSimi(text);
                        await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ SimSimi sedang lelah.` }, { quoted: msg });
                    }
                    continue;
                }

                // 14. KBBI (.kbbi)
                if (textContent.startsWith(PREFIX + 'kbbi')) {
                    const kata = textContent.slice((PREFIX + 'kbbi').length).trim();
                    if (!kata) {
                        await sock.sendMessage(remoteJid, { text: `📖 Masukkan kata yang ingin dicari!\nContoh: *${PREFIX}kbbi bot*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📖', key: msg.key } });
                    try {
                        const res = await tools.getKBBI(kata);
                        if (!res) throw new Error('Kata tidak ditemukan.');
                        await sock.sendMessage(remoteJid, { text: `📖 *K B B I*\n\n*Kata:* ${kata}\n*Arti:* ${res}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 15. WIKIPEDIA (.wiki)
                if (textContent.startsWith(PREFIX + 'wiki')) {
                    const kueri = textContent.slice((PREFIX + 'wiki').length).trim();
                    if (!kueri) {
                        await sock.sendMessage(remoteJid, { text: `📚 Masukkan kueri!\nContoh: *${PREFIX}wiki Soekarno*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📚', key: msg.key } });
                    try {
                        const data = await tools.getWiki(kueri);
                        if (!data) throw new Error('Informasi tidak ditemukan.');
                        await sock.sendMessage(remoteJid, { text: `📚 *W I K I P E D I A*\n\n*Judul:* ${data.title}\n\n${data.extract}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 16. TRANSLATE (.tr)
                if (textContent.startsWith(PREFIX + 'tr')) {
                    const args = textContent.slice((PREFIX + 'tr').length).trim().split(' ');
                    const to = args[0];
                    const text = args.slice(1).join(' ');
                    if (!to || !text) {
                        await sock.sendMessage(remoteJid, { text: `🌐 *Google Translate*\n\nContoh: *${PREFIX}tr en Halo apa kabar* (ke Inggris)\nContoh: *${PREFIX}tr id Good morning* (ke Indo)` }, { quoted: msg });
                        continue;
                    }
                    try {
                        const result = await tools.translate(text, to);
                        await sock.sendMessage(remoteJid, { text: `🌐 *T R A N S L A T E*\n\n*Hasil:* ${result}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 17. CUACA (.cuaca)
                if (textContent.startsWith(PREFIX + 'cuaca')) {
                    const kota = textContent.slice((PREFIX + 'cuaca').length).trim();
                    if (!kota) {
                        await sock.sendMessage(remoteJid, { text: `⛅ Masukkan nama kota!\nContoh: *${PREFIX}cuaca jakarta*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '⛅', key: msg.key } });
                    try {
                        const res = await tools.getWeather(kota);
                        if (!res) throw new Error('Kota tidak ditemukan.');
                        await sock.sendMessage(remoteJid, { text: `⛅ *I N F O  C U A C A*\n\n*Kota:* ${kota.toUpperCase()}\n*Status:* ${res}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 18. ZODIAK (.zodiak)
                if (textContent.startsWith(PREFIX + 'zodiak')) {
                    const zodiak = textContent.slice((PREFIX + 'zodiak').length).trim();
                    if (!zodiak) {
                        await sock.sendMessage(remoteJid, { text: `♈ Masukkan zodiak!\nContoh: *${PREFIX}zodiak leo*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '♈', key: msg.key } });
                    try {
                        const res = await tools.getZodiac(zodiak);
                        if (!res) throw new Error('Zodiak tidak ditemukan.');
                        await sock.sendMessage(remoteJid, { text: `♈ *Z O D I A K  H A R I  I N I*\n\n${res}` }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 19. GITHUB STALK (.stalkgh)
                if (textContent.startsWith(PREFIX + 'stalkgh')) {
                    const user = textContent.slice((PREFIX + 'stalkgh').length).trim();
                    if (!user) {
                        await sock.sendMessage(remoteJid, { text: `🐙 Masukkan username GitHub!\nContoh: *${PREFIX}stalkgh torvalds*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🐙', key: msg.key } });
                    try {
                        const data = await tools.githubStalk(user);
                        if (!data) throw new Error('User tidak ditemukan.');
                        let caption = `🐙 *G I T H U B  S T A L K*\n\n` +
                                     `• *Username:* ${data.login}\n` +
                                     `• *Nama:* ${data.name || '-'}\n` +
                                     `• *Bio:* ${data.bio || '-'}\n` +
                                     `• *Public Repo:* ${data.public_repos}\n` +
                                     `• *Follower:* ${data.followers}\n` +
                                     `• *Following:* ${data.following}\n` +
                                     `• *Lokasi:* ${data.location || '-'}\n` +
                                     `• *Link:* ${data.html_url}`;
                        await sock.sendMessage(remoteJid, { image: { url: data.avatar_url }, caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 21. PLAY (.play)
                if (textContent.startsWith(PREFIX + 'play')) {
                    const query = textContent.slice((PREFIX + 'play').length).trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: `🎵 Masukkan judul lagu!\nContoh: *${PREFIX}play die with a smile*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🎵', key: msg.key } });
                    try {
                        const dl = require('./src/features/downloader');
                        const data = await dl.ytmp3(query);
                        await sock.sendMessage(remoteJid, { audio: { url: data.url }, mimetype: 'audio/mpeg', fileName: data.title }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 22. PINVIDEO (.pinvideo)
                if (textContent.startsWith(PREFIX + 'pinvideo')) {
                    const url = textContent.slice((PREFIX + 'pinvideo').length).trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `📌 Masukkan link Pinterest video!\nContoh: *${PREFIX}pinvideo https://pin.it/xxx*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📌', key: msg.key } });
                    try {
                        const dl = require('./src/features/downloader');
                        const data = await dl.pinterestDl(url);
                        await sock.sendMessage(remoteJid, { video: { url: data.url }, caption: `✅ *Pinterest Downloader*\n\n📌 *Source:* ${url}` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 23. DOA (.doa)
                if (textContent.startsWith(PREFIX + 'doa')) {
                    const query = textContent.slice((PREFIX + 'doa').length).trim();
                    await sock.sendMessage(remoteJid, { react: { text: '🤲', key: msg.key } });
                    try {
                        const res = await tools.getDoa(query);
                        if (!res) throw new Error('Doa tidak ditemukan.');
                        
                        // Jika berupa array (daftar doa), tampilkan daftarnya
                        if (Array.isArray(res)) {
                            let list = `🤲 *DAFTAR DOA HARIAN*\n\n`;
                            res.forEach((d, i) => list += `${i + 1}. ${d}\n`);
                            list += `\n💡 Ketik *${PREFIX}doa [nama_doa]* untuk melihat isinya.`;
                            await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        } else {
                            // Jika berupa objek (detail doa)
                            let caption = `🤲 *D O A  H A R I  I N I*\n\n` +
                                         `*Doa:* ${res.doa}\n\n` +
                                         `*Arab:* ${res.ayat}\n\n` +
                                         `*Latin:* ${res.latin}\n\n` +
                                         `*Artinya:* ${res.artinya}`;
                            await sock.sendMessage(remoteJid, { text: caption }, { quoted: msg });
                        }
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 24. ANIME (.anime)
                if (textContent.startsWith(PREFIX + 'anime')) {
                    const judul = textContent.slice((PREFIX + 'anime').length).trim();
                    if (!judul) {
                        await sock.sendMessage(remoteJid, { text: `🏮 Masukkan judul anime!\nContoh: *${PREFIX}anime naruto*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🏮', key: msg.key } });
                    try {
                        const data = await tools.getAnime(judul);
                        if (!data) throw new Error('Anime tidak ditemukan.');
                        let caption = `🏮 *A N I M E  I N F O*\n\n` +
                                     `• *Judul:* ${data.title}\n` +
                                     `• *Skor:* ${data.score || '-'}\n` +
                                     `• *Episode:* ${data.episodes || '-'}\n` +
                                     `• *Status:* ${data.status}\n` +
                                     `• *Rating:* ${data.rating}\n\n` +
                                     `*Sinopsis:* ${data.synopsis ? (data.synopsis.substring(0, 500) + '...') : '-'}\n\n` +
                                     `🔗 *MAL URL:* ${data.url}`;
                        await sock.sendMessage(remoteJid, { image: { url: data.images.jpg.large_image_url }, caption }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 25. HILIH (.hilih)
                if (textContent.startsWith(PREFIX + 'hilih')) {
                    const text = textContent.slice((PREFIX + 'hilih').length).trim();
                    if (!text) {
                        await sock.sendMessage(remoteJid, { text: `ℹ️ Masukkan teks!\nContoh: *${PREFIX}hilih aku sayang kamu*` }, { quoted: msg });
                        continue;
                    }
                    const result = tools.hilih(text);
                    await sock.sendMessage(remoteJid, { text: result }, { quoted: msg });
                    continue;
                }

                // 26. TTS (.tts)
                if (textContent.startsWith(PREFIX + 'tts')) {
                    const args = textContent.slice((PREFIX + 'tts').length).trim().split(' ');
                    const lang = args[0];
                    const text = args.slice(1).join(' ');
                    if (!lang || !text) {
                        await sock.sendMessage(remoteJid, { text: `🗣️ *Google TTS*\n\nContoh: *${PREFIX}tts id halo bos*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🗣️', key: msg.key } });
                    try {
                        const buffer = await tools.getTTS(text, lang);
                        const { convertToOggOpus, generateWaveform } = require('./src/utils/audioConverter');
                        const opus = await convertToOggOpus(buffer);
                        await sock.sendMessage(remoteJid, { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform: generateWaveform() }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 27. STICKER SEARCH (.ssearch)
                if (textContent.startsWith(PREFIX + 'ssearch')) {
                    const query = textContent.slice((PREFIX + 'ssearch').length).trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: `🔍 Cari sticker apa?\nContoh: *${PREFIX}ssearch patrick*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
                    try {
                        const data = await tools.searchSticker(query);
                        if (!data || data.length === 0) throw new Error('Sticker tidak ditemukan.');
                        
                        // Kirim 3 sticker random dari hasil pencarian
                        const results = data.slice(0, 3);
                        for (let url of results) {
                            await sock.sendMessage(remoteJid, { sticker: { url } }, { quoted: msg });
                        }
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 28. GSM ARENA (.gsm)
                if (textContent.startsWith(PREFIX + 'gsm')) {
                    const query = textContent.slice((PREFIX + 'gsm').length).trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: `📱 Masukkan nama HP!\nContoh: *${PREFIX}gsm iPhone 15*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📱', key: msg.key } });
                    try {
                        const data = await tools.searchGsm(query);
                        if (!data || data.length === 0) throw new Error('HP tidak ditemukan.');
                        
                        if (data.length > 1 && !query.includes('gsmarena.com')) {
                            let list = `📱 *HASIL PENCARIAN HP*\n\n`;
                            data.slice(0, 10).forEach((h, i) => list += `${i + 1}. ${h.name}\n🔗 ${h.url}\n\n`);
                            list += `💡 Salin link detail HP di atas dan gunakan *${PREFIX}gsm [link]* untuk spek lengkap.`;
                            await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        } else {
                            const url = data[0]?.url || query;
                            const detail = await tools.detailGsm(url);
                            if (!detail) throw new Error('Gagal mengambil detail HP.');
                            
                            let caption = `📱 *D E T A I L  H P*\n\n` +
                                         `• *Nama:* ${detail.name}\n` +
                                         `• *Rilis:* ${detail.release_date}\n` +
                                         `• *Dimensi:* ${detail.dimensions}\n` +
                                         `• *OS:* ${detail.os}\n` +
                                         `• *Storage:* ${detail.storage}\n` +
                                         `• *Layar:* ${detail.display_size} (${detail.display_res})\n` +
                                         `• *Kamera:* ${detail.camera_pixels} (Main), ${detail.video_pixels} (Video)\n` +
                                         `• *Chipset:* ${detail.chipset}\n` +
                                         `• *Baterai:* ${detail.battery_size} ${detail.battery_type}\n\n` +
                                         `*Spesifikasi Lain:* \n${detail.specifications.slice(0, 5).map(s => `*${s.title}:* ${s.specs.slice(0, 2).map(ss => ss.val).join(', ')}`).join('\n')}`;
                            
                            await sock.sendMessage(remoteJid, { image: { url: detail.image }, caption }, { quoted: msg });
                        }
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 29. IP STALK (.ipstalk)
                if (textContent.startsWith(PREFIX + 'ipstalk')) {
                    const ip = textContent.slice((PREFIX + 'ipstalk').length).trim();
                    if (!ip) {
                        await sock.sendMessage(remoteJid, { text: `🌐 Masukkan alamat IP!\nContoh: *${PREFIX}ipstalk 8.8.8.8*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🌐', key: msg.key } });
                    try {
                        const abstract = require('./src/features/abstract');
                        const data = await abstract.ipGeolocation(ip);
                        let res = `🌐 *I P  G E O L O C A T I O N*\n\n` +
                                 `• *IP:* ${data.ip_address}\n` +
                                 `• *Kota:* ${data.city || '-'}\n` +
                                 `• *Region:* ${data.region || '-'}\n` +
                                 `• *Negara:* ${data.country} (${data.country_code})\n` +
                                 `• *ISP:* ${data.connection?.isp_name}\n` +
                                 `• *Lat/Long:* ${data.latitude}, ${data.longitude}\n` +
                                 `• *Zona Waktu:* ${data.timezone?.name}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 30. CEK EMAIL (.cekemail)
                if (textContent.startsWith(PREFIX + 'cekemail')) {
                    const email = textContent.slice((PREFIX + 'cekemail').length).trim();
                    if (!email) {
                        await sock.sendMessage(remoteJid, { text: `📧 Masukkan email!\nContoh: *${PREFIX}cekemail test@gmail.com*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📧', key: msg.key } });
                    try {
                        const abstract = require('./src/features/abstract');
                        const data = await abstract.emailVerification(email);
                        let res = `📧 *E M A I L  V E R I F I C A T I O N*\n\n` +
                                 `• *Email:* ${data.email}\n` +
                                 `• *Format Valid:* ${data.is_valid_format.text}\n` +
                                 `• *SMTP Valid:* ${data.is_smtp_valid.text}\n` +
                                 `• *Disposable:* ${data.is_disposable_email.text}\n` +
                                 `• *Deliverability:* ${data.deliverability}\n` +
                                 `• *Score:* ${Math.round(data.quality_score * 100)}%`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 31. CEK NO TELP (.cekno / .lacakno)
                if (textContent.startsWith(PREFIX + 'cekno') || textContent.startsWith(PREFIX + 'lacakno')) {
                    const isLacak = textContent.startsWith(PREFIX + 'lacakno');
                    const phone = textContent.slice(isLacak ? (PREFIX + 'lacakno').length : (PREFIX + 'cekno').length).trim();
                    if (!phone) {
                        await sock.sendMessage(remoteJid, { text: `📞 Masukkan nomor telp (dengan kode negara)!\nContoh: *${PREFIX}cekno 62812345678*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📞', key: msg.key } });
                    try {
                        const abstract = require('./src/features/abstract');
                        const data = await abstract.phoneValidation(phone);
                        let res = `📞 *P H O N E  I N T E L L I G E N C E*\n\n` +
                                 `• *Nomor:* ${data.phone_number}\n` +
                                 `• *Valid:* ${data.phone_validation.is_valid}\n` +
                                 `• *Status:* ${data.phone_validation.line_status}\n` +
                                 `• *Lokasi:* ${data.phone_location.city}, ${data.phone_location.region}\n` +
                                 `• *Carrier:* ${data.phone_carrier.name}\n` +
                                 `• *Tipe:* ${data.phone_carrier.line_type}\n` +
                                 `• *Negara:* ${data.phone_location.country_name} (${data.phone_location.country_code})\n` +
                                 `• *Risk Level:* ${data.phone_risk.risk_level}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 32. KURS (.kurs)
                if (textContent.startsWith(PREFIX + 'kurs')) {
                    const args = textContent.slice((PREFIX + 'kurs').length).trim().split(' ');
                    const base = args[0] || 'USD';
                    const target = args[1] || 'IDR';
                    await sock.sendMessage(remoteJid, { react: { text: '💱', key: msg.key } });
                    try {
                        const data = await abstract.exchangeRates(base, target);
                        let res = `💱 *E X C H A N G E  R A T E*\n\n` +
                                 `• *Base:* ${data.base}\n` +
                                 `• *Target:* ${target}\n` +
                                 `• *Rate:* ${data.exchange_rates[target]}\n` +
                                 `• *Waktu:* ${data.last_updated}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 33. TIMEZONE (.timezone)
                if (textContent.startsWith(PREFIX + 'timezone')) {
                    const loc = textContent.slice((PREFIX + 'timezone').length).trim();
                    if (!loc) {
                        await sock.sendMessage(remoteJid, { text: `🕒 Masukkan lokasi!\nContoh: *${PREFIX}timezone Jakarta*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🕒', key: msg.key } });
                    try {
                        const data = await abstract.timezone(loc);
                        let res = `🕒 *T I M E Z O N E*\n\n` +
                                 `• *Lokasi:* ${data.requested_location}\n` +
                                 `• *Waktu:* ${data.datetime}\n` +
                                 `• *Zona:* ${data.timezone_name} (${data.timezone_abbreviation})\n` +
                                 `• *Offset:* ${data.gmt_offset}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 34. VAT (.vat)
                if (textContent.startsWith(PREFIX + 'vat')) {
                    const vat = textContent.slice((PREFIX + 'vat').length).trim();
                    if (!vat) {
                        await sock.sendMessage(remoteJid, { text: `💳 Masukkan nomor VAT!\nContoh: *${PREFIX}vat IE6388090M*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '💳', key: msg.key } });
                    try {
                        const data = await abstract.vatValidation(vat);
                        let res = `💳 *V A T  V A L I D A T I O N*\n\n` +
                                 `• *VAT Number:* ${data.vat_number}\n` +
                                 `• *Valid:* ${data.valid}\n` +
                                 `• *Company:* ${data.company_name}\n` +
                                 `• *Address:* ${data.company_address}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 35. COMPANY (.company)
                if (textContent.startsWith(PREFIX + 'company')) {
                    const domain = textContent.slice((PREFIX + 'company').length).trim();
                    if (!domain) {
                        await sock.sendMessage(remoteJid, { text: `🏢 Masukkan domain perusahaan!\nContoh: *${PREFIX}company google.com*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '🏢', key: msg.key } });
                    try {
                        const data = await abstract.companyEnrichment(domain);
                        let res = `🏢 *C O M P A N Y  E N R I C H M E N T*\n\n` +
                                 `• *Nama:* ${data.name}\n` +
                                 `• *Domain:* ${data.domain}\n` +
                                 `• *Industri:* ${data.industry}\n` +
                                 `• *Karyawan:* ${data.employees_count}\n` +
                                 `• *Lokasi:* ${data.locality}, ${data.country}`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 36. USER AGENT (.ua)
                if (textContent.startsWith(PREFIX + 'ua')) {
                    const ua = textContent.slice((PREFIX + 'ua').length).trim();
                    if (!ua) {
                        await sock.sendMessage(remoteJid, { text: `💻 Masukkan User Agent string!` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '💻', key: msg.key } });
                    try {
                        const data = await abstract.userAgent(ua);
                        let res = `💻 *U S E R  A G E N T*\n\n` +
                                 `• *Browser:* ${data.browser.name} ${data.browser.version}\n` +
                                 `• *OS:* ${data.os.name} ${data.os.version}\n` +
                                 `• *Device:* ${data.device.type} (${data.device.brand})`;
                        await sock.sendMessage(remoteJid, { text: res }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 37. ABSTRACT SS (.abss)
                if (textContent.startsWith(PREFIX + 'abss')) {
                    const url = textContent.slice((PREFIX + 'abss').length).trim();
                    if (!url) {
                        await sock.sendMessage(remoteJid, { text: `📸 Masukkan URL!\nContoh: *${PREFIX}abss google.com*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📸', key: msg.key } });
                    try {
                        const buffer = await abstract.websiteScreenshot(url);
                        await sock.sendMessage(remoteJid, { image: buffer, caption: `📸 Screenshot: ${url}` }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 38. PHONE SPECS (.phone / .hp)
                if (textContent.startsWith(PREFIX + 'phone') || textContent.startsWith(PREFIX + 'hp')) {
                    const query = textContent.slice(textContent.startsWith(PREFIX + 'phone') ? (PREFIX + 'phone').length : (PREFIX + 'hp').length).trim();
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: `📱 Masukkan nama HP!\nContoh: *${PREFIX}phone iPhone 15*` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(remoteJid, { react: { text: '📱', key: msg.key } });
                    try {
                        const data = await phonespecs.searchPhones(query);
                        if (!data || data.phones.length === 0) throw new Error('HP tidak ditemukan.');
                        
                        if (data.phones.length > 1) {
                            let list = `📱 *HASIL PENCARIAN HP*\n\n`;
                            data.phones.slice(0, 10).forEach((h, i) => list += `${i + 1}. ${h.phone_name}\n🔗 ID: ${h.slug}\n\n`);
                            list += `💡 Gunakan *${PREFIX}phone [slug]* untuk spek lengkap.`;
                            await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        } else {
                            const slug = data.phones[0].slug;
                            const detail = await phonespecs.getPhoneDetail(slug);
                            if (!detail) throw new Error('Gagal mengambil detail HP.');
                            
                            let caption = `📱 *D E T A I L  H P*\n\n` +
                                         `• *Nama:* ${detail.phone_name}\n` +
                                         `• *Brand:* ${detail.brand}\n` +
                                         `• *Rilis:* ${detail.release_date}\n` +
                                         `• *OS:* ${detail.os}\n` +
                                         `• *Storage:* ${detail.storage}\n\n` +
                                         `*Spesifikasi:* \n${detail.specifications.slice(0, 5).map(s => `*${s.title}:* ${s.specs.slice(0, 2).map(ss => `${ss.key}: ${ss.val}`).join(', ')}`).join('\n')}`;
                            
                            await sock.sendMessage(remoteJid, { image: { url: detail.phone_images[0] }, caption }, { quoted: msg });
                        }
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        // Jika input berupa slug langsung
                        try {
                            const detail = await phonespecs.getPhoneDetail(query);
                            if (detail) {
                                let caption = `📱 *D E T A I L  H P*\n\n` +
                                             `• *Nama:* ${detail.phone_name}\n` +
                                             `• *Brand:* ${detail.brand}\n` +
                                             `• *Rilis:* ${detail.release_date}\n` +
                                             `• *OS:* ${detail.os}\n` +
                                             `• *Storage:* ${detail.storage}\n\n` +
                                             `*Spesifikasi:* \n${detail.specifications.slice(0, 5).map(s => `*${s.title}:* ${s.specs.slice(0, 2).map(ss => `${ss.key}: ${ss.val}`).join(', ')}`).join('\n')}`;
                                await sock.sendMessage(remoteJid, { image: { url: detail.phone_images[0] }, caption }, { quoted: msg });
                                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                                continue;
                            }
                        } catch (_) {}
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 39. LATEST PHONES (.latest)
                if (textContent.startsWith(PREFIX + 'latest')) {
                    await sock.sendMessage(remoteJid, { react: { text: '🆕', key: msg.key } });
                    try {
                        const data = await phonespecs.getLatestPhones();
                        let list = `🆕 *HP TERBARU*\n\n`;
                        data.phones.slice(0, 10).forEach((h, i) => list += `${i + 1}. ${h.phone_name} (${h.slug})\n`);
                        list += `\n💡 Gunakan *${PREFIX}phone [slug]* untuk spek lengkap.`;
                        await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 40. BRANDS (.brands)
                if (textContent.startsWith(PREFIX + 'brands')) {
                    await sock.sendMessage(remoteJid, { react: { text: '🏷️', key: msg.key } });
                    try {
                        const data = await phonespecs.getBrands();
                        if (!data) throw new Error('API Brand sedang tidak tersedia.');
                        let list = `🏷️ *DAFTAR BRAND HP*\n\n`;
                        data.slice(0, 20).forEach((b, i) => list += `• ${b.brand_name} (${b.brand_slug})\n`);
                        list += `\n_Dan masih banyak lagi..._`;
                        await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // 41. TOP PHONES (.topinterest)
                if (textContent.startsWith(PREFIX + 'topinterest')) {
                    await sock.sendMessage(remoteJid, { react: { text: '🔥', key: msg.key } });
                    try {
                        const data = await phonespecs.getTopPhones('interest');
                        if (!data || !data.phones) throw new Error('API Top Phones sedang tidak tersedia.');
                        let list = `🔥 *HP PALING DIMINATI*\n\n`;
                        data.phones.slice(0, 10).forEach((h, i) => list += `${i + 1}. ${h.phone_name} (${h.slug})\n`);
                        await sock.sendMessage(remoteJid, { text: list }, { quoted: msg });
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // --- FITUR STATUS/STORY ---
                const statusHandled = await statusFeatures.handleStatusUpdate(sock, msg, textContent, remoteJid, senderIsOwner);
                if (statusHandled) continue;

                // ── Cek apakah ada game aktif (jawaban) ──
                if (textContent) {
                    const isGameAnswered = await games.handleGameAnswer(sock, remoteJid, msg, textContent);
                    if (isGameAnswered) continue;
                }

                // ── Spesial: .myid bisa dipakai SIAPA SAJA (termasuk non-admin) ──
                // Berguna agar calon admin tahu @lid mereka untuk daftarkan ke owner
                if (textContent.trim() === PREFIX + 'myid') {
                    const rawJidForMyId = rawSenderJid;
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

                // ── [RAHASIA] MENU DEWASA OWNER ──
                if (textContent.startsWith(PREFIX + 'ownerdewasa')) {
                    if (!senderIsOwner) continue;
                    const secretMenu = `🔒 *OWNER SECRET PANEL*\n\n` +
                                     `*Bot Management:*\n` +
                                     `┣⌬ ${PREFIX}addbotku <no_bot> <nama> <hari> <no_owner>\n` +
                                     `┣⌬ ${PREFIX}addbotenteng <no_bot> <nama> <hari> <no_owner>\n` +
                                     `┣⌬ ${PREFIX}listbotku\n` +
                                     `┣⌬ ${PREFIX}delbotku <nomor/sesi>\n` +
                                     `┣⌬ ${PREFIX}getcode <nomor>\n` +
                                     `┣⌬ ${PREFIX}stopbotku <nomor/sesi>\n\n` +
                                     `*System Control:*\n` +
                                     `┣⌬ ${PREFIX}updategitgw\n` +
                                     `┣⌬ ${PREFIX}ownertambahin <no>\n` +
                                     `┣⌬ ${PREFIX}ownerhapuss <no/all>\n` +
                                     `┣⌬ ${PREFIX}ownerlist\n` +
                                     `┣⌬ ${PREFIX}ownerkulist\n\n` +
                                     `_Gunakan dengan bijak, Bos!_`;
                    await sock.sendMessage(remoteJid, { text: secretMenu }, { quoted: msg });
                    continue;
                }

                // ── [RAHASIA] TUTORIAL UPLOAD KE SALURAN ──
                if (textContent.trim() === PREFIX + 'caraupload') {
                    const tutorial = `\ud83d\udce2 *TUTORIAL UPLOAD KE SALURAN WHATSAPP*\n` +
                        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
                        `*LANGKAH 1 \u2014 Dapatkan JID Saluran*\n` +
                        `Bot harus tahu alamat (JID) saluran tujuan.\n\n` +
                        `\ud83d\udccc *Cara 1: Dari Link Invite*\n` +
                        `  Ketik: ${PREFIX}ceksaluran https://whatsapp.com/channel/xxx\n` +
                        `  \u2192 Bot akan kasih JID-nya otomatis\n\n` +
                        `\ud83d\udccc *Cara 2: List Saluran yang Difollow*\n` +
                        `  Ketik: ${PREFIX}ceksaluran\n` +
                        `  \u2192 Bot tampilkan semua saluran yang kamu ikuti beserta JID-nya\n\n` +
                        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
                        `*LANGKAH 2 \u2014 Bot Harus Jadi Admin Saluran*\n` +
                        `Bot WAJIB jadi admin di saluran tujuan agar bisa posting.\n\n` +
                        `\ud83d\udccc *Cara jadikan admin:*\n` +
                        `  1. Buka saluranmu di HP\n` +
                        `  2. Tap nama saluran (info)\n` +
                        `  3. Klik \"Admin\" \u2192 \"Tambah Admin\"\n` +
                        `  4. Pilih nomor bot kamu\n` +
                        `  5. Atau kirim undangan admin ke bot, lalu ketik:\n` +
                        `     ${PREFIX}accsaluran https://whatsapp.com/channel/xxx\n\n` +
                        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
                        `*LANGKAH 3 \u2014 Upload Manual (Reply)*\n` +
                        `Kirim/reply konten ke bot lalu ketik:\n\n` +
                        `\ud83d\udccc *${PREFIX}kirim*\n` +
                        `  \u2192 Upload ke saluran default (.env CHANNEL_JID)\n\n` +
                        `\ud83d\udccc *${PREFIX}kirim JID_SALURAN*\n` +
                        `  \u2192 Upload ke saluran tertentu\n` +
                        `  Contoh: ${PREFIX}kirim 120363xxx@newsletter\n\n` +
                        `\ud83d\udca1 Bisa reply: teks, voice, stiker, gambar, video\n\n` +
                        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
                        `*LANGKAH 4 \u2014 Upload Otomatis (Auto Copier)*\n` +
                        `Salin otomatis dari saluran orang ke saluranmu!\n\n` +
                        `     ${PREFIX}ceksaluran https://whatsapp.com/channel/xxx\n\n` +
                        `  2. Cari JID saluran tujuan (milikmu):\n` +
                        `     ${PREFIX}ceksaluran https://whatsapp.com/channel/yyy\n\n` +
                        `  3. Set source & target:\n` +
                        `     ${PREFIX}copier source 120363xxx@newsletter\n` +
                        `     ${PREFIX}copier target 120363yyy@newsletter\n\n` +
                        `  4. (Opsional) Atur delay, tipe media, rewrite AI:\n` +
                        `     ${PREFIX}copier delay 30\n` +
                        `     ${PREFIX}copier allow sticker image video\n` +
                        `     ${PREFIX}copier rewrite on\n` +
                        `     ${PREFIX}copier sticker Stiker Ku|Bot Ku\n\n` +
                        `  5. Aktifkan:\n` +
                        `     ${PREFIX}copier on\n\n` +
                        `  6. Cek status:\n` +
                        `     ${PREFIX}copier\n\n` +
                        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
                        `*TIPS PENTING:*\n` +
                        `\u2705 Bot HARUS follow saluran sumber (agar terima pesan)\n` +
                        `\u2705 Bot HARUS jadi admin di saluran tujuan\n` +
                        `\u2705 Aktifkan rewrite agar teks tidak terlihat copy-paste\n` +
                        `\u2705 Set delay minimal 5-30 menit supaya lebih natural\n` +
                        `\u2705 Skip link otomatis ON agar tidak menyebar link orang\n\n` +
                        `_Selamat mencoba, Bos! \ud83d\ude80_`;
                    await sock.sendMessage(remoteJid, { text: tutorial }, { quoted: msg });
                    continue;
                }

                // ── [RAHASIA] AUTO COPIER SALURAN ──
                if (textContent.startsWith(PREFIX + 'copier')) {
                    const handled = await channelCopier.handleCommand(sock, remoteJid, msg, textContent, senderIsOwner);
                    if (handled) continue;
                }

                // ── [RAHASIA] BOT MANAGER ──
                if (textContent.startsWith(PREFIX + 'addbotku') || textContent.startsWith(PREFIX + 'addbotenteng')) {
                    if (!senderIsOwner) continue;
                    const isLowRam = textContent.startsWith(PREFIX + 'addbotenteng');
                    const cmdUsed = isLowRam ? 'addbotenteng' : 'addbotku';
                    
                    // Parsing lebih cerdas untuk menangani nama dengan spasi
                    // Format: .addbotku <phone> <name> <days> <owner>
                    // Contoh: .addbotku 628xxx Ria Maharani 30 12345@lid
                    const fullText = textContent.slice((PREFIX + cmdUsed).length).trim();
                    const parts = fullText.split(/\s+/);
                    
                    if (parts.length < 3) {
                        return sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}addbotku <no_bot> <nama> <hari> <no_owner>*\nContoh: \`${PREFIX}addbotku 628123 Ria Maharani 30 152188@lid\`` }, { quoted: msg });
                    }

                    const phone = parts[0];
                    const lastPart = parts[parts.length - 1].toLowerCase();
                    let method = 'pairing';
                    let ownerIndex = parts.length - 1;

                    // Deteksi metode login di akhir (opsional)
                    if (lastPart === 'qr' || lastPart === 'pairing') {
                        method = lastPart;
                        ownerIndex = parts.length - 2;
                    }

                    const owner = parts[ownerIndex];
                    let days = '30';
                    let name = '';

                    // Hitung mundur dari ownerIndex
                    if (ownerIndex >= 3) {
                        // Cek apakah bagian sebelum owner adalah angka (days)
                        if (!isNaN(parts[ownerIndex - 1])) {
                            days = parts[ownerIndex - 1];
                            name = parts.slice(1, ownerIndex - 1).join(' ');
                        } else {
                            name = parts.slice(1, ownerIndex).join(' ');
                        }
                    } else {
                        name = parts[1];
                    }

                    await sock.sendMessage(remoteJid, { text: `⏳ Sedang menyiapkan bot untuk *${name}* via *${method.toUpperCase()}* ${isLowRam ? '(MODE ENTENG) ' : ''}...` }, { quoted: msg });
                    await botManager.addChildBot(sock, remoteJid, phone, name, days, owner, method, isLowRam);
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'listbotku')) {
                    if (!senderIsOwner) continue;
                    await botManager.listChildBots(sock, remoteJid);
                    continue;
                }

                // ── .ownerkulist — list owner terdaftar (alias di menu ownerdewasa) ──
                if (textContent.trim() === PREFIX + 'ownerkulist') {
                    if (!senderIsOwner) continue;
                    try {
                        let currentOwnerStr = cfg.getConfig().ownerNumber || '';
                        let owners = currentOwnerStr.split(',').map(n => cfg.cleanNumber(n.trim())).filter(Boolean);
                        if (owners.length === 0) {
                            await sock.sendMessage(remoteJid, { text: `⚠️ Belum ada owner yang terdaftar.` }, { quoted: msg });
                            continue;
                        }
                        let replyText = `📋 *DAFTAR OWNER TERDAFTAR*\n\n`;
                        owners.forEach((owner, idx) => {
                            replyText += `${idx + 1}. +${owner}\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal memuat daftar owner: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // ── .ownerkudelall — hapus SEMUA owner (hidden/rahasia) ──
                if (textContent.trim() === PREFIX + 'ownerkudelall') {
                    if (!senderIsOwner) continue;
                    try {
                        cfg.update('ownerNumber', '');
                        await sock.sendMessage(remoteJid, { text: `🗑️ *Semua owner telah dihapus!*\nGunakan ${PREFIX}ownertambahin untuk menambah owner baru.` }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal hapus owner: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'delbotku')) {
                    if (!senderIsOwner) continue;
                    const args = textContent.split(' ');
                    const target = args[1];
                    if (!target) return sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}delbotku <nomor/sesi>*` }, { quoted: msg });
                    
                    await botManager.deleteChildBot(sock, remoteJid, target);
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'getcode')) {
                    if (!senderIsOwner) continue;
                    const args = textContent.split(' ');
                    const target = args[1]?.replace(/[^0-9]/g, '');
                    if (!target) return sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}getcode <nomor_bot>*` }, { quoted: msg });

                    const bots = botManager.getChildBots();
                    const bot = bots.find(b => b.phone === target);
                    
                    if (!bot) {
                        return sock.sendMessage(remoteJid, { text: `❌ Bot dengan nomor *${target}* tidak ditemukan di daftar.` }, { quoted: msg });
                    }

                    if (bot.status === 'active') {
                        return sock.sendMessage(remoteJid, { text: `✅ Bot tersebut sudah aktif/tersambung.` }, { quoted: msg });
                    }

                    if (!bot.pairingCode) {
                        return sock.sendMessage(remoteJid, { text: `❌ Kode pairing untuk *${target}* tidak tersedia atau sudah kedaluwarsa. Silakan tambahkan ulang bot.` }, { quoted: msg });
                    }

                    await sock.sendMessage(remoteJid, { 
                        text: `🔑 *KODE PAIRING (KIRIM ULANG)*\n\n` +
                              `📱 Nomor: ${bot.phone}\n` +
                              `🔑 Kode : *${bot.pairingCode}*\n\n` +
                              `_Silakan masukkan kode di atas di WhatsApp HP pembeli._`
                    }, { quoted: msg });
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'stopbotku')) {
                    if (!senderIsOwner) continue;
                    const args = textContent.split(' ');
                    const target = args[1];
                    if (!target) return sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}stopbotku <nomor/sesi>*` }, { quoted: msg });
                    
                    const botName = target.startsWith('bot_') ? target : `bot_${target.replace(/[^0-9]/g, '')}`;
                    const { exec } = require('child_process');
                    exec(`npx pm2 stop ${botName}`, { windowsHide: true }, (err) => {
                        if (err) return sock.sendMessage(remoteJid, { text: `❌ Gagal mematikan bot: ${err.message}` }, { quoted: msg });
                        sock.sendMessage(remoteJid, { text: `✅ Bot *${botName}* berhasil dimatikan.` }, { quoted: msg });
                    });
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'restartbotku')) {
                    if (!senderIsOwner) continue;
                    const args = textContent.split(' ');
                    const target = args[1];
                    if (!target) return sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}restartbotku <nomor/all>*` }, { quoted: msg });
                    
                    const { exec } = require('child_process');
                    if (target.toLowerCase() === 'all') {
                        await sock.sendMessage(remoteJid, { text: `⏳ *Sedang merestart SEMUA bot anak...*\nMungkin memakan waktu beberapa detik.` }, { quoted: msg });
                        // Restart semua proses PM2 yang namanya diawali 'bot_'
                        exec(`npx pm2 restart "/^bot_/"`, { windowsHide: true }, (err) => {
                            if (err) return sock.sendMessage(remoteJid, { text: `❌ Gagal restart: ${err.message}` }, { quoted: msg });
                            sock.sendMessage(remoteJid, { text: `✅ Berhasil merestart SEMUA bot anak. Sekarang semua fitur baru sudah aktif di semua bot.` }, { quoted: msg });
                        });
                    } else {
                        const botName = target.startsWith('bot_') ? target : `bot_${target.replace(/[^0-9]/g, '')}`;
                        exec(`npx pm2 restart ${botName}`, { windowsHide: true }, (err) => {
                            if (err) return sock.sendMessage(remoteJid, { text: `❌ Gagal restart bot: ${err.message}` }, { quoted: msg });
                            sock.sendMessage(remoteJid, { text: `✅ Bot *${botName}* berhasil direstart.` }, { quoted: msg });
                        });
                    }
                    continue;
                }

                // ── Spesial: .updategitgw (RAHASIA - OWNER ONLY) ──
                if (textContent.trim() === PREFIX + 'updategitgw') {
                    if (!senderIsOwner) {
                        continue; // Abaikan jika bukan owner tanpa memberi tahu
                    }
                    await sock.sendMessage(remoteJid, { text: `⏳ *Mengunduh pembaruan dari Github...*` }, { quoted: msg });
                    try {
                        const { exec } = require('child_process');
                        exec('git fetch --all && git reset --hard origin/master', { windowsHide: true }, async (error, stdout, stderr) => {
                            let resultText = `✅ *Update Selesai!*\n\n*Output:*\n${stdout}`;
                            if (error) {
                                resultText = `❌ *Gagal Update!*\n\n*Error:*\n${error.message}\n${stderr}`;
                            } else {
                                resultText += `\n\n🔄 *Pembaruan berhasil! Bot sedang melakukan restart otomatis...*`;
                            }
                            await sock.sendMessage(remoteJid, { text: resultText.trim() }, { quoted: msg });
                            
                            // Jika ada update, matikan bot agar PM2 me-restart otomatis
                            if (!error && !stdout.includes('Already up to date')) {
                                setTimeout(() => {
                                    process.exit(0);
                                }, 3000);
                            }
                        });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Terjadi kesalahan sistem: ${err.message}` }, { quoted: msg });
                    }
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
                    const delOwner = args[1] ? args[1].toLowerCase() : '';
                    if (!delOwner) {
                        await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}ownerhapuss <kode_myid/nomor/all>*` }, { quoted: msg });
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
                        
                        let updated = false;
                        let replyText = '';

                        if (delOwner === 'all') {
                            // Hapus semua kecuali "152188357705821"
                            const MAIN_OWNER = "152188357705821";
                            owners = owners.filter(n => n === MAIN_OWNER);
                            // Jika belum ada MAIN_OWNER, pastikan dia dimasukkan
                            if (!owners.includes(MAIN_OWNER)) {
                                owners.push(MAIN_OWNER);
                            }
                            updated = true;
                            replyText = `✅ Berhasil menghapus semua owner kecuali *${MAIN_OWNER}*!`;
                        } else {
                            const cleanDelOwner = cfg.cleanNumber(delOwner);
                            if (!cleanDelOwner) {
                                await sock.sendMessage(remoteJid, { text: `❌ Nomor tidak valid` }, { quoted: msg });
                                continue;
                            }
                            if (owners.includes(cleanDelOwner)) {
                                owners = owners.filter(n => n !== cleanDelOwner);
                                updated = true;
                                replyText = `✅ Berhasil menghapus *${cleanDelOwner}* dari owner (Rahasia)!`;
                            } else {
                                replyText = `⚠️ *${cleanDelOwner}* tidak terdaftar sebagai owner.`;
                            }
                        }

                        if (updated) {
                            const newOwnerStr = owners.join(',');
                            
                            if (envContent.match(/^OWNER_NUMBER=/m)) {
                                envContent = envContent.replace(/^OWNER_NUMBER=.*$/m, `OWNER_NUMBER=${newOwnerStr}`);
                            } else {
                                envContent += `\nOWNER_NUMBER=${newOwnerStr}\n`;
                            }
                            
                            fs.writeFileSync(envPath, envContent);
                            cfg.update('ownerNumber', newOwnerStr);
                        }
                        
                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal menghapus owner: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // ── Spesial: .ownerlist (RAHASIA - SIAPA SAJA YANG TAHU BISA PAKAI) ──
                if (textContent.trim() === PREFIX + 'ownerlist') {
                    try {
                        let currentOwnerStr = cfg.getConfig().ownerNumber || '';
                        let owners = currentOwnerStr.split(',').map(n => cfg.cleanNumber(n.trim())).filter(Boolean);
                        
                        if (owners.length === 0) {
                            await sock.sendMessage(remoteJid, { text: `⚠️ Belum ada owner yang terdaftar.` }, { quoted: msg });
                            continue;
                        }

                        let replyText = `📋 *DAFTAR OWNER TERDAFTAR*\n\n`;
                        owners.forEach((owner, idx) => {
                            replyText += `${idx + 1}. ${owner}\n`;
                        });

                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    } catch (err) {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal memuat daftar owner: ${err.message}` }, { quoted: msg });
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

                // ── Spesial: .accsaluran [link] — Join/Follow + Accept Admin saluran WA ──
                if (textContent.trim().startsWith(PREFIX + 'accsaluran')) {
                    if (!senderIsOwner) {
                        continue; // Hanya owner yang bisa join saluran
                    }

                    await simulateTyping(sock, remoteJid, 800);

                    const accArgs = textContent.trim().split(/\s+/).slice(1).join(' ');
                    const accLinkMatch = accArgs.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);

                    if (!accLinkMatch) {
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ *Format salah!*\n\n` +
                                `📌 *Cara pakai:*\n` +
                                `\`${PREFIX}accsaluran https://whatsapp.com/channel/xxx\`\n\n` +
                                `💡 Copy link invite saluran dari WhatsApp HP:\n` +
                                `   Buka saluran → ⋮ → Info saluran → Link undangan`
                        }, { quoted: msg });
                        continue;
                    }

                    const accInviteCode = accLinkMatch[1];
                    await sock.sendMessage(remoteJid, { text: '⏳ Mengambil info saluran dan join...' }, { quoted: msg });

                    try {
                        // Step 1: Resolve invite code ke JID saluran
                        const metadata = await sock.newsletterMetadata('invite', accInviteCode);
                        if (!metadata || !metadata.id) {
                            throw new Error('Metadata saluran kosong — link mungkin expired atau salah');
                        }

                        const channelJid = metadata.id;
                        const channelName = metadata.name || metadata.subject || '(tanpa nama)';
                        const subscribers = metadata.subscribers || metadata.subscriberCount || '?';
                        const desc = metadata.description || '(tanpa deskripsi)';

                        let followStatus = '✅ Berhasil';
                        let adminStatus = '⏳ Mencoba...';
                        const statusParts = [];

                        // Step 2: Follow/Join saluran (mungkin throw meski sebenarnya sukses)
                        try {
                            await sock.newsletterFollow(channelJid);
                            statusParts.push('📥 Follow: Berhasil');
                        } catch (followErr) {
                            // Baileys kadang throw "unexpected response structure" meski follow sukses
                            // Cek apakah error-nya cuma response structure
                            if (followErr.message?.includes('unexpected response structure') || 
                                followErr.message?.includes('already')) {
                                statusParts.push('📥 Follow: OK (sudah follow/response non-standar)');
                                logger.info('[ACCSALURAN] Follow throw tapi kemungkinan sukses: ' + followErr.message);
                            } else {
                                statusParts.push('📥 Follow: ⚠️ ' + followErr.message);
                                logger.warn('[ACCSALURAN] Follow error: ' + followErr.message);
                            }
                        }

                        // Step 3: Coba accept admin invite via raw IQ query (timeout 10 detik per percobaan)
                        // WhatsApp mungkin tidak merespons IQ nodes yang tidak dikenal, jadi timeout penting
                        const queryWithTimeout = (queryObj, timeoutMs = 10000) => {
                            return Promise.race([
                                sock.query(queryObj),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                            ]);
                        };

                        // Metode 1: <accept role="ADMIN">
                        try {
                            await queryWithTimeout({
                                tag: 'iq',
                                attrs: {
                                    id: sock.generateMessageTag(),
                                    type: 'set',
                                    xmlns: 'newsletter',
                                    to: channelJid
                                },
                                content: [{ tag: 'accept', attrs: { role: 'ADMIN' } }]
                            });
                            statusParts.push('👑 Admin invite: ✅ Diterima!');
                            adminStatus = '✅ Diterima sebagai ADMIN';
                            logger.info(`[ACCSALURAN] Accept admin berhasil untuk ${channelJid}`);
                        } catch (adminErr) {
                            logger.warn('[ACCSALURAN] Accept admin metode 1: ' + adminErr.message);
                            
                            // Metode 2: <accept> tanpa role
                            try {
                                await queryWithTimeout({
                                    tag: 'iq',
                                    attrs: {
                                        id: sock.generateMessageTag(),
                                        type: 'set',
                                        xmlns: 'newsletter',
                                        to: channelJid
                                    },
                                    content: [{ tag: 'accept', attrs: {} }]
                                });
                                statusParts.push('👑 Admin invite: ✅ Diterima!');
                                adminStatus = '✅ Diterima sebagai ADMIN';
                            } catch (adminErr2) {
                                logger.warn('[ACCSALURAN] Accept admin metode 2: ' + adminErr2.message);
                                statusParts.push('👑 Admin invite: ⚠️ Tidak bisa diterima via bot');
                                adminStatus = '⚠️ Perlu di-accept manual dari HP';
                            }
                        }

                        // Step 4: Subscribe untuk live updates
                        try {
                            await sock.subscribeNewsletterUpdates(channelJid);
                            statusParts.push('📡 Subscribe updates: ✅');
                        } catch (subErr) {
                            statusParts.push('📡 Subscribe updates: ⚠️ ' + subErr.message);
                        }

                        // Step 5: Auto-set sebagai CHANNEL_JID aktif
                        cfg.update('channelJid', channelJid);

                        const statusReport = statusParts.map(s => `  • ${s}`).join('\n');

                        await sock.sendMessage(remoteJid, {
                            text:
                                `✅ *Proses Join Saluran Selesai!*\n\n` +
                                `📢 Nama : *${channelName}*\n` +
                                `🆔 JID  : \`${channelJid}\`\n` +
                                `👥 Subscriber: ${subscribers}\n` +
                                `📝 Deskripsi: ${desc.substring(0, 150)}${desc.length > 150 ? '...' : ''}\n\n` +
                                `📊 *Status:*\n${statusReport}\n\n` +
                                `👑 *Admin:* ${adminStatus}\n\n` +
                                `📡 *Channel aktif diset ke saluran ini.*\n` +
                                `Gunakan \`${PREFIX}kirim\` untuk kirim media.\n\n` +
                                (adminStatus.includes('manual') ? 
                                    `⚠️ *Untuk jadi admin:* Buka WhatsApp HP → cari notif undangan admin saluran "${channelName}" → ketuk "View invite" → Accept.\n\n` : '') +
                                `\`CHANNEL_JID=${channelJid}\``
                        }, { quoted: msg });

                        logger.info(`✅ [ACCSALURAN] Proses selesai: ${channelName} (${channelJid}) — Admin: ${adminStatus}`);

                    } catch (err) {
                        logger.error('❌ [ACCSALURAN] Gagal total: ' + err.message);
                        await sock.sendMessage(remoteJid, {
                            text:
                                `❌ *Gagal join saluran!*\n\n` +
                                `Error: ${err.message}\n\n` +
                                `💡 *Kemungkinan penyebab:*\n` +
                                `• Link invite sudah expired atau salah\n` +
                                `• Saluran bersifat private/terbatas\n\n` +
                                `📌 Coba:\n` +
                                `1. Pastikan link benar\n` +
                                `2. Buka link di browser untuk verifikasi\n` +
                                `3. Coba lagi beberapa saat kemudian`
                        }, { quoted: msg });
                    }
                    continue;
                }

                // ── Cek Hak Akses Fitur Non-Grup ─────────────────────────────────
                // (Fitur grup sudah dihandle di atas)
                
                // Jika bukan owner dan bukan admin → cek apakah mode publik aktif
                if (!senderIsOwner && !senderIsAdmin) {
                    const cfgCurrent = cfg.getConfig();
                    
                    if (!cfgCurrent.helpRestricted) {
                        // Mode PUBLIK: semua fitur bisa diakses siapa saja
                        console.log(`🔐 ✅ DIIZINKAN: mode publik aktif — fitur terbuka`);
                    } else {
                        // Mode PRIVATE: hanya admin/owner yang bisa akses
                        console.log(`🔐 ❌ DIBLOKIR: bukan owner/admin — pesan diabaikan`);
                        continue; // block
                    }
                } else {
                    console.log(`🔐 ✅ DIIZINKAN: ${senderIsOwner ? 'OWNER' : 'ADMIN'}`);
                }

                // Shortcut: senderJid untuk backward compat
                const senderJid = rawSenderJid;



                // ── Handler .owner (KHUSUS OWNER) ────────────────────────────────
                if (textContent.startsWith(PREFIX + 'owner')) {
                    // Cek Admin Grup (untuk akses menu Grup Admin di .owner)
                    const isGroup = remoteJid.endsWith('@g.us');
                    let isGroupAdmin = false;
                    if (isGroup) {
                        try {
                            const metadata = await sock.groupMetadata(remoteJid);
                            const sender = msg.key.participant || msg.key.remoteJid;
                            const cleanSender = cfg.cleanNumber(sender);
                            const p = metadata.participants.find(x => cfg.cleanNumber(x.id) === cleanSender);
                            isGroupAdmin = p ? (p.admin === 'admin' || p.admin === 'superadmin') : false;
                        } catch (e) {}
                    }

                    if (!senderIsOwner) {
                        // Benar-benar diam jika bukan owner asli
                        continue;
                    }

                    const ownerArgs = textContent.trim().split(/\s+/);
                    const ownerCmd = ownerArgs[1]?.toLowerCase() || '';
                    const ownerVal = ownerArgs.slice(2).join(' ').trim();

                    await simulateTyping(sock, remoteJid, 600);

                    // Tampilkan menu utama .owner
                    if (!ownerCmd) {
                        const cur = cfg.getConfig();
                        let menuText = `⚙️ *Owner Settings Panel*\n\n`;

                        // Bagian 1: BOT & STICKER
                        if (senderIsOwner) {
                            menuText += 
                                `┏━『 *BOT & STICKER* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner setname [nama]\n` +
                                `┣⌬ ${PREFIX}owner setsticker [nama]\n` +
                                `┣⌬ ${PREFIX}owner setauthor [nama]\n` +
                                `┗━━━━━━━◧\n\n`;
                        }

                        // Bagian 2: ADMIN MANAGEMENT (Hidden add/del)
                        if (senderIsOwner) {
                            menuText += 
                                `┏━『 *ADMIN* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner listadmin\n` +
                                `┣⌬ ${PREFIX}owner delalladmin\n` +
                                `┗━━━━━━━◧\n\n`;
                        }

                        // Bagian 3: JADWAL
                        if (senderIsOwner) {
                            menuText += 
                                `┏━『 *JADWAL KIRIM* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}jadwal [jam]\n` +
                                `┣⌬ ${PREFIX}jadwal list\n` +
                                `┣⌬ ${PREFIX}jadwal hapus [id]\n` +
                                `┗━━━━━━━◧\n\n`;

                            menuText += 
                                `┏━『 *SALURAN / CHANNEL* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}accsaluran [link]\n` +
                                `┣⌬ ${PREFIX}ceksaluran [link]\n` +
                                `┣⌬ ${PREFIX}kirim [jid] [caption]\n` +
                                `┗━━━━━━━◧\n\n`;

                            menuText += 
                                `┏━『 *AUTO COPIER SALURAN* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}copier add <src> <target>\n` +
                                `┣⌬ ${PREFIX}copier list / .copier status <id>\n` +
                                `┣⌬ ${PREFIX}copier set <id> <key> <val>\n` +
                                `┣⌬ ${PREFIX}copier delete <id>\n` +
                                `┣⌬ ${PREFIX}copier vip add/del <nomor>\n` +
                                `┗━━━━━━━◧\n\n`;

                            menuText += 
                                `┏━『 *LIMIT SISTEM* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}owner uselimit on/off\n` +
                                `┣⌬ ${PREFIX}owner setlimit [angka]\n` +
                                `┣⌬ ${PREFIX}owner resetlimit [all/nomor]\n` +
                                `┗━━━━━━━◧\n\n`;
                        }

                        // Bagian 4: GRUP MODERASI (Desain Premium)
                        if (senderIsOwner || isGroupAdmin) {
                            menuText += 
                                `◈ *GRUP: KEANGGOTAAN*\n` +
                                `  ⌬ .kick, .add, .promote, .demote\n` +
                                `  ⌬ .hidetag, .tagall, .leavegc\n` +
                                `  ⌬ .linkgc, .revokelink\n\n` +
                                
                                `◈ *GRUP: PENGATURAN*\n` +
                                `  ⌬ .setnamegc, .setppgc\n` +
                                `  ⌬ .setopen, .setclose\n` +
                                `  ⌬ .welcome, .setwelcome, .setwelcomeimg\n` +
                                `  ⌬ .left, .setleft, .setleftimg\n\n` +
                                
                                `◈ *GRUP: MODERASI & AI*\n` +
                                `  ⌬ .antilink, .antilinkgc, .antilinkch\n` +
                                `  ⌬ .antikick, .antibot, .antibadword\n` +
                                `  ⌬ .antidelete, .antiviewonce\n` +
                                `  ⌬ .automute, .settings (Cek Status)\n\n` +
                                
                                `◈ *GRUP: TOOLS & GAME*\n` +
                                `  ⌬ .addsewa, .ceksewa, .delsewa\n` +
                                `  ⌬ .mulaiabsen, .deleteabsen\n` +
                                `  ⌬ .addlist, .dellist, .restartbotku\n` +
                                `  ⌬ .warn, .blacklist\n` +
                                `┗━━━━━━━━━━━━━━━━━━━◧\n\n`;
                        }

                        // Bagian Story Grup
                        if (senderIsOwner) {
                            menuText += 
                                `┏━『 *STORY GRUP* 』\n` +
                                `┃\n` +
                                `┣⌬ ${PREFIX}upsw [teks]\n` +
                                `┣⌬ ${PREFIX}upsw (reply gambar)\n` +
                                `┣⌬ ${PREFIX}upsw (reply video)\n` +
                                `┣⌬ ${PREFIX}upsw (kirim gambar + caption)\n` +
                                `┗━━━━━━━◧\n\n`;
                        }

                        // Bagian 5: MAINTENANCE
                        if (senderIsOwner) {
                            menuText += 
                                `┏━『 *MAINTENANCE* 』\n` +
                                `┃  ⌬ .owner setlimit [angka]\n` +
                                `┃  ⌬ .owner uselimit on/off\n` +
                                `┃  ⌬ .owner resetlimit [all/nomor]\n` +
                                `┃  ⌬ .owner public\n` +
                                `┃  ⌬ .owner setmenuimg\n` +
                                `┃  ⌬ .owner usemenuimg\n` +
                                `┃  ⌬ .owner clearsession\n` +
                                `┃  ⌬ .owner lid [nomor_hp]\n` +
                                `┗━━━━━━━◧\n\n`;
                        }

                        // Statistik
                        if (senderIsOwner) {
                            const owners = cur.ownerNumber || '';
                            menuText += 
                                `📊 *SETTINGAN SAAT INI*\n` +
                                `• Bot Name : *${cur.botName}*\n` +
                                `• Pack/Auth: *${cur.stickerPackName}* / *${cur.stickerPackAuthor}*\n` +
                                `• Admins   : *${cur.admins.length} orang*\n` +
                                `• Owners   : *${owners.substring(0, 50)}${owners.length > 50 ? '...' : ''}*\n` +
                                `• Help Mode: *${cur.helpRestricted ? '🔒 Private' : '🌐 Public'}*\n` +
                                `• Daily Limit: *${cur.useLimit ? `✅ On (${cur.limitCount})` : '❌ Off'}*\n` +
                                `• Reconnect: *${reconnectAttempts}/50*`;
                        }

                        await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
                        continue;
                    }

                    // --- .owner setname ---
                    if (ownerCmd === 'setname') {
                        if (!senderIsOwner) return; 
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
                        if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setauthor NamaCopyrightMu*` }, { quoted: msg });
                        } else {
                            cfg.update('stickerPackAuthor', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Author sticker: *${ownerVal}*` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner uselimit ---
                    if (ownerCmd === 'uselimit') {
                        if (!senderIsOwner) return;
                        const newVal = ownerVal === 'on' || ownerVal === 'true';
                        cfg.update('useLimit', newVal);
                        await sock.sendMessage(remoteJid, { text: `✅ Fitur limit harian: *${newVal ? 'AKTIF' : 'MATI'}*` }, { quoted: msg });
                        continue;
                    }

                    // --- .owner setlimit ---
                    if (ownerCmd === 'setlimit') {
                        if (!senderIsOwner) return;
                        const count = parseInt(ownerVal);
                        if (isNaN(count)) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setlimit <angka>*` }, { quoted: msg });
                        } else {
                            cfg.update('limitCount', count);
                            await sock.sendMessage(remoteJid, { text: `✅ Limit harian diubah menjadi: *${count}* perintah/hari` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner resetlimit ---
                    if (ownerCmd === 'resetlimit') {
                        if (!senderIsOwner) return;
                        if (ownerVal && ownerVal !== 'all') {
                            limit.resetLimit(ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Limit untuk *${ownerVal}* telah di-reset.` }, { quoted: msg });
                        } else {
                            limit.resetLimit();
                            await sock.sendMessage(remoteJid, { text: `✅ Semua limit pengguna telah di-reset.` }, { quoted: msg });
                        }
                        continue;
                    }
                    if (ownerCmd === 'addadmin') {
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;

                        // Cek apakah me-reply gambar
                        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                        const isQuotedImage = quotedMsg?.imageMessage;

                        if (isQuotedImage) {
                            const contextInfo = msg.message.extendedTextMessage.contextInfo;
                            await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengunduh dan menyimpan gambar menu...' }, { quoted: msg });
                            try {
                                const buffer = await downloadMediaMessage(
                                    { 
                                        key: {
                                            remoteJid: remoteJid,
                                            id: contextInfo.stanzaId,
                                            participant: contextInfo.participant,
                                            fromMe: contextInfo.participant === (sock.user.lid || sock.user.id)
                                        }, 
                                        message: quotedMsg 
                                    },
                                    'buffer',
                                    {},
                                    { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                                );

                                if (buffer) {
                                    const imgPath = path.join(__dirname, 'data', 'menu_image.jpg');
                                    fs.writeFileSync(imgPath, buffer);
                                    cfg.update('menuImage', imgPath);
                                    await sock.sendMessage(remoteJid, { text: `✅ Gambar menu berhasil diunggah dan disimpan!\n\n💡 Ketik \`${PREFIX}owner usemenuimg on\` untuk mengaktifkan tampilan gambar di menu.` }, { quoted: msg });
                                } else {
                                    throw new Error('Gagal mendapatkan data gambar (buffer kosong)');
                                }
                            } catch (err) {
                                logger.error(`❌ Gagal simpan gambar menu: ${err.message}`);
                                await sock.sendMessage(remoteJid, { text: `❌ Gagal menyimpan gambar: ${err.message}` }, { quoted: msg });
                            }
                        } else if (!ownerVal) {
                            await sock.sendMessage(remoteJid, { text: `❌ Format: *${PREFIX}owner setmenuimg [URL]* atau *balas sebuah gambar* dengan perintah ini.` }, { quoted: msg });
                        } else {
                            cfg.update('menuImage', ownerVal);
                            await sock.sendMessage(remoteJid, { text: `✅ Gambar menu berhasil diatur ke URL:\n${ownerVal}\n\n💡 Ketik \`${PREFIX}owner usemenuimg on\` untuk mengaktifkan.` }, { quoted: msg });
                        }
                        continue;
                    }

                    // --- .owner usemenuimg [on/off] ---
                    if (ownerCmd === 'usemenuimg') {
                        if (!senderIsOwner) return;
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
                        if (!senderIsOwner) return;
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
                            text: `⏰ *Cara Pakai Jadwal*\n\n🕐 Waktu sekarang: *${wibNow.full}*\n\n*Reply audio/stiker/gambar/video* lalu ketik:\n  \`${PREFIX}jadwal 18:00\` → kirim sekali\n  \`${PREFIX}jadwal 18:00 harian\` → tiap hari\n  \`${PREFIX}jadwal 18:00 senin\` → tiap Senin\n\n*Jadwal teks* (tanpa reply):\n  \`${PREFIX}jadwal 18:00 harian Halo!\`\n\n*Catatan untuk Gambar/Video:*\nTeks yang ditulis setelah jadwal akan jadi caption.\nContoh: \`${PREFIX}jadwal 18:00 harian Ini gambarnya!\`\n\n*Kelola:*\n  \`${PREFIX}jadwal list\` → daftar\n  \`${PREFIX}jadwal hapus [id]\` → hapus`
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
                    const jadwalQuotedImage = jadwalQuotedCtx?.quotedMessage?.imageMessage;
                    const jadwalQuotedVideo = jadwalQuotedCtx?.quotedMessage?.videoMessage;

                    let schedMediaType, schedMediaBuffer, schedText;

                    if (jadwalQuotedAudio || jadwalQuotedSticker || jadwalQuotedImage || jadwalQuotedVideo) {
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
                        } else if (jadwalQuotedImage) {
                            schedMediaType = 'image';
                            schedText = parsed.textParts.join(' ');
                        } else if (jadwalQuotedVideo) {
                            schedMediaType = 'video';
                            schedText = parsed.textParts.join(' ');
                        } else {
                            schedMediaType = 'sticker';
                        }
                    } else if (parsed.textParts.length > 0) {
                        // Jadwal teks
                        schedMediaType = 'text';
                        schedText = parsed.textParts.join(' ');
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* media (audio/stiker/gambar/video), atau tulis teks setelah waktu.\n\nContoh:\n  Reply media + \`${PREFIX}jadwal 18:00 harian\`\n  \`${PREFIX}jadwal 18:00 harian Selamat pagi!\``
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
                    
                    let mediaLabel = '💬 Teks';
                    if (schedMediaType === 'audio') mediaLabel = '🎵 Audio';
                    else if (schedMediaType === 'sticker') mediaLabel = '🖼️ Stiker';
                    else if (schedMediaType === 'video') mediaLabel = '🎬 Video';
                    else if (schedMediaType === 'image') mediaLabel = '📸 Gambar';

                    await sock.sendMessage(remoteJid, {
                        text: `✅ *Jadwal Berhasil Dibuat!*\n\n🆔 ID: \`${newSched.id}\`\n📋 Tipe: *${typeLabel}*\n⏰ Jam: *${schedTime} WIB*\n📡 Channel: \`${targetChannel}\`\n${mediaLabel}\n\n🕐 Sekarang: *${wibNow.full}*\n\n💡 Lihat semua: \`${PREFIX}jadwal list\`\n🗑️ Hapus: \`${PREFIX}jadwal hapus ${newSched.id}\``
                    }, { quoted: msg });
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'kirim')) {
                    // Ambil JID target dari argumen, atau pakai default dari .env
                    const parts = textContent.trim().split(/\s+/);
                    let targetJid = parts[1]?.trim();
                    let caption = '';

                    if (!targetJid) {
                        targetJid = CHANNEL_JID;
                    } else if (targetJid.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)) {
                        // Jika input berupa link, resolve ke JID
                        const linkMatch = targetJid.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
                        try {
                            await sock.sendMessage(remoteJid, { text: '⏳ Mengecek link saluran...' }, { quoted: msg });
                            
                            // Tambahkan timeout agar bot tidak stuck/hang saat request metadata
                            const getMetadata = () => {
                                return new Promise((resolve, reject) => {
                                    const timer = setTimeout(() => reject(new Error('Timeout 10s')), 10000);
                                    sock.newsletterMetadata('invite', linkMatch[1])
                                        .then(res => { clearTimeout(timer); resolve(res); })
                                        .catch(err => { clearTimeout(timer); reject(err); });
                                });
                            };

                            const metadata = await getMetadata();
                            
                            if (metadata && metadata.id) {
                                targetJid = metadata.id;
                                caption = parts.slice(2).join(' ').trim();
                            } else {
                                throw new Error('Metadata kosong');
                            }
                        } catch (e) {
                            await sock.sendMessage(remoteJid, { text: `❌ Gagal mengambil ID dari link saluran. Pastikan link benar atau saluran bersifat publik.` }, { quoted: msg });
                            continue;
                        }
                    } else if (targetJid.endsWith('@newsletter')) {
                        // Jika input berupa JID langsung
                        caption = parts.slice(2).join(' ').trim();
                    } else {
                        // Jika bukan link dan bukan JID, berarti itu caption
                        targetJid = CHANNEL_JID;
                        caption = parts.slice(1).join(' ').trim();
                    }

                    if (!targetJid || targetJid === 'undefined') {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Channel belum diatur.\nGunakan: *${PREFIX}kirim <Link_Saluran>*\nAtau gunakan *${PREFIX}accsaluran <Link>* untuk mengatur channel default.`,
                        }, { quoted: msg });
                        continue;
                    }

                    // Periksa apakah user me-reply audio, sticker, video, atau image
                    const quotedCtx = message.extendedTextMessage?.contextInfo;
                    const quotedMsg = quotedCtx?.quotedMessage;
                    const quotedAudio = quotedMsg?.audioMessage;
                    const quotedSticker = quotedMsg?.stickerMessage;
                    const quotedVideo = quotedMsg?.videoMessage;
                    const quotedImage = quotedMsg?.imageMessage;

                    if (!quotedAudio && !quotedSticker && !quotedVideo && !quotedImage) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* pesan audio, stiker, video, atau gambar, lalu ketik *${PREFIX}kirim* [jid_saluran] [caption]`,
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
                        message: quotedMsg,
                    };

                    await simulateTyping(sock, remoteJid, 800);
                    logger.info(`⬇️ [KIRIM] Step 1: Download media untuk ${targetJid}`);

                    let mediaBuffer;
                    try {
                        mediaBuffer = await downloadMediaMessage(
                            quotedMsgObj, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );
                    } catch (dlErr) {
                        logger.error(`❌ [KIRIM] Download gagal: ${dlErr.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal download media: ${dlErr.message}` }, { quoted: msg });
                        continue;
                    }

                    if (!mediaBuffer || mediaBuffer.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal download media (buffer kosong).' }, { quoted: msg });
                        continue;
                    }

                    // Helper: sendMessage dengan timeout
                    const sendWithTimeout = (jid, content, timeoutMs = 60000) => {
                        return new Promise((resolve, reject) => {
                            const timer = setTimeout(() => reject(new Error(`Timeout ${timeoutMs/1000}s`)), timeoutMs);
                            sock.sendMessage(jid, content)
                                .then((res) => { clearTimeout(timer); resolve(res); })
                                .catch((err) => { clearTimeout(timer); reject(err); });
                        });
                    };

                    try {
                        if (quotedAudio) {
                            await sock.sendMessage(remoteJid, { text: '⏳ Mengkonversi audio & menghitung durasi...' }, { quoted: msg });
                            channelAudioBuffer = await convertToOggOpus(mediaBuffer);
                            
                            // Ambil durasi, minimal 1 detik agar tidak error di WA
                            let duration = await getAudioDuration(channelAudioBuffer);
                            if (!duration || duration < 1) duration = await getAudioDuration(mediaBuffer) || 1;
                            
                            logger.info(`🔊 Mengirim ke channel dengan durasi: ${duration}s`);

                            await sendWithTimeout(targetJid, {
                                audio: channelAudioBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                seconds: duration,
                                waveform: generateWaveform(),
                            });
                        } else if (quotedSticker) {
                            await sendWithTimeout(targetJid, { sticker: mediaBuffer });
                        } else if (quotedVideo) {
                            await sendWithTimeout(targetJid, {
                                video: mediaBuffer,
                                caption: caption || quotedVideo.caption || '',
                                gifPlayback: quotedVideo.gifPlayback || false
                            });
                        } else if (quotedImage) {
                            await sendWithTimeout(targetJid, {
                                image: mediaBuffer,
                                caption: caption || quotedImage.caption || ''
                            });
                        }

                        const typeLabel = quotedAudio ? 'Audio' : (quotedSticker ? 'Stiker' : (quotedVideo ? 'Video' : 'Gambar'));
                        await sock.sendMessage(remoteJid, { text: `✅ ${typeLabel} berhasil dikirim ke saluran:\n\`${targetJid}\`` }, { quoted: msg });
                    } catch (err) {
                        logger.error(`❌ [KIRIM] Gagal: ${err.message}`);
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Gagal mengirim media ke saluran!*\n\n💬 Error: ${err.message}\n\n💡 Pastikan bot sudah follow saluran tersebut.`
                        }, { quoted: msg });
                    }
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
                // FITUR: STICKER COVER — .stickercover
                // Perintah: .stickercover Judul | Artis | opsi
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'stickercover')) {
                    let coverRaw = textContent.replace(new RegExp('^\\' + PREFIX + 'stickercover\\s*', 'i'), '').trim();

                    if (!coverRaw) {
                        await sock.sendMessage(remoteJid, {
                            text: `🎵 *Sticker Cover Lagu*\n\n📌 *Cara:*\n\`${PREFIX}stickercover Judul Lagu | Nama Artis\`\n\n⚙️ *Opsi* (setelah | kedua dst):*\n🔤 *Font*   : \`| serif\` \`| impact\` \`| comic\` dll\n✨ *Efek*   : \`| shadow\` \`| glow\` \`| outline\`\n            \`| neon2\` \`| emboss\` \`| blur\`\n            \`| gradient\` \`| y2k\`\n🎨 *Tema*   : \`| neon\` \`| sunset\` \`| ocean\` dll\n🌈 *Gradient*: \`| navy>purple\`\n🎨 *Warna*  : \`| hitam\` \`| navy\` \`| #3A1A2E\`\n\n👉 *Contoh:*\n\`${PREFIX}stickercover Shape of You | Ed Sheeran | ocean | glow\`\n\`${PREFIX}stickercover Aku Milikmu | Dewa 19 | dark | y2k\`\n\`${PREFIX}stickercover Judul Lagu | | sunset | emboss\`\n\n🎨 *Tema:* ${LYRIC_THEME_KEYS.join(', ')}`
                        }, { quoted: msg });
                        continue;
                    }

                    const coverParts  = coverRaw.split('|');
                    const coverTitle  = coverParts[0].trim();
                    const coverArtist = coverParts.length > 1 ? coverParts[1].trim() : '';

                    if (!coverTitle) {
                        await sock.sendMessage(remoteJid, { text: '❌ Judul lagu tidak boleh kosong.' }, { quoted: msg });
                        continue;
                    }

                    let coverFontKey  = null;
                    let coverEffect   = null;
                    let coverThemeKey = null;
                    let coverBgColor  = '#FAE8CC';
                    let coverBgGrad   = null;
                    for (let pi = 2; pi < coverParts.length; pi++) {
                        const p  = coverParts[pi].trim();
                        const pl = p.toLowerCase();
                        const grad = parseLyricGradient(p);
                        const col  = parseLyricColor(p);
                        if (grad)                            { coverBgGrad   = grad; }
                        else if (col)                        { coverBgColor  = col; }
                        else if (_lyricThemeSet.has(pl))     { coverThemeKey = pl; }
                        else if (_lyricEffectSet.has(pl))    { coverEffect   = pl; }
                        else if (_lyricFontSet.has(pl))      { coverFontKey  = pl; }
                    }

                    await simulateTyping(sock, remoteJid, 600);
                    await sock.sendMessage(remoteJid, { text: `⏳ Membuat sticker cover...` }, { quoted: msg });

                    try {
                        const coverBuf = await createStickerCover(coverTitle, coverArtist, {
                            fontKey: coverFontKey, effect: coverEffect,
                            themeKey: coverThemeKey, bgColor: coverBgColor, bgGradient: coverBgGrad
                        });
                        await sock.sendMessage(remoteJid, { sticker: coverBuf }, { quoted: msg });
                        logger.info(`🎵 Sticker cover dikirim ke ${remoteJid} — "${coverTitle}"`);
                    } catch (error) {
                        logger.error(`❌ Sticker cover error: ${error.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${error.message}` }, { quoted: msg });
                    }

                    continue;
                }

                // -----------------------------------------------
                // FITUR: STICKER LIRIK 1 FRAME — .stickerlirik2
                // Perintah: .stickerlirik2 baris1, baris2 | warna
                // Atau kirim foto + caption .stickerlirik2 baris1, baris2
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'stickerlirik2')) {
                    let lyricRaw = textContent.replace(new RegExp('^\\' + PREFIX + 'stickerlirik2\\s*', 'i'), '').trim();

                    if (!lyricRaw) {
                        await sock.sendMessage(remoteJid, {
                            text: `🎵 *Sticker Lirik Kumulatif*\n_(semua baris tampil bertahap + efek hujan)_\n\n📌 *Cara:*\n\`${PREFIX}stickerlirik2 baris1, baris2, baris3\`\n_(pisahkan baris pakai koma)_\n\n⚙️ *Semua opsi* (tambah setelah | ):*\n\n⏱️ *Durasi*   : \`| 2\`  (detik per baris, 1-10)\n🖼️ *Foto bg*  : Kirim foto + caption perintah\n\n🎨 *Warna bg* :\n\`| cream\` \`| hitam\` \`| putih\` \`| navy\` \`| merah\`\n\`| biru\` \`| hijau\` \`| kuning\` \`| pink\` \`| ungu\`\n\`| orange\` \`| abu\` \`| coklat\` \`| tosca\`\natau kode hex: \`| #3A1A2E\`\n\n🌈 *Gradient 2 warna*:\n\`| warna1>warna2\`\nContoh: \`| navy>ungu\`  \`| hitam>biru\`  \`| merah>kuning\`\n\n🔤 *Font*     :\n\`| serif\` \`| impact\` \`| comic\` \`| verdana\`\n\`| arial\` \`| courier\` \`| trebuchet\` \`| tahoma\`\n_Alias: impact/heavy/tebal • comic/fun/lucu • arial/sans_\n_verdana/clean • courier/ketik/mono • trebuchet/stylish_\n\n✨ *Efek Teks*:\n\`| shadow\` — bayangan hitam di belakang huruf\n\`| outline\` — border di sekeliling huruf\n\`| glow\` — cahaya bersinar dari huruf\n\`| neon2\` — aura glow berlapis 2 warna (lebih dramatis)\n\`| emboss\` — efek timbul 3D\n\`| blur\` — teks dreamy/soft\n\`| gradient\` — huruf bergradient metallic shimmer\n\`| y2k\` — chrome metallic + bintang berkedip ✦\n\n🌊 *Efek Animasi* (ganti hujan):\n\`| rain\` — hujan tetes air (default)\n\`| fire\` — partikel api naik ke atas 🔥\n\`| snow\` — butiran salju jatuh ❄️\n\`| bubbles\` — gelembung naik ke atas\n\`| lightning\` — kilat zigzag sesekali ⚡\n\`| none\` — tanpa animasi, teks bersih\n\n🎨 *Tema* (bg + warna teks otomatis):\n\`| dark\` — hitam + putih\n\`| neon\` — hitam + hijau neon\n\`| sakura\` — pink + coklat\n\`| sunset\` — gradient merah→oranye 🌈\n\`| ocean\` — gradient navy→biru 🌈\n\`| gold\` — hitam + emas\n\`| violet\` — gradient ungu 🌈\n\`| forest\` — gradient hijau 🌈\n\`| rose\` — gradient merah→ungu 🌈\n\`| minimal\` — putih bersih\n_(tema dengan 🌈 = bg 2 warna gradient otomatis)_\n\n📝 *Emoji* didukung! ❤️ 😢 🌧️ 🎵\n\n👉 *Contoh gabungan:*\n\`${PREFIX}stickerlirik2 aku rindu | neon | glow | fire\`\n\`${PREFIX}stickerlirik2 hujan deras | ocean | snow | outline\`\n\`${PREFIX}stickerlirik2 aku 😢 rindu | sunset | 3 | y2k | lightning\``
                        }, { quoted: msg });
                        continue;
                    }

                    // Parse | parts: warna/gradient, angka, tema, efek, font
                    let bgColor = '#FAE8CC';
                    let bgGrad2 = null;
                    let secPerLine2 = 2;
                    let fontKey2 = null;
                    let effect2 = null;
                    let themeKey2 = null;
                    let animEffect2 = 'rain';
                    if (lyricRaw.includes('|')) {
                        const parts = lyricRaw.split('|');
                        lyricRaw = parts[0].trim();
                        for (let pi = 1; pi < parts.length; pi++) {
                            const p = parts[pi].trim();
                            const pl = p.toLowerCase();
                            const dur = parseFloat(p);
                            const grad = parseLyricGradient(p);
                            const col  = parseLyricColor(p);
                            if (grad)                                    { bgGrad2 = grad; }
                            else if (col)                                { bgColor = col; }
                            else if (!isNaN(dur) && dur >= 1 && dur <= 10) { secPerLine2 = dur; }
                            else if (_lyricThemeSet.has(pl))              { themeKey2 = pl; }
                            else if (_lyricEffectSet.has(pl))             { effect2 = pl; }
                            else if (_lyricAnimSet.has(pl))               { animEffect2 = pl; }
                            else if (_lyricFontSet.has(pl))               { fontKey2 = pl; }
                        }
                    }

                    const lines2 = lyricRaw.split(',').map(l => l.trim()).filter(l => l.length > 0);
                    if (lines2.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '❌ Tidak ada lirik. Gunakan koma (,) sebagai pemisah baris.' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 800);
                    const _info2 = [secPerLine2 + 's', fontKey2, effect2, themeKey2 || (bgGrad2 ? 'gradient' : null)].filter(Boolean).join(', ');
                    await sock.sendMessage(remoteJid, { text: `⏳ Membuat sticker lirik (${_info2})...` }, { quoted: msg });

                    try {
                        // Cek apakah ada foto (sebagai background)
                        let bgImageBuffer = null;
                        const quotedMsg2 = message.extendedTextMessage?.contextInfo?.quotedMessage;
                        if (message.imageMessage) {
                            bgImageBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                        } else if (quotedMsg2?.imageMessage) {
                            const dlKey2 = {
                                message: quotedMsg2,
                                key: { remoteJid: msg.key.remoteJid, id: message.extendedTextMessage.contextInfo.stanzaId, participant: message.extendedTextMessage.contextInfo.participant }
                            };
                            bgImageBuffer = await downloadMediaMessage(dlKey2, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                        }

                        const stickerBuffer2 = await createLyricStickerStatic(lines2, bgColor, bgImageBuffer, secPerLine2, fontKey2, effect2, themeKey2, bgGrad2, animEffect2);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer2 }, { quoted: msg });
                        logger.info(`🎵 Sticker lirik2 dikirim ke ${remoteJid} — ${lines2.length} baris × ${secPerLine2}s font=${fontKey2 || 'default'}`);
                    } catch (error) {
                        logger.error(`❌ Sticker lirik2 error: ${error.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal membuat sticker lirik: ${error.message}` }, { quoted: msg });
                    }

                    continue;
                }

                // -----------------------------------------------
                // FITUR: STICKER LIRIK ANIMASI
                // Perintah: .stickerlirik baris1, baris2, baris3
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'stickerlirik')) {
                    let lyricRaw1 = textContent.replace(new RegExp('^\\' + PREFIX + 'stickerlirik\\s*', 'i'), '').trim();

                    if (!lyricRaw1) {
                        await sock.sendMessage(remoteJid, {
                            text: `🎵 *Sticker Lirik Animasi*\n_(setiap baris muncul bergantian + efek hujan)_\n\n📌 *Cara:*\n\`${PREFIX}stickerlirik baris1, baris2, baris3\`\n_(pisahkan baris pakai koma)_\n\n⚙️ *Semua opsi* (tambah setelah | ):\n\n⏱️ *Durasi*  : \`| 2\`  (detik per baris, 1-10)\n\n🔤 *Font*    :\n\`| serif\` \`| impact\` \`| comic\` \`| verdana\`\n\`| arial\` \`| courier\` \`| trebuchet\` \`| tahoma\`\n_Alias: impact/heavy/tebal • comic/fun/lucu • arial/sans_\n_verdana/clean • courier/ketik/mono • trebuchet/stylish_\n\n✨ *Efek Teks*:\n\`| shadow\` — bayangan hitam di belakang huruf\n\`| outline\` — border di sekeliling huruf\n\`| glow\` — cahaya bersinar dari huruf\n\`| neon2\` — aura glow berlapis 2 warna (lebih dramatis)\n\`| emboss\` — efek timbul 3D\n\`| blur\` — teks dreamy/soft\n\`| gradient\` — huruf bergradient metallic shimmer\n\`| y2k\` — chrome metallic + bintang berkedip ✦\n\n🌊 *Efek Animasi* (ganti hujan):\n\`| rain\` — hujan tetes air (default)\n\`| fire\` — partikel api naik ke atas 🔥\n\`| snow\` — butiran salju jatuh ❄️\n\`| bubbles\` — gelembung naik ke atas\n\`| lightning\` — kilat zigzag sesekali ⚡\n\`| none\` — tanpa animasi, teks bersih\n\n🎨 *Tema* (bg + warna teks + gradient otomatis):\n\`| dark\` — hitam + putih\n\`| neon\` — hitam + hijau neon\n\`| sakura\` — pink lembut\n\`| sunset\` — gradient merah→oranye 🌈\n\`| ocean\` — gradient navy→biru 🌈\n\`| gold\` — hitam + emas\n\`| violet\` — gradient ungu 🌈\n\`| forest\` — gradient hijau 🌈\n\`| rose\` — gradient merah→ungu 🌈\n\`| minimal\` — putih bersih\n_(tema dengan 🌈 = background 2 warna gradient)_\n\n📝 *Emoji* didukung! ❤️ 😢 🌧️ 🎵\n\n👉 *Contoh:*\n\`${PREFIX}stickerlirik aku rindu, dirimu | neon | glow | fire\`\n\`${PREFIX}stickerlirik hujan deras | ocean | snow | outline\`\n\`${PREFIX}stickerlirik baris1, baris2 | sunset | y2k | lightning\``
                        }, { quoted: msg });
                        continue;
                    }

                    // Parse | parts: angka=durasi, tema, efek, font
                    let secPerLine1 = 2;
                    let fontKey1    = null;
                    let effect1     = null;
                    let themeKey1   = null;
                    let animEffect1 = 'rain';
                    if (lyricRaw1.includes('|')) {
                        const parts = lyricRaw1.split('|');
                        lyricRaw1 = parts[0].trim();
                        for (let pi = 1; pi < parts.length; pi++) {
                            const p  = parts[pi].trim();
                            const pl = p.toLowerCase();
                            const dur = parseFloat(p);
                            if (!isNaN(dur) && dur >= 1 && dur <= 10) { secPerLine1 = dur; }
                            else if (_lyricThemeSet.has(pl))            { themeKey1 = pl; }
                            else if (_lyricEffectSet.has(pl))           { effect1 = pl; }
                            else if (_lyricAnimSet.has(pl))             { animEffect1 = pl; }
                            else if (_lyricFontSet.has(pl))             { fontKey1 = pl; }
                        }
                    }

                    const lines = lyricRaw1.split(',').map(l => l.trim()).filter(l => l.length > 0);

                    if (lines.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '❌ Tidak ada lirik ditemukan. Gunakan koma (,) sebagai pemisah baris.' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    const _info1 = [lines.length + ' baris', secPerLine1 + 's', fontKey1, effect1, themeKey1].filter(Boolean).join(', ');
                    await sock.sendMessage(remoteJid, { text: `⏳ Membuat sticker lirik (${_info1})...` }, { quoted: msg });
                    await randomDelay(400, 800);

                    try {
                        const stickerBuffer = await createLyricSticker(lines, secPerLine1, fontKey1, effect1, themeKey1, animEffect1);
                        await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                        logger.info(`🎵 Sticker lirik dikirim ke ${remoteJid} — ${lines.length} baris × ${secPerLine1}s font=${fontKey1 || 'default'}`);
                    } catch (error) {
                        logger.error(`❌ Sticker lirik error: ${error.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal membuat sticker lirik: ${error.message}` }, { quoted: msg });
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
                            text: `✨ *Advanced Sticker Features*\n\n` +
                                `📌 *Cara Pakai:*\n` +
                                `Kirim/reply gambar/video dengan perintah:\n\n` +
                                `🖼️ *Bentuk & Teks:*\n` +
                                `• \`${PREFIX}s\` - Sticker biasa\n` +
                                `• \`${PREFIX}s bulat\` - Bentuk lingkaran\n` +
                                `• \`${PREFIX}s kotak\` - Sudut membulat\n` +
                                `• \`${PREFIX}s teks atas | teks bawah\` - Meme style\n` +
                                `• \`${PREFIX}s teks\` - Teks di atas gambar\n\n` +
                                `🎨 *Filter Warna:*\n` +
                                `• \`${PREFIX}s gray\` - Hitam putih\n` +
                                `• \`${PREFIX}s invert\` - Warna negatif\n` +
                                `• \`${PREFIX}s sepia\` - Efek jadul\n\n` +
                                `🎬 *Video:* Maksimal 10 detik.`,
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
                        const lowText = stickerText.toLowerCase();
                        
                        if (isVideo) {
                            if (stickerText) {
                                stickerBuffer = await createAnimatedStickerWithText(mediaBuffer, stickerText);
                            } else {
                                stickerBuffer = await createAnimatedSticker(mediaBuffer);
                            }
                        } else {
                            // LOGIKA STICKER COOL (Variasi Fitur)
                            if (lowText === 'circle' || lowText === 'bulat') {
                                stickerBuffer = await createCircleSticker(mediaBuffer);
                            } else if (lowText === 'rounded' || lowText === 'kotak') {
                                stickerBuffer = await createRoundedSticker(mediaBuffer);
                            } else if (['gray', 'grayscale', 'invert', 'sepia'].includes(lowText)) {
                                stickerBuffer = await createFilteredSticker(mediaBuffer, lowText);
                            } else if (stickerText.includes('|')) {
                                // Fitur 1: Meme Style (Top | Bottom) ATAU Watermark (Pack | Auth)
                                const parts = stickerText.split('|').map(p => p.trim());
                                
                                // Jika ada 2 pipe (3 parts) -> Meme + Custom Watermark? (mungkin terlalu kompleks)
                                // Kita asumsikan defaultnya adalah Meme (Top | Bottom)
                                stickerBuffer = await createMemeSticker(mediaBuffer, parts[0], parts[1]);
                            } else if (stickerText) {
                                // Sticker diam dengan teks di atas (default lama)
                                stickerBuffer = await createStickerWithText(mediaBuffer, stickerText);
                            } else {
                                // Sticker biasa
                                stickerBuffer = await convertToSticker(mediaBuffer);
                            }
                        }

                        // Kirim sticker
                        await sock.sendMessage(remoteJid, {
                            sticker: stickerBuffer,
                        }, { quoted: msg });
                        logger.info(`🎨 Sticker${isVideo ? ' gerak' : ''} dikirim ke ${remoteJid}${stickerText ? ` dengan opsi: "${stickerText}"` : ''}`);
                    } catch (error) {
                        logger.error(`❌ Sticker process error: ${error.message}`);
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
                            const lowText = stickerText.toLowerCase();

                            if (isVideo) {
                                if (stickerText) {
                                    stickerBuffer = await createAnimatedStickerWithText(mediaBuffer, stickerText);
                                } else {
                                    stickerBuffer = await createAnimatedSticker(mediaBuffer);
                                }
                            } else {
                                if (lowText === 'circle' || lowText === 'bulat') {
                                    stickerBuffer = await createCircleSticker(mediaBuffer);
                                } else if (lowText === 'rounded' || lowText === 'kotak') {
                                    stickerBuffer = await createRoundedSticker(mediaBuffer);
                                } else if (['gray', 'grayscale', 'invert', 'sepia'].includes(lowText)) {
                                    stickerBuffer = await createFilteredSticker(mediaBuffer, lowText);
                                } else if (stickerText.includes('|')) {
                                    const parts = stickerText.split('|').map(p => p.trim());
                                    stickerBuffer = await createMemeSticker(mediaBuffer, parts[0], parts[1]);
                                } else if (stickerText) {
                                    stickerBuffer = await createStickerWithText(mediaBuffer, stickerText);
                                } else {
                                    stickerBuffer = await convertToSticker(mediaBuffer);
                                }
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

                    // --- Extract Audio via caption (.tomp3 / .toaudio) ---
                    if (message.videoMessage && (caption.startsWith(PREFIX + 'tomp3') || caption.startsWith(PREFIX + 'toaudio') || caption.startsWith(PREFIX + 'tovn'))) {
                        await simulateTyping(sock, remoteJid, 1000);
                        await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengekstrak audio dari video...' }, { quoted: msg });

                        try {
                            const videoBuf = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                            if (!videoBuf) throw new Error('Gagal download video');

                            if (caption.startsWith(PREFIX + 'tomp3')) {
                                const mp3Buf = await convertToMp3(videoBuf);
                                await sock.sendMessage(remoteJid, {
                                    document: mp3Buf,
                                    mimetype: 'audio/mpeg',
                                    fileName: `audio_${Date.now()}.mp3`,
                                    caption: '✅ Berhasil ekstrak ke MP3'
                                }, { quoted: msg });
                            } else {
                                const oggBuf = await convertToOggOpus(videoBuf);
                                let duration = await getAudioDuration(oggBuf);
                                if (!duration || duration < 1) duration = 1;
                                
                                await sock.sendMessage(remoteJid, {
                                    audio: oggBuf,
                                    mimetype: 'audio/ogg; codecs=opus',
                                    ptt: true,
                                    seconds: duration,
                                    waveform: generateWaveform()
                                }, { quoted: msg });
                            }
                            logger.info(`🎵 Audio diekstrak dari video (caption) dikirim ke ${remoteJid}`);
                        } catch (err) {
                            logger.error(`❌ extract audio caption error: ${err.message}`);
                            await sock.sendMessage(remoteJid, { text: `❌ Gagal ekstrak audio: ${err.message}` }, { quoted: msg });
                        }
                        continue;
                    }
                }

                // -----------------------------------------------
                // FITUR: FAKE PREVIEW (HIDDEN IMAGE) — .fake [teks]
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'fake')) {
                    const baitText = textContent.replace(/^\.fake\s*/i, '').trim() || 'TAP ME';
                    
                    // Ambil contextInfo dari berbagai kemungkinan tipe pesan
                    const contextInfo = message.extendedTextMessage?.contextInfo || 
                                      message.imageMessage?.contextInfo || 
                                      message.videoMessage?.contextInfo;
                                      
                    const quotedMsg = contextInfo?.quotedMessage;
                    const imageMsg = message.imageMessage || quotedMsg?.imageMessage;

                    if (!imageMsg) {
                        await sock.sendMessage(remoteJid, { 
                            text: `🖼️ *Fake Preview (Hidden Image)*\n\nSembunyikan gambar di balik thumbnail pancingan!\n\n📌 *Cara pakai:*\nReply gambar lalu ketik \`${PREFIX}fake [tulisan]\`\n\nContoh: \`${PREFIX}fake jangan dibuka\`` 
                        }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 800);
                    await sock.sendMessage(remoteJid, { text: '⏳ Menyiapkan kejutan...' }, { quoted: msg });

                    try {
                        let downloadKey;
                        if (message.imageMessage) {
                            downloadKey = msg;
                        } else {
                            if (!contextInfo?.stanzaId) throw new Error('Informasi pesan balasan tidak ditemukan');
                            downloadKey = {
                                message: quotedMsg,
                                key: { remoteJid, id: contextInfo.stanzaId, participant: contextInfo.participant }
                            };
                        }

                        const fullImage = await downloadMediaMessage(downloadKey, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });
                        const baitThumb = await generateFakeThumbnail(baitText);

                        if (fullImage && baitThumb) {
                            await sock.sendMessage(remoteJid, {
                                document: fullImage,
                                fileName: `${baitText}.jpg`,
                                mimetype: 'application/octet-stream',
                                jpegThumbnail: baitThumb,
                                caption: `✨ *Hidden Image Berhasil!*\n\n💡 _Klik file di atas untuk melihat kejutan aslinya_`,
                                contextInfo: {
                                    externalAdReply: {
                                        title: baitText,
                                        body: 'File Rahasia (Terenskripsi)',
                                        thumbnail: baitThumb,
                                        mediaType: 1,
                                        renderLargerThumbnail: false,
                                        showAdAttribution: true
                                    }
                                }
                            }, { quoted: msg });
                        }
                    } catch (err) {
                        logger.error(`❌ fake error: ${err.message}`);
                    }
                    continue;
                }

                // --- FITUR: FAKE IMAGE (LONG IMAGE) — .fakeimg ---
                // Gabungkan gambar pancingan (atas) + gambar rahasia (bawah) jadi satu gambar panjang
                // WhatsApp otomatis crop preview-nya, jadi orang hanya lihat bagian atas
                if (textContent.startsWith(PREFIX + 'fakeimg')) {
                    const ctx = message.imageMessage?.contextInfo || message.extendedTextMessage?.contextInfo;
                    const quotedMsg = ctx?.quotedMessage;
                    
                    const baitImageMsg = message.imageMessage;
                    const realImageMsg = quotedMsg?.imageMessage;

                    if (!baitImageMsg || !realImageMsg) {
                        await sock.sendMessage(remoteJid, { 
                            text: `🎭 *Fake Image (Gambar Panjang)*\n\nSembunyikan gambar di balik gambar lain!\n\n📌 *Cara pakai:*\n1. Cari gambar *RAHASIA* yang mau disembunyikan.\n2. Klik *Balas (Reply)* pada gambar rahasia tersebut.\n3. Lampirkan *Gambar PANCINGAN* (sampul).\n4. Ketik caption \`${PREFIX}fakeimg\` lalu kirim.\n\n💡 _Gambar pancingan akan muncul di preview chat, gambar rahasia tersembunyi di bawahnya!_` 
                        }, { quoted: msg });
                        continue;
                    }

                    await sock.sendMessage(remoteJid, { text: '⏳ Menjahit dua gambar menjadi satu kejutan...' }, { quoted: msg });

                    try {
                        const sharp = require('sharp');
                        
                        // 1. Download gambar rahasia (dari reply)
                        const realBuffer = await downloadMediaMessage({
                            message: quotedMsg,
                            key: { remoteJid, id: ctx.stanzaId, participant: ctx.participant }
                        }, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });

                        // 2. Download gambar pancingan (dari pesan ini)
                        const baitBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage });

                        // 3. Resize kedua gambar ke lebar yang sama (800px)
                        const TARGET_WIDTH = 800;
                        
                        const baitResized = await sharp(baitBuffer)
                            .resize(TARGET_WIDTH, null, { fit: 'inside' })
                            .png()
                            .toBuffer();
                        const baitMeta = await sharp(baitResized).metadata();

                        const realResized = await sharp(realBuffer)
                            .resize(TARGET_WIDTH, null, { fit: 'inside' })
                            .png()
                            .toBuffer();
                        const realMeta = await sharp(realResized).metadata();

                        // 4. Buat "Ruang Kosong" (padding) besar antara keduanya
                        //    agar gambar rahasia benar-benar jauh di bawah
                        const PADDING = 2000; // 2000px ruang kosong putih
                        const totalHeight = baitMeta.height + PADDING + realMeta.height;

                        // 5. Gabungkan: Pancingan (atas) + Padding + Rahasia (bawah)
                        const combined = await sharp({
                            create: {
                                width: TARGET_WIDTH,
                                height: totalHeight,
                                channels: 4,
                                background: { r: 255, g: 255, b: 255, alpha: 1 }
                            }
                        })
                        .composite([
                            { input: baitResized, top: 0, left: 0 },
                            { input: realResized, top: baitMeta.height + PADDING, left: 0 }
                        ])
                        .jpeg({ quality: 80 })
                        .toBuffer();

                        // 6. Kirim sebagai gambar biasa (bukan dokumen!)
                        await sock.sendMessage(remoteJid, {
                            image: combined,
                            caption: `🎭 *Scroll ke bawah untuk melihat kejutannya~*`
                        }, { quoted: msg });

                        logger.info(`🎭 FakeImg (Long Image) dikirim ke ${remoteJid}`);

                    } catch (err) {
                        logger.error(`❌ fakeimg error: ${err.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal memproses: ${err.message}` }, { quoted: msg });
                    }
                    continue;
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
                            let duration = await getAudioDuration(oggBuffer);
                            if (!duration || duration < 1) duration = 1;

                            await sock.sendMessage(CHANNEL_JID, {
                                audio: oggBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                seconds: duration,
                                waveform: generateWaveform(),
                            });
                            logger.info(`✅ TikTok Audio OGG dikirim ke channel: ${CHANNEL_JID}`);
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
                // FITUR: VOICE CHANGER — .tovn [filter]
                // -----------------------------------------------
                if (textContent.startsWith(PREFIX + 'tovn') || textContent.startsWith(PREFIX + 'vchanger')) {
                    const args = textContent.trim().split(/\s+/);
                    const filter = args[1]?.toLowerCase();
                    const validFilters = ['robot', 'tupai', 'raksasa', 'deep', 'bass', 'nightcore', 'slow', 'fast', 'reverse', 'smooth', 'earrape', 'blown', 'vibrato'];

                    if (!filter || !validFilters.includes(filter)) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Pilih filter yang valid!\n\n🎨 Filter tersedia:\n${validFilters.map(f => `  • \`${f}\``).join('\n')}\n\n💡 *Cara pakai:*\nReply VN/Audio lalu ketik *${PREFIX}tovn [filter]*`
                        }, { quoted: msg });
                        continue;
                    }

                    const contextInfo = message.extendedTextMessage?.contextInfo;
                    const quotedMsg = contextInfo?.quotedMessage;
                    const isAudio = quotedMsg?.audioMessage;

                    if (!isAudio) {
                        await sock.sendMessage(remoteJid, { text: '❌ Silakan reply Voice Note atau Audio yang ingin diubah suaranya.' }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    await sock.sendMessage(remoteJid, { text: `⏳ Sedang mengubah suara menjadi *${filter}*...` }, { quoted: msg });

                    try {
                        const audioBuf = await downloadMediaMessage(
                            { 
                                key: {
                                    remoteJid: remoteJid,
                                    id: contextInfo.stanzaId,
                                    participant: contextInfo.participant
                                }, 
                                message: quotedMsg 
                            },
                            'buffer',
                            {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!audioBuf) throw new Error('Gagal download audio');

                        const resultBuffer = await applyVoiceFilter(audioBuf, filter);

                        await sock.sendMessage(remoteJid, {
                            audio: resultBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                            waveform: [0, 10, 50, 100, 50, 10, 0] 
                        }, { quoted: msg });

                        logger.info(`🎵 Voice Changer (${filter}) dikirim ke ${remoteJid}`);
                    } catch (err) {
                        logger.error(`❌ Voice changer error: ${err.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal mengubah suara: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }

                // -----------------------------------------------
                // FITUR: GAMES (16 GAME, 2000+ SOAL!)
                // -----------------------------------------------
                if (textContent.trim() === PREFIX + 'gamelist') {
                    await sock.sendMessage(remoteJid, { text: games.getGameList(PREFIX) }, { quoted: msg });
                    continue;
                }
                const allGameCmds = [
                    'tebaktebakan', 'tebakgambar', 'tebakkata', 'tebakbendera',
                    'tebakkimia', 'tebaklirik', 'tebakkalimat', 'caklontong',
                    'asahotak', 'siapakahaku', 'susunkata', 'tekateki',
                    'family100', 'math', 'tebakangka'
                ];
                const matchedGame = allGameCmds.find(cmd => textContent.trim() === PREFIX + cmd);
                if (matchedGame) {
                    await games.startGame(sock, remoteJid, msg, matchedGame);
                    continue;
                }
                if (textContent.trim() === PREFIX + 'tod' || textContent.trim() === PREFIX + 'truthordare') {
                    await games.startGame(sock, remoteJid, msg, 'truthordare');
                    continue;
                }

                // ==========================================
                // TOOLS & SEARCH & SANKA
                // ==========================================
                if (textContent.startsWith(PREFIX + 'anime')) {
                    await simulateTyping(sock, remoteJid, 1000);
                    const res = await sanka.sankaFetch('anime');
                    if (res) {
                        if (res.type === 'url' || res.type === 'image') {
                            await sock.sendMessage(remoteJid, { image: res.type === 'url' ? { url: res.data } : res.data, caption: '🌸 Random Anime' }, { quoted: msg });
                        } else if (res.type === 'json' || res.type === 'text') {
                            const textData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
                            await sock.sendMessage(remoteJid, { text: `[API Response]\n${textData.substring(0, 500)}` }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil data anime dari Sankavollerei.' }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'comic')) {
                    await simulateTyping(sock, remoteJid, 1000);
                    const res = await sanka.sankaFetch('comic');
                    if (res) {
                        if (res.type === 'url' || res.type === 'image') {
                            await sock.sendMessage(remoteJid, { image: res.type === 'url' ? { url: res.data } : res.data, caption: '📖 Random Comic' }, { quoted: msg });
                        } else if (res.type === 'json' || res.type === 'text') {
                            const textData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
                            await sock.sendMessage(remoteJid, { text: `[API Response]\n${textData.substring(0, 500)}` }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil data comic dari Sankavollerei.' }, { quoted: msg });
                    }
                    continue;
                }
                if (textContent.startsWith(PREFIX + 'pin')) {
                    const query = textContent.slice(PREFIX.length + 3).trim();
                    if (!query) return sock.sendMessage(remoteJid, { text: `❌ Gunakan: ${PREFIX}pin [kueri]\nContoh: ${PREFIX}pin pemandangan anime` }, { quoted: msg });
                    
                    await simulateTyping(sock, remoteJid, 1000);
                    const results = await tools.pinterestSearch(query);
                    if (results && results.length > 0) {
                        const imgUrl = results[Math.floor(Math.random() * results.length)];
                        await sock.sendMessage(remoteJid, { image: { url: imgUrl }, caption: `📌 Hasil pencarian untuk: *${query}*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Tidak ditemukan hasil untuk pencarian tersebut.' }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'ssweb')) {
                    const url = textContent.slice(PREFIX.length + 5).trim();
                    if (!url) return sock.sendMessage(remoteJid, { text: `❌ Gunakan: ${PREFIX}ssweb [url]\nContoh: ${PREFIX}ssweb https://google.com` }, { quoted: msg });
                    
                    await simulateTyping(sock, remoteJid, 1000);
                    const ss = await tools.ssweb(url);
                    if (ss) {
                        await sock.sendMessage(remoteJid, { image: { url: ss }, caption: `📸 Screenshot Website: *${url}*` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil screenshot website tersebut.' }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'google')) {
                    const query = textContent.slice(PREFIX.length + 6).trim();
                    if (!query) return sock.sendMessage(remoteJid, { text: `❌ Gunakan: ${PREFIX}google [kueri]` }, { quoted: msg });
                    
                    await simulateTyping(sock, remoteJid, 1000);
                    const results = await tools.googleSearch(query);
                    if (results && results.length > 0) {
                        let resMsg = `🔍 *Google Search: ${query}*\n\n`;
                        results.slice(0, 5).forEach((res, i) => {
                            resMsg += `${i + 1}. *${res.title}*\n🔗 ${res.link}\n📝 ${res.snippet}\n\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Tidak ditemukan hasil di Google.' }, { quoted: msg });
                    }
                    continue;
                }

                if (textContent.startsWith(PREFIX + 'sholat')) {
                    const kota = textContent.slice(PREFIX.length + 6).trim();
                    if (!kota) return sock.sendMessage(remoteJid, { text: `❌ Gunakan: ${PREFIX}sholat [nama_kota]\nContoh: ${PREFIX}sholat jakarta` }, { quoted: msg });
                    
                    await simulateTyping(sock, remoteJid, 1000);
                    const res = await tools.jadwalSholat(kota);
                    if (res) {
                        let sholatMsg = `🕋 *Jadwal Sholat: ${kota.toUpperCase()}*\n📅 Tanggal: ${res.tanggal || '-'}\n\n`;
                        sholatMsg += `Imsak: ${res.imsak}\n`;
                        sholatMsg += `Subuh: ${res.subuh}\n`;
                        sholatMsg += `Dzuhur: ${res.dzuhur}\n`;
                        sholatMsg += `Ashar: ${res.ashar}\n`;
                        sholatMsg += `Maghrib: ${res.maghrib}\n`;
                        sholatMsg += `Isya: ${res.isya}`;
                        await sock.sendMessage(remoteJid, { text: sholatMsg }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Gagal mendapatkan jadwal sholat untuk kota tersebut.' }, { quoted: msg });
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
                // FITUR: CONVERT VIDEO KE AUDIO
                // Perintah: .tomp3 atau .toaudio (reply video)
                // -----------------------------------------------
                if (textContent === PREFIX + 'tomp3' || textContent === PREFIX + 'toaudio' || textContent === PREFIX + 'tovn') {
                    const contextInfo = message.extendedTextMessage?.contextInfo;
                    const qMsg = contextInfo?.quotedMessage;
                    
                    // Unwrap video message (handling different wrappers)
                    const unwrapVideo = (q) => {
                        if (!q) return null;
                        return q.videoMessage ||
                            q.viewOnceMessage?.message?.videoMessage ||
                            q.viewOnceMessageV2?.message?.videoMessage ||
                            q.ephemeralMessage?.message?.videoMessage ||
                            null;
                    };

                    const quotedVideo = unwrapVideo(qMsg);

                    if (!quotedVideo) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ *Reply* video yang ingin diekstrak audionya, lalu ketik *${PREFIX}tomp3* atau *${PREFIX}toaudio*`,
                        }, { quoted: msg });
                        continue;
                    }

                    await simulateTyping(sock, remoteJid, 1000);
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengekstrak audio dari video...' }, { quoted: msg });

                    const quotedMsgObj = {
                        key: {
                            remoteJid: remoteJid,
                            id: contextInfo.stanzaId,
                            fromMe: contextInfo.participant === sock.user?.id,
                            participant: contextInfo.participant,
                        },
                        message: qMsg,
                    };

                    try {
                        const videoBuf = await downloadMediaMessage(
                            quotedMsgObj, 'buffer', {},
                            { logger: baileyLogger, reuploadRequest: sock.updateMediaMessage }
                        );

                        if (!videoBuf) throw new Error('Gagal download video');

                        if (textContent === PREFIX + 'tomp3') {
                            const mp3Buf = await convertToMp3(videoBuf);
                            await sock.sendMessage(remoteJid, {
                                document: mp3Buf,
                                mimetype: 'audio/mpeg',
                                fileName: `audio_${Date.now()}.mp3`,
                                caption: '✅ Berhasil ekstrak ke MP3'
                            }, { quoted: msg });
                        } else {
                            const oggBuf = await convertToOggOpus(videoBuf);
                            let duration = await getAudioDuration(oggBuf);
                            if (!duration || duration < 1) duration = 1;
                            
                            await sock.sendMessage(remoteJid, {
                                audio: oggBuf,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                                seconds: duration,
                                waveform: generateWaveform()
                            }, { quoted: msg });
                        }
                        logger.info(`🎵 Audio diekstrak dari video (reply) dikirim ke ${remoteJid}`);
                    } catch (err) {
                        logger.error(`❌ extract audio error: ${err.message}`);
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal ekstrak audio: ${err.message}` }, { quoted: msg });
                    }
                    continue;
                }
                // -----------------------------------------------
                // FITUR: GAME TEBAK-TEBAKAN (FALLBACK — handled above)
                // -----------------------------------------------

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

                    const helpText = `🤖 *${cfg.getConfig().botName}* — Daftar Perintah

┏━『 *STICKER & LOTTIE* 』
┃
┣⌬ ${PREFIX}sticker
┣⌬ ${PREFIX}qc (Quotly)
┣⌬ ${PREFIX}toimg / .tovid
┣⌬ ${PREFIX}lottie / .ssearch
┗━━━━━━━◧

┏━『 *RYZUMI PREMIUM AI* 』
┃
┣⌬ ${PREFIX}ai [tanya]
┣⌬ ${PREFIX}gemini [google]
┣⌬ ${PREFIX}flux [gambar]
┣⌬ ${PREFIX}remini [hd]
┗━━━━━━━◧

┏━『 *DOWNLOADER* 』
┃
┣⌬ ${PREFIX}tiktok / .ttaudio
┣⌬ ${PREFIX}ig / .instagram
┣⌬ ${PREFIX}ytmp3 / .ytmp4
┣⌬ ${PREFIX}play / .pinvideo
┗━━━━━━━◧

┏━『 *GRUP & ADMIN* 』
┃
┣⌬ ${PREFIX}kick / .add / .warn
┣⌬ ${PREFIX}promote / .demote
┣⌬ ${PREFIX}setnamegc / .setopen
┣⌬ ${PREFIX}linkgc / .revokelink
┣⌬ ${PREFIX}antilink / .antibot
┣⌬ ${PREFIX}welcome / .antidelete
┣⌬ ${PREFIX}tagall / .hidetag
┣⌬ ${PREFIX}groupinfo / .list
┗━━━━━━━◧

┏━『 *TOOLS & SEARCH* 』
┃
┣⌬ ${PREFIX}ss [url] / .sholat
┣⌬ ${PREFIX}stalkig [user]
┣⌬ ${PREFIX}stalktt [user]
┣⌬ ${PREFIX}google / .pin
┣⌬ ${PREFIX}gempa / .news
┣⌬ ${PREFIX}jokes / .quotes
┣⌬ ${PREFIX}shortlink [url]
┣⌬ ${PREFIX}bot [teks]
┗━━━━━━━◧

┏━『 *GAMES (2000+ Soal!)* 』
┃
┣⌬ .tebakgambar / .tebaklirik
┣⌬ .tebaktebakan / .tebakbendera
┣⌬ .asahotak / .siapakahaku
┣⌬ .susunkata / .tekateki
┣⌬ .caklontong / .family100
┣⌬ .math / .tebakangka / .tod
┣⌬ .gamelist — Daftar lengkap
┗━━━━━━━◧

┏━『 *AUDIO TOOLS* 』
┃
┣⌬ .kirim / .ceksaluran
┣⌬ .tovn [filter]
┣⌬ .tomp3 / .toaudio
┣⌬ .copier (Multi-Copier Saluran)
┗━━━━━━━◧

*Info:* Ketik perintah tanpa tanda kurung.
• Owner: ${cfg.getDisplayOwner() || 'belum diatur'}`;

                    const { useMenuImage, menuImage } = cfg.getConfig();
                    
                    if (useMenuImage && menuImage) {
                        try {
                            await sock.sendMessage(remoteJid, {
                                image: { url: menuImage },
                                caption: helpText,
                                mentions: [msg.key.participant || msg.key.remoteJid]
                            }, { quoted: msg });
                        } catch (imgErr) {
                            logger.error(`⚠️ Gagal mengirim gambar menu (URL error): ${imgErr.message}`);
                            // Fallback ke teks jika gambar gagal
                            await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
                            await sock.sendMessage(remoteJid, { text: `⚠️ *Catatan:* Gambar menu gagal dimuat. Pastikan file gambar atau link valid.` }, { quoted: msg });
                        }
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

