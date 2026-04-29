const { downloadContentFromMessage, generateWAMessageContent, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, '../../temp');

// Pastikan folder temp ada
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Map untuk menyimpan data sementara user yang ingin upload status
const pendingSwgc = new Map();

/**
 * Fitur Upload Status/Story Grup WhatsApp
 * 
 * Command: .upsw / .swgc [teks/media]
 */
async function handleStatusUpdate(sock, msg, textContent, remoteJid, isOwner) {
    const prefix = require('../utils/config').getConfig().prefix || '.';
    const sender = msg.key.participant || msg.key.remoteJid;

    if (!textContent.startsWith(prefix + 'upsw') && !textContent.startsWith(prefix + 'tagsw') && !textContent.startsWith(prefix + 'swgc')) return false;

    const isTagSw = textContent.startsWith(prefix + 'tagsw');
    const isSwgc = textContent.startsWith(prefix + 'swgc');
    const command = isSwgc ? 'swgc' : (isTagSw ? 'tagsw' : 'upsw');
    
    console.log(`[Status] Command detected: ${textContent}`);

    if (!isOwner) return false;

    const args = textContent.trim().split(/\s+/);

    // ═══════════════════════════════════════════════════════════
    // FASE 2: KONFIRMASI PENGIRIMAN KE GRUP TARGET
    // ═══════════════════════════════════════════════════════════
    if (args[1] === '--confirm' && args[2]) {
        const targetGroupId = args[2];
        const pendingData = pendingSwgc.get(sender);

        if (!pendingData) {
            await sock.sendMessage(remoteJid, { text: `⚠️ *Tidak ada data pending.*` }, { quoted: msg });
            return true;
        }

        try {
            console.log(`[Status] Confirming story for ${targetGroupId}`);
            let groupName = 'Grup';
            let isBotAdmin = false;
            try {
                const meta = await sock.groupMetadata(targetGroupId);
                groupName = meta.subject;
                const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const me = meta.participants.find(p => p.id === botId);
                isBotAdmin = !!(me && me.admin);
                console.log(`[Status] Metadata fetched for ${groupName}. BotAdmin: ${isBotAdmin}`);
            } catch (e) {
                console.error(`[Status] Metadata fetch failed: ${e.message}`);
            }

            if (!isBotAdmin) {
                await sock.sendMessage(remoteJid, { text: `⚠️ *Peringatan*: Bot bukan Admin di grup ${groupName}. Story mungkin gagal.` }, { quoted: msg });
            } else {
                await sock.sendMessage(remoteJid, { text: `⏳ *Posting group story ke ${groupName}...*` }, { quoted: msg });
            }

            const { rawContent, mediaType, isTagSw } = pendingData;
            
            let inside;
            if (mediaType === 'text') {
                inside = rawContent;
            } else {
                // Ensure viewOnce is set for media status
                rawContent.viewOnce = true;
                inside = await generateWAMessageContent(rawContent, {
                    upload: sock.waUploadToServer
                });
            }

            // Handle Mentions if isTagSw is true
            let mentionedJid = [];
            if (isTagSw) {
                try {
                    const meta = await sock.groupMetadata(targetGroupId);
                    mentionedJid = meta.participants.map(p => p.id);
                } catch (e) {}
            }

            const messageSecret = crypto.randomBytes(32);
            const msgId = 'SGS' + crypto.randomBytes(8).toString('hex').toUpperCase();
            
            const type = Object.keys(inside)[0];
            const innerMessage = {
                ...inside,
                [type]: {
                    ...(inside[type] || {}),
                    contextInfo: {
                        ...(inside[type]?.contextInfo || {}),
                        mentionedJid
                    }
                },
                messageContextInfo: { 
                    messageSecret,
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                }
            };

            const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            // ATTEMPT 1: Binary Node (Low level)
            try {
                console.log(`[Status] Attempting send via binary node...`);
                await sock.query({
                    tag: 'message',
                    attrs: { 
                        to: targetGroupId, 
                        id: msgId,
                        participant: botJid,
                        type: 'text'
                    },
                    content: [
                        {
                            tag: 'groupStatusMessage',
                            attrs: {},
                            content: proto.Message.encode({ message: innerMessage }).finish()
                        }
                    ]
                });
                console.log(`[Status] ✅ Sent via binary node`);
            } catch (err) {
                console.error(`[Status] Binary node failed: ${err.message}. Trying relayMessage...`);
                // ATTEMPT 2: relayMessage (High level)
                await sock.relayMessage(targetGroupId, {
                    groupStatusMessage: {
                        message: innerMessage
                    }
                }, { 
                    messageId: msgId,
                    participant: { jid: botJid }
                });
                console.log(`[Status] ✅ Sent via relayMessage`);
            }
            
            await sock.sendMessage(remoteJid, { 
                text: `✅ *ɢʀᴏᴜᴘ sᴛᴏʀʏ ᴅɪᴘᴏsᴛ*\n\n` +
                      `> Grup: *${groupName}*\n` +
                      `> Tipe: *${mediaType.toUpperCase()}*\n` +
                      `> ID: \`${msgId}\`\n\n` +
                      `_Cek profil grup, harusnya ring hijau sudah muncul._` 
            }, { quoted: msg });
            
            pendingSwgc.delete(sender);
            if (pendingData.tempFile && fs.existsSync(pendingData.tempFile)) {
                setTimeout(() => { try { fs.unlinkSync(pendingData.tempFile); } catch (e) {} }, 5000);
            }
        } catch (error) {
            console.error('[StatusError]', error);
            let errMsg = error.message;
            if (errMsg === 'not-acceptable') {
                errMsg = 'Status rejected (not-acceptable). Pastikan bot adalah Admin dan belum mencapai limit story harian.';
            }
            await sock.sendMessage(remoteJid, { text: `❌ *ᴇʀʀᴏʀ*\n\n> ${errMsg}` }, { quoted: msg });
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // FASE 1: MENYIMPAN MEDIA & MENAMPILKAN DAFTAR GRUP
    // ═══════════════════════════════════════════════════════════
    let statusText = args.slice(1).join(' ').trim();
    let message = msg.message;
    if (message?.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message?.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message?.viewOnceMessageV2) message = message.viewOnceMessageV2.message;

    const quotedMsg = message?.extendedTextMessage?.contextInfo?.quotedMessage;
    
    let mediaMessage = null;
    let mediaType = 'text';
    
    if (message?.imageMessage) {
        mediaMessage = message.imageMessage; mediaType = 'image';
        if (!statusText) statusText = message.imageMessage.caption || '';
    } else if (message?.videoMessage) {
        mediaMessage = message.videoMessage; mediaType = 'video';
        if (!statusText) statusText = message.videoMessage.caption || '';
    } else if (message?.audioMessage) {
        mediaMessage = message.audioMessage; mediaType = 'audio';
    } else if (quotedMsg) {
        if (quotedMsg.imageMessage) { mediaMessage = quotedMsg.imageMessage; mediaType = 'image'; }
        else if (quotedMsg.videoMessage) { mediaMessage = quotedMsg.videoMessage; mediaType = 'video'; }
        else if (quotedMsg.audioMessage) { mediaMessage = quotedMsg.audioMessage; mediaType = 'audio'; }
    }

    if (!mediaMessage && !statusText) {
        await sock.sendMessage(remoteJid, { text: `💡 *Cara Pakai ${prefix}${command}*:\n\n1️⃣ Teks: ${prefix}${command} [teks]\n2️⃣ Media: Reply media + ${prefix}${command}` }, { quoted: msg });
        return true;
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Memproses...' }, { quoted: msg });

    let rawContent = {};
    let tempFile = null;

    if (mediaMessage) {
        const stream = await downloadContentFromMessage(mediaMessage, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length === 0) return await sock.sendMessage(remoteJid, { text: '❌ Gagal unduh.' });

        if (mediaType === 'image') {
            rawContent = { image: buffer, caption: statusText || '', viewOnce: true };
        } else if (mediaType === 'video') {
            rawContent = { video: buffer, caption: statusText || '', viewOnce: true };
        } else {
            rawContent = { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, viewOnce: true };
        }
    } else {
        rawContent = { 
            extendedTextMessage: {
                text: statusText,
                font: 1,
                backgroundArgb: 0xff128c7e,
                textArgb: 0xffffffff,
            }
        };
    }

    pendingSwgc.set(sender, { rawContent, tempFile, mediaType, isTagSw });

    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.entries(groups);
        if (groupList.length === 0) return await sock.sendMessage(remoteJid, { text: `⚠️ Bot tidak ada di grup.` });

        const groupRows = groupList.map(([id, meta]) => ({
            title: meta.subject || 'Unknown',
            id: `${prefix}${command} --confirm ${id}`
        }));

        let text = `📋 *ᴘɪʟɪʜ ɢʀᴜᴘ ᴜɴᴛᴜᴋ sᴛᴏʀʏ*\n\n`;
        groupList.forEach(([id, meta], i) => text += `${i+1}. *${meta.subject}*\n   ID: \`${id}\`\n`);
        text += `\n_Salin ID grup dan ketik:_ \n*${prefix}${command} --confirm <ID_GRUP>*`;

        // Format yang lebih kompatibel untuk daftar grup
        await sock.sendMessage(remoteJid, {
            text,
            contextInfo: {
                externalAdReply: {
                    title: 'Group Story Dispatcher',
                    body: `Ditemukan ${groupList.length} grup`,
                    thumbnailUrl: 'https://files.catbox.moe/nwvkbt.png',
                    sourceUrl: '',
                    mediaType: 1,
                    renderLargerThumbnail: false
                }
            }
        }, { quoted: msg });

    } catch (error) {
        await sock.sendMessage(remoteJid, { text: `❌ ${error.message}` });
    }

    return true;
}

module.exports = { handleStatusUpdate };
