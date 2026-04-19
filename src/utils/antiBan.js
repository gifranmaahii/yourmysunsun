const { logger } = require('./logger');

/**
 * Delay random antara min dan max milidetik
 * Untuk meniru perilaku manusia dan menghindari deteksi bot
 */
async function randomDelay(min = 2000, max = 5000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    logger.info(`⏳ Anti-ban delay: ${delay}ms`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Simulasi typing indicator sebelum mengirim pesan
 * WA akan menunjukkan "sedang mengetik..." di sisi penerima
 */
async function simulateTyping(sock, jid, durationMs = 2000) {
    try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(resolve => setTimeout(resolve, durationMs));
        await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
        // Tidak fatal, lanjut saja
        logger.warn('⚠️ Gagal simulasi typing (tidak fatal)');
    }
}

/**
 * Rate Limiter - batasi jumlah aksi per menit
 * Mencegah bot mengirim terlalu banyak pesan dalam waktu singkat
 */
class RateLimiter {
    constructor(maxActions = 15, windowMs = 60000) {
        this.maxActions = maxActions;
        this.windowMs = windowMs;
        this.actions = [];
    }

    /**
     * Cek apakah masih bisa melakukan aksi
     * @returns {boolean} true jika masih dalam batas, false jika sudah limit
     */
    canProceed() {
        const now = Date.now();
        // Hapus aksi yang sudah lewat window
        this.actions = this.actions.filter(time => now - time < this.windowMs);

        if (this.actions.length >= this.maxActions) {
            logger.warn(`🚫 Rate limit tercapai (${this.maxActions} aksi/${this.windowMs / 1000}s)`);
            return false;
        }

        this.actions.push(now);
        return true;
    }

    /**
     * Waktu tunggu sampai bisa melakukan aksi lagi (dalam ms)
     */
    getWaitTime() {
        if (this.actions.length === 0) return 0;
        const oldest = Math.min(...this.actions);
        const waitTime = this.windowMs - (Date.now() - oldest);
        return Math.max(0, waitTime);
    }
}

// Singleton rate limiter instance
const rateLimiter = new RateLimiter(15, 60000);

/**
 * Cek apakah pesan harus diproses
 * Filter pesan lama (> 60 detik) dan pesan dari diri sendiri
 */
function shouldProcess(msg, sock) {
    // Ignore pesan dari bot sendiri
    if (msg.key.fromMe) return false;

    // Ignore pesan broadcast/status
    if (msg.key.remoteJid === 'status@broadcast') return false;

    // Ignore pesan lama (lebih dari 5 menit / 300 detik)
    const messageTimestamp = msg.messageTimestamp;
    if (messageTimestamp) {
        const msgTime = typeof messageTimestamp === 'number'
            ? messageTimestamp
            : parseInt(messageTimestamp.toString());
        const now = Math.floor(Date.now() / 1000);
        if (now - msgTime > 300) {
            logger.info(`🕐 Skip pesan lama: ${now - msgTime}s yang lalu`);
            return false;
        }
    }

    return true;
}

module.exports = {
    randomDelay,
    simulateTyping,
    rateLimiter,
    shouldProcess,
    RateLimiter
};
