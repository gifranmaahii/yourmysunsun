import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '../../data/child_bots.json');

// Pastikan file database ada
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
}

/**
 * Mendapatkan daftar bot anak
 */
export const getChildBots = () => {
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
 * @param {string} phone Nomor HP Bot Anak
 * @param {string} name Nama Pembeli/Bot
 * @param {number} days Durasi sewa (hari)
 * @param {string} ownerPhone Nomor HP Owner Bot Anak
 */
export const addChildBot = async (sock, remoteJid, phone, name, days, ownerPhone) => {
    const bots = getChildBots();
    
    // Hitung waktu kadaluarsa
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(days));
    
    const newBot = {
        phone,
        name,
        owner: ownerPhone,
        sessionName: `bot_${phone}`,
        addedAt: new Date().toISOString(),
        expiryAt: expiryDate.toISOString(),
        status: 'pending'
    };

    // Jalankan bot di latar belakang
    const child = spawn(process.execPath, ['index.js', `--session=bot_${phone}`, `--pairing=${phone}`, `--owner=${ownerPhone}`], {
        cwd: path.join(__dirname, '../../'),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    console.log(`🚀 [BotManager] Memulai proses bot anak untuk ${phone}...`);
    await sock.sendMessage(remoteJid, { text: `🚀 Menghubungkan ke server WhatsApp untuk nomor ${phone}... Mohon tunggu sebentar.` });

    let pairingCodeSent = false;

    // Log output untuk debug
    child.stdout.on('data', async (data) => {
        const output = data.toString();
        console.log(`[ChildBot ${phone}] STDOUT: ${output}`);

        // Cari pola kode pairing (format XXXX-XXXX)
        const pairingMatch = output.match(/KODE PAIRING ANDA: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
        
        if (pairingMatch && !pairingCodeSent) {
            pairingCodeSent = true;
            const code = pairingMatch[1];
            
            await sock.sendMessage(remoteJid, {
                text: `✅ *Bot Anak Berhasil Disiapkan!*\n\n` +
                      `👤 Nama: ${name}\n` +
                      `📱 Nomor: ${phone}\n` +
                      `⏳ Sewa: ${days} Hari\n` +
                      `📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}\n\n` +
                      `🔑 *KODE PAIRING ANDA:*\n` +
                      `*${code}*\n\n` +
                      `_Silakan masukkan kode di atas pada menu Tautkan Perangkat di WhatsApp HP pembeli._`
            });
            
            newBot.status = 'active';
            bots.push(newBot);
            saveChildBots(bots);
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`[ChildBot ${phone}] ERROR: ${data.toString()}`);
    });

    // Timeout jika kode pairing tidak muncul dalam 120 detik
    setTimeout(() => {
        if (!pairingCodeSent) {
            sock.sendMessage(remoteJid, { text: `❌ Gagal mendapatkan kode pairing untuk ${phone}. Pastikan nomor tersebut tidak sedang login di tempat lain (RDP/Web) dan coba lagi dalam 1 menit.` });
            child.kill();
        }
    }, 120000);
};

/**
 * Menampilkan daftar bot yang sedang aktif
 */
export const listChildBots = async (sock, remoteJid) => {
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
