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
 * @param {string} phone Nomor HP
 * @param {string} name Nama Pembeli/Bot
 * @param {number} days Durasi sewa (hari)
 */
export const addChildBot = async (sock, remoteJid, phone, name, days) => {
    const bots = getChildBots();
    
    // Hitung waktu kadaluarsa
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(days));
    
    const newBot = {
        phone,
        name,
        sessionName: `bot_${phone}`,
        addedAt: new Date().toISOString(),
        expiryAt: expiryDate.toISOString(),
        status: 'pending'
    };

    // Jalankan bot di latar belakang menggunakan PM2 atau Node langsung
    // Kita gunakan spawn agar bisa menangkap output Pairing Code jika ada
    const child = spawn('node', ['index.js', `--session=bot_${phone}`, `--pairing=${phone}`], {
        cwd: path.join(__dirname, '../../'),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let pairingCodeSent = false;

    child.stdout.on('data', async (data) => {
        const output = data.toString();
        // Cari pola kode pairing (8 digit: XXXX-XXXX)
        const pairingMatch = output.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
        
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

    child.on('error', (err) => {
        console.error('Gagal menjalankan bot anak:', err);
    });

    // Timeout jika kode pairing tidak muncul dalam 60 detik
    setTimeout(() => {
        if (!pairingCodeSent) {
            sock.sendMessage(remoteJid, { text: `❌ Gagal mendapatkan kode pairing untuk ${phone}. Pastikan nomor benar dan coba lagi.` });
            child.kill();
        }
    }, 60000);
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
