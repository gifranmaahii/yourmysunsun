const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env_telegram') });

// Konfigurasi
const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.PTERODACTYL_API_KEY;
const serverId = process.env.PTERODACTYL_SERVER_ID;
const baseUrl = process.env.PTERODACTYL_BASE_URL;

const bot = new TelegramBot(token, { polling: true });

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

// ==========================================
// COMMAND HANDLERS
// ==========================================

bot.onText(/\/start/, (msg) => {
    const welcome = `👋 Halo! Saya Bot Pengendali Panel.\n\n` +
        `Gunakan perintah berikut:\n` +
        `🔹 /status - Cek status bot\n` +
        `🔹 /startbot - Nyalakan bot\n` +
        `🔹 /stopbot - Matikan bot\n` +
        `🔹 /restartbot - Restart bot\n` +
        `🔹 /update - Git Pull (Tarik kodingan baru)\n` +
        `🔹 /login - Tampilkan QR (Restart)\n` +
        `🔹 /logout - Hapus Sesi (Logout Total)\n` +
        `🔹 /logs - Lihat log console terakhir`;
    bot.sendMessage(msg.chat.id, welcome);
});

bot.onText(/\/status/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ Menghubungi panel...');
    const status = await getServerStatus();
    const emoji = status === 'running' ? '🟢' : status === 'offline' ? '🔴' : '🟡';
    bot.sendMessage(msg.chat.id, `${emoji} *Status Server:* ${status.toUpperCase()}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/startbot/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ Mencoba menyalakan bot...');
    const success = await sendPowerAction('start');
    bot.sendMessage(msg.chat.id, success ? '✅ Bot sedang proses booting...' : '❌ Gagal menyalakan bot.');
});

bot.onText(/\/stopbot/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ Mencoba mematikan bot...');
    const success = await sendPowerAction('stop');
    bot.sendMessage(msg.chat.id, success ? '🔴 Bot telah dimatikan.' : '❌ Gagal mematikan bot.');
});

bot.onText(/\/restartbot/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ Me-restart bot...');
    const success = await sendPowerAction('restart');
    bot.sendMessage(msg.chat.id, success ? '🔄 Bot sedang proses restart...' : '❌ Gagal me-restart.');
});

bot.onText(/\/update/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '⏳ Mengecek status server...');
    
    const status = await getServerStatus();
    
    if (status === 'offline') {
        bot.sendMessage(chatId, '⚠️ Server sedang Offline. Menyalakan server terlebih dahulu agar bisa update...');
        await sendPowerAction('start');
        bot.sendMessage(chatId, '⏳ Tunggu 15 detik sampai server benar-benar ONLINE...');
        return;
    }

    bot.sendMessage(chatId, '🚀 Mengirim perintah Git Pull ke bot WhatsApp...');
    const success = await sendCommand('git_pull');
    
    if (success) {
        bot.sendMessage(chatId, '✅ Perintah diterima! Bot akan menarik update dan melakukan restart otomatis dalam 10-20 detik.');
    } else {
        bot.sendMessage(chatId, '❌ Gagal mengirim perintah. Pastikan status bot adalah RUNNING.');
    }
});

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '⏳ Me-restart bot untuk memicu QR Code baru...');
    await sendPowerAction('restart');
    bot.sendMessage(chatId, '✅ Bot sedang restart. Silakan pantau console panel kamu untuk scan QR Code atau pairing code.');
});

bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '⚠️ Sedang menghapus sesi bot (Logout)...');
    const status = await getServerStatus();
    
    if (status === 'offline') {
        bot.sendMessage(chatId, '❌ Server Offline. Menyalakan sejenak untuk menghapus sesi...');
        await sendPowerAction('start');
        setTimeout(() => sendCommand('logout_bot'), 10000);
    } else {
        await sendCommand('logout_bot');
    }
    bot.sendMessage(chatId, '✅ Perintah Logout dikirim! Sesi akan dihapus dan bot akan mati.');
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
