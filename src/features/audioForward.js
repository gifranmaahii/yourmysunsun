const { logger } = require('../utils/logger');
const { randomDelay } = require('../utils/antiBan');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

/**
 * Forward pesan audio ke saluran/channel WhatsApp
 * 
 * @param {object} sock - Baileys socket instance
 * @param {object} msg - Pesan yang berisi audio
 * @param {string} channelJid - JID saluran target
 */
async function forwardAudioToChannel(sock, msg, channelJid) {
    try {
        if (!channelJid) {
            logger.warn('⚠️ CHANNEL_JID belum diatur di .env, audio tidak di-forward');
            return;
        }

        // Download audio dari pesan
        const audioBuffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
                logger: require('pino')({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
            }
        );

        if (!audioBuffer) {
            logger.error('❌ Gagal download audio dari pesan');
            return;
        }

        // Anti-ban delay sebelum forward
        await randomDelay(1000, 3000);

        // Cek tipe audio (voice note atau audio file)
        const audioMsg = msg.message?.audioMessage;
        const isVoiceNote = audioMsg?.ptt || false;

        // Kirim audio ke saluran
        await sock.sendMessage(channelJid, {
            audio: audioBuffer,
            mimetype: audioMsg?.mimetype || 'audio/ogg; codecs=opus',
            ptt: isVoiceNote, // Pertahankan format voice note jika aslinya VN
        });

        const senderJid = msg.key.remoteJid;
        const senderName = msg.pushName || senderJid;
        logger.info(`🔊 Audio dari ${senderName} berhasil di-forward ke saluran`);

    } catch (err) {
        logger.error(`❌ Gagal forward audio ke saluran: ${err.message}`);
    }
}

/**
 * Cek apakah pesan berisi audio
 */
function isAudioMessage(msg) {
    const message = msg.message;
    if (!message) return false;

    return !!(
        message.audioMessage ||
        message.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage
    );
}

/**
 * Cek apakah pesan berasal dari sumber yang diizinkan
 * Berdasarkan konfigurasi FORWARD_FROM di .env
 */
function isFromAllowedSource(msg, forwardFrom) {
    // Jika FORWARD_FROM kosong, terima dari semua chat
    if (!forwardFrom || forwardFrom.trim() === '') {
        return true;
    }

    return msg.key.remoteJid === forwardFrom;
}

module.exports = {
    forwardAudioToChannel,
    isAudioMessage,
    isFromAllowedSource
};
