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

const bot = new TelegramBot(token, { polling: true });
let lastChatId = null;

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

// ==========================================
// WEBSOCKET LOG MONITORING (Zero Panel)
// ==========================================
let ws = null;

async function connectToConsole() {
    try {
        const res = await ptero.get('/websocket');
        const { data } = res.data;
        
        ws = new WebSocket(data.socket, {
            origin: baseUrl
        });
        
        ws.on('open', () => {
            ws.send(JSON.stringify({ event: 'auth', args: [data.token] }));
            console.log('📡 Connected to Panel Console via WebSocket');
        });

        ws.on('message', (msg) => {
            const payload = JSON.parse(msg);
            if (payload.event === 'console output') {
                const text = payload.args[0];
                
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
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`📡 WebSocket Closed (Code: ${code}). Reconnecting in 15s...`);
            setTimeout(connectToConsole, 15000);
        });

        ws.on('error', (err) => {
            console.error('❌ WebSocket Error:', err.message);
            if (err.message.includes('403')) {
                console.log('💡 Tip: WebSocket 403 might mean the API key lacks console permissions or Origin header mismatch.');
            }
        });

    } catch (e) {
        const delay = e.response?.status === 429 ? 30000 : 10000;
        console.error(`❌ Failed to connect to WebSocket: ${e.message}`);
        console.log(`📡 Retrying in ${delay/1000}s...`);
        setTimeout(connectToConsole, delay);
    }
}

connectToConsole();

// ==========================================
// COMMAND HANDLERS
// ==========================================

bot.onText(/\/start/, (msg) => {
    lastChatId = msg.chat.id;
    const welcome = `👋 Halo! Saya Bot Pengendali Panel.\n\n` +
        `Gunakan perintah berikut:\n` +
        `🔹 /status - Cek status bot\n` +
        `🔹 /startbot - Nyalakan bot\n` +
        `🔹 /stopbot - Matikan bot\n` +
        `🔹 /restartbot - Restart bot\n` +
        `🔹 /update - Git Pull (Tarik kodingan baru)\n` +
        `🔹 /pair [nomor] - Login pake Pairing Code\n` +
        `🔹 /logout - Hapus Sesi (Logout Total)\n` +
        `🔹 /logs - Lihat log console terakhir`;
    bot.sendMessage(msg.chat.id, welcome);
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

// Handlers moved below to avoid duplicates

bot.onText(/\/status/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Menghubungi panel...');
    const status = await getServerStatus();
    const emoji = status === 'running' ? '🟢' : status === 'offline' ? '🔴' : '🟡';
    bot.sendMessage(msg.chat.id, `${emoji} *Status Server:* ${status.toUpperCase()}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/startbot/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Mencoba menyalakan bot...');
    const success = await sendPowerAction('start');
    bot.sendMessage(msg.chat.id, success ? '✅ Bot sedang proses booting...' : '❌ Gagal menyalakan bot.');
});

bot.onText(/\/stopbot/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Mencoba mematikan bot...');
    const success = await sendPowerAction('stop');
    bot.sendMessage(msg.chat.id, success ? '🔴 Bot telah dimatikan.' : '❌ Gagal mematikan bot.');
});

bot.onText(/\/restartbot/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(msg.chat.id, '⏳ Me-restart bot...');
    const success = await sendPowerAction('restart');
    bot.sendMessage(msg.chat.id, success ? '🔄 Bot sedang proses restart...' : '❌ Gagal me-restart.');
});

bot.onText(/\/update/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(lastChatId, '⏳ Mengecek status server...');
    const status = await getServerStatus();
    if (status === 'offline') {
        bot.sendMessage(lastChatId, '⚠️ Server sedang Offline. Menyalakan server terlebih dahulu agar bisa update...');
        await sendPowerAction('start');
        setTimeout(() => sendCommand('git_pull'), 15000);
    } else {
        bot.sendMessage(lastChatId, '🚀 Mengirim perintah Git Pull ke bot WhatsApp...');
        await sendCommand('git_pull');
    }
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
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
        setTimeout(() => sendCommand(`pair_bot ${number}`), 15000);
    } else {
        await sendCommand(`pair_bot ${number}`);
    }
});

bot.onText(/\/logout/, async (msg) => {
    lastChatId = msg.chat.id;
    bot.sendMessage(lastChatId, '⚠️ Sedang menghapus sesi bot (Logout)...');
    await sendCommand('logout_bot');
    bot.sendMessage(lastChatId, '✅ Perintah Logout dikirim! Sesi akan dihapus dan bot akan mati.');
});

bot.onText(/\/logs/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ Mengambil log console...');
    // Pterodactyl tidak punya endpoint direct untuk logs via API Client v1 secara mudah tanpa websocket,
    // tapi kita bisa simulasi atau pakai cara lain. 
    // Untuk saat ini, kita beri info status saja.
    const status = await getServerStatus();
    bot.sendMessage(msg.chat.id, `Saat ini server berstatus: ${status}. Silakan cek panel untuk detail log lengkap.`);
});

console.log('✅ Telegram Bot Control is ONLINE!');
