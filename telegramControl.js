const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config({ path: path.join(__dirname, '.env_telegram') });

// Konfigurasi
const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.PTERODACTYL_API_KEY;
const serverId = process.env.PTERODACTYL_SERVER_ID;
const baseUrl = process.env.PTERODACTYL_BASE_URL;
const ownerId = process.env.TELEGRAM_OWNER_ID; // ID Telegram Owner

const bot = new TelegramBot(token, { 
    polling: {
        params: {
            drop_pending_updates: true
        }
    } 
});
let lastChatId = null;
let logBuffer = []; // Simpan 20 log terakhir
const MAX_LOGS = 20;

if (!global.botEvents) {
    const { EventEmitter } = require('events');
    global.botEvents = new EventEmitter();
}

global.botEvents.on('telegram_auth', (data) => {
    if (!lastChatId) return;
    if (data.type === 'qr') {
        const caption = `✅ *QR Code Berhasil Dibuat!*\n\n👤 Nama: ${data.name}\n📱 Nomor: ${data.phone}\n⏳ Sewa: ${data.days} Hari\n📅 Expired: ${data.expiryDate}\n\n💡 Silakan Scan QR Code ini dari menu Perangkat Tertaut WhatsApp (Maksimal 3 menit).`;
        bot.sendPhoto(lastChatId, data.buffer, { caption: caption, parse_mode: 'Markdown' }).catch(console.error);
    } else if (data.type === 'pairing') {
        const caption = `✅ *Kode Pairing Berhasil Dibuat!*\n\n👤 Nama: ${data.name}\n📱 Nomor: ${data.phone}\n⏳ Sewa: ${data.days} Hari\n📅 Expired: ${data.expiryDate}\n\n🔑 *KODE PAIRING:*\n*${data.code}*\n\n💡 Masukkan kode ini ke WhatsApp tujuan!`;
        bot.sendMessage(lastChatId, caption, { parse_mode: 'Markdown' });
    }
});

global.botEvents.on('telegram_message', (text) => {
    if (!lastChatId) return;
    bot.sendMessage(lastChatId, text, { parse_mode: 'Markdown' }).catch(console.error);
});

console.log('🚀 Telegram Panel Control is starting...');

// Instance Axios untuk Pterodactyl
const ptero = axios.create({
    baseURL: `${baseUrl}/api/client/servers/${serverId}`,
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'Application/vnd.pterodactyl.v1+json',
    }
});

// Middleware Cek Owner (Dinonaktifkan agar semua orang bisa akses)
function isOwner(msg) {
    return true; 
}

// ==========================================
// WEBSOCKET LOG MONITORING (Zero Panel)
// ==========================================
let ws = null;

async function connectToConsole() {
    try {
        const res = await ptero.get('/websocket');
        const { data } = res.data;
        
        console.log(`📡 Attempting WebSocket connection to: ${data.socket}`);

        ws = new WebSocket(data.socket, {
            origin: baseUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        ws.on('open', () => {
            ws.send(JSON.stringify({ event: 'auth', args: [data.token] }));
            console.log('✅ Connected to Panel Console via WebSocket');
        });

        ws.on('message', (msg) => {
            const payload = JSON.parse(msg);
            if (payload.event === 'console output') {
                const text = payload.args[0];
                
                // Simpan ke buffer log
                logBuffer.push(text.replace(/\u001b\[[0-9;]*m/g, '')); // Bersihkan ANSI colors
                if (logBuffer.length > MAX_LOGS) logBuffer.shift();

                // Tangkap Pairing Code
                if (text.includes('PAIRING_CODE:')) {
                    const code = text.split('PAIRING_CODE:')[1].trim();
                    if (lastChatId) {
                        bot.sendMessage(lastChatId, `🔑 *KODE PAIRING ANDA:* \`${code}\`\n\n📱 Masukkan kode ini di WhatsApp HP kamu!`, { parse_mode: 'Markdown' });
                    }
                }
                
                // Tangkap Login Sukses
                if (text.includes('CONNECTED') || text.includes('TERHUBUNG')) {
                    if (lastChatId) bot.sendMessage(lastChatId, '✅ *Bot WhatsApp Berhasil Terhubung!*', { parse_mode: 'Markdown' });
                }

                // Tangkap Error Penting
                if (text.toLowerCase().includes('error') || text.toLowerCase().includes('crash') || text.toLowerCase().includes('failed')) {
                    if (lastChatId) {
                        const cleanErr = text.replace(/\u001b\[[0-9;]*m/g, '').trim();
                        if (cleanErr.length > 5) {
                            bot.sendMessage(lastChatId, `⚠️ *NOTIFIKASI LOG:* \n\n\`${cleanErr.slice(0, 500)}\``, { parse_mode: 'Markdown' });
                        }
                    }
                }
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`📡 WebSocket Closed (Code: ${code}). Reconnecting in 15s...`);
            setTimeout(connectToConsole, 15000);
        });

        ws.on('error', (err) => {
            console.error('❌ WebSocket Error:', err.message);
        });

    } catch (e) {
        const delay = e.response?.status === 429 ? 30000 : 10000;
        console.error(`❌ Failed to connect to WebSocket: ${e.message}`);
        setTimeout(connectToConsole, delay);
    }
}

connectToConsole();

// ==========================================
// COMMAND HANDLERS
// ==========================================

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '❌ Anda bukan owner bot ini.');
    lastChatId = msg.chat.id;
    const welcome = `👋 Halo! Saya Bot Pengendali Panel.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *SISTEM KONTROL*\n` +
        `🔹 /status - Cek status bot\n` +
        `🔹 /startbot - Nyalakan bot\n` +
        `🔹 /stopbot - Matikan bot\n` +
        `🔹 /restartbot - Restart bot\n` +
        `🔹 /update - Git Pull (Tarik kodingan baru)\n\n` +
        `🔑 *WA & PAIRING*\n` +
        `🔹 /pair [nomor] - Login pake Pairing Code\n` +
        `🔹 /logout - Hapus Sesi (Logout Total)\n\n` +
        `👥 *MANAJEMEN BOT ANAK*\n` +
        `🔹 /addbot [nomor] [nama] [hari] [owner] - Tambah (Pairing Code)\n` +
        `🔹 /addbotqr [nomor] [nama] [hari] [owner] - Tambah (QR Code)\n` +
        `🔹 /listbots - Daftar Bot Anak\n` +
        `🔹 /delbot [nomor/nama] - Hapus Bot Anak\n` +
        `🔹 /delbots [nomor/nama] - Hapus Bot Anak (Alias)\n\n` +
        `📋 *MONITORING*\n` +
        `🔹 /logs - Lihat log console terakhir\n` +
        `━━━━━━━━━━━━━━━━━━`;
    bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
});

// Helper: Cek Status
async function getServerStatus() {
    try {
        const res = await ptero.get('/resources');
        return res.data.attributes.current_state;
    } catch (e) {
        return 'error';
    }
}

// Helper: Kirim Perintah Power
async function sendPowerAction(signal) {
    try {
        await ptero.post('/power', { signal });
        return true;
    } catch (e) {
        console.error('Power Error:', e.response?.data || e.message);
        return false;
    }
}

// Helper: Kirim Perintah Console
async function sendCommand(command) {
    try {
        await ptero.post('/command', { command });
        return true;
    } catch (e) {
        console.error('Command Error:', e.response?.data || e.message);
        return false;
    }
}

bot.onText(/\/status/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Menghubungi panel...');
    const status = await getServerStatus();
    const emoji = status === 'running' ? '🟢' : status === 'offline' ? '🔴' : '🟡';
    bot.sendMessage(msg.chat.id, `${emoji} *Status Server:* ${status.toUpperCase()}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/startbot/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Mencoba menyalakan bot...');
    const success = await sendPowerAction('start');
    bot.sendMessage(msg.chat.id, success ? '✅ Bot sedang proses booting...' : '❌ Gagal menyalakan bot.');
});

bot.onText(/\/stopbot/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Mencoba mematikan bot...');
    const success = await sendPowerAction('stop');
    bot.sendMessage(msg.chat.id, success ? '🔴 Bot telah dimatikan.' : '❌ Gagal mematikan bot.');
});

bot.onText(/\/restartbot/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Me-restart bot...');
    const success = await sendPowerAction('restart');
    bot.sendMessage(msg.chat.id, success ? '🔄 Bot sedang proses restart...' : '❌ Gagal me-restart.');
});

bot.onText(/\/update/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(lastChatId, '⏳ Mengecek status server...');
    const status = await getServerStatus();
    if (status === 'offline') {
        bot.sendMessage(lastChatId, '⚠️ Server sedang Offline. Menyalakan server terlebih dahulu agar bisa update...');
        await sendPowerAction('start');
        setTimeout(() => global.botEvents.emit('console_command', 'git_pull'), 15000);
    } else {
        bot.sendMessage(lastChatId, '🚀 Mengirim perintah Git Pull ke bot WhatsApp...');
        global.botEvents.emit('console_command', 'git_pull');
    }
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');
    if (!number || number.length < 10) {
        return bot.sendMessage(lastChatId, '❌ Nomor tidak valid! Gunakan format: /pair 628xxx');
    }

    bot.sendMessage(lastChatId, `⏳ Menyiapkan Pairing Code untuk nomor: *${number}*...\nBot akan restart sejenak.`, { parse_mode: 'Markdown' });
    const status = await getServerStatus();
    if (status === 'offline') {
        bot.sendMessage(lastChatId, '⚠️ Server sedang Offline. Menyalakan server...');
        await sendPowerAction('start');
        setTimeout(() => global.botEvents.emit('console_command', `pair_bot ${number}`), 15000);
    } else {
        global.botEvents.emit('console_command', `pair_bot ${number}`);
    }
});

bot.onText(/\/addbot (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    
    const args = match[1].trim().split(/\s+/);
    if (args.length < 4) {
        return bot.sendMessage(lastChatId, '❌ Format salah! Gunakan: /addbot [nomor] [nama] [hari] [owner]\nContoh: /addbot 628123 Robby Bot 30 628999');
    }
    
    let phone = args[0].replace(/[^0-9]/g, '');
    let owner = args[args.length - 1].replace(/[^0-9]/g, '');
    let days = args[args.length - 2].replace(/[^0-9]/g, '');
    let name = args.slice(1, args.length - 2).join('_');
    
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    if (owner.startsWith('0')) owner = '62' + owner.slice(1);

    bot.sendMessage(lastChatId, `⏳ Menambahkan bot *${name.replace(/_/g, ' ')}* (${phone}) ke sistem...`, { parse_mode: 'Markdown' });
    global.botEvents.emit('console_command', `add_bot ${phone} ${name} ${days} ${owner}`);
});

bot.onText(/\/addbotqr (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    
    const args = match[1].trim().split(/\s+/);
    if (args.length < 4) {
        return bot.sendMessage(lastChatId, '❌ Format salah! Gunakan: /addbotqr [nomor] [nama] [hari] [owner]');
    }
    
    let phone = args[0].replace(/[^0-9]/g, '');
    let owner = args[args.length - 1].replace(/[^0-9]/g, '');
    let days = args[args.length - 2].replace(/[^0-9]/g, '');
    let name = args.slice(1, args.length - 2).join('_');
    
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    if (owner.startsWith('0')) owner = '62' + owner.slice(1);

    bot.sendMessage(lastChatId, `⏳ Menyiapkan QR Code untuk bot *${name.replace(/_/g, ' ')}* (${phone})...`, { parse_mode: 'Markdown' });
    global.botEvents.emit('console_command', `add_bot_qr ${phone} ${name} ${days} ${owner}`);
});

bot.onText(/\/listbots/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(lastChatId, '⏳ Mengambil daftar bot anak dari console...');
    global.botEvents.emit('console_command', 'list_bots');
});

bot.onText(/\/(delbot|delbots) (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    const target = match[2];
    bot.sendMessage(lastChatId, `⚠️ Menghapus bot *${target}* dan membersihkan sesi...`, { parse_mode: 'Markdown' });
    global.botEvents.emit('console_command', `delete_bot ${target}`);
});

bot.onText(/\/logout/, async (msg) => {
    if (!isOwner(msg)) return;
    lastChatId = msg.chat.id;
    bot.sendMessage(lastChatId, '⚠️ Sedang menghapus sesi bot (Logout)...');
    global.botEvents.emit('console_command', 'logout_bot');
    bot.sendMessage(lastChatId, '✅ Perintah Logout dikirim! Sesi akan dihapus dan bot akan mati.');
});

bot.onText(/\/logs/, async (msg) => {
    if (!isOwner(msg)) return;
    if (logBuffer.length === 0) {
        return bot.sendMessage(msg.chat.id, '📭 Belum ada log terbaru yang tertangkap.');
    }
    const logText = logBuffer.join('\n');
    bot.sendMessage(msg.chat.id, `📋 *LAST CONSOLE LOGS:*\n\n\`\`\`\n${logText.slice(-4000)}\n\`\`\``, { parse_mode: 'Markdown' });
});

console.log('✅ Telegram Bot Control is ONLINE!');

