const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const SETTINGS_PATH = path.join(__dirname, '../../data/group_settings.json');
const WARN_DATA_PATH = path.join(__dirname, '../../data/warn_data.json');
const BLACKLIST_PATH = path.join(__dirname, '../../data/blacklist_data.json');
const SEWA_PATH = path.join(__dirname, '../../data/sewa.json');
const afkDataPath = path.join(__dirname, '../../data/afkData.json');
const absenDataPath = path.join(__dirname, '../../data/absenData.json');
const listDataPath = path.join(__dirname, '../../data/listData.json');

let groupSettings = {};
let warnData = {};
let blacklistData = {};
let sewaData = {};
let afkData = {};
let absenData = {};
let listData = {};

if (fs.existsSync(SETTINGS_PATH)) { try { groupSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) { } }
if (fs.existsSync(WARN_DATA_PATH)) { try { warnData = JSON.parse(fs.readFileSync(WARN_DATA_PATH, 'utf8')); } catch (e) { } }
if (fs.existsSync(BLACKLIST_PATH)) { try { blacklistData = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8')); } catch (e) { } }
if (fs.existsSync(SEWA_PATH)) { try { sewaData = JSON.parse(fs.readFileSync(SEWA_PATH, 'utf8')); } catch (e) { } }
if (fs.existsSync(afkDataPath)) { try { afkData = JSON.parse(fs.readFileSync(afkDataPath, 'utf8')); } catch (e) { } }
if (fs.existsSync(absenDataPath)) { try { absenData = JSON.parse(fs.readFileSync(absenDataPath, 'utf8')); } catch (e) { } }
if (fs.existsSync(listDataPath)) { try { listData = JSON.parse(fs.readFileSync(listDataPath, 'utf8')); } catch (e) { } }

const saveSettings = () => fs.writeFileSync(SETTINGS_PATH, JSON.stringify(groupSettings, null, 2));
const saveWarnData = () => fs.writeFileSync(WARN_DATA_PATH, JSON.stringify(warnData, null, 2));
const saveBlacklistData = () => fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(blacklistData, null, 2));
const saveSewaData = () => fs.writeFileSync(SEWA_PATH, JSON.stringify(sewaData, null, 2));
const saveAfkData = () => fs.writeFileSync(afkDataPath, JSON.stringify(afkData, null, 2));
const saveAbsenData = () => fs.writeFileSync(absenDataPath, JSON.stringify(absenData, null, 2));
const saveListData = () => fs.writeFileSync(listDataPath, JSON.stringify(listData, null, 2));

function getGroupSettings(jid) {
    return groupSettings[jid] || {};
}

function saveGroupSettings(jid, settings) {
    groupSettings[jid] = settings;
    saveSettings();
}

const getMentionedOrQuoted = (msg, args) => {
    // Unwrapping logic (sama dengan index.js)
    let message = msg.message;
    if (message?.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message?.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message?.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
    if (message?.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;
    if (message?.editedMessage?.message?.protocolMessage?.editedMessage) message = message.editedMessage.message.protocolMessage.editedMessage;

    if (!message) return [];

    const content = message.extendedTextMessage || message.imageMessage || message.videoMessage || message.stickerMessage || message.documentMessage || message;
    const contextInfo = content?.contextInfo;

    // 1. Dari Mentions (@)
    const mentioned = contextInfo?.mentionedJid || [];
    if (mentioned.length > 0) return mentioned;

    // 2. Dari Quoted Message (Reply)
    const quoted = contextInfo?.participant;
    if (quoted) return [quoted];

    // 3. Dari Argumen Teks (Nomor HP)
    let textNum = args[1] ? args[1].replace(/[^0-9]/g, '') : null;
    if (textNum && textNum.length >= 9) {
        // Normalisasi 08xx -> 628xx
        if (textNum.startsWith('0')) textNum = '62' + textNum.slice(1);
        return [textNum + '@s.whatsapp.net'];
    }

    return [];
};

async function handleGroupModeration(sock, msg, textContent, remoteJid, fromMe) {
    if (!remoteJid.endsWith('@g.us')) return;
    if (fromMe) return; 

    const sender = msg.key.participant || msg.key.remoteJid;
    
    // --- CHECK SEWA / PUBLIC MODE ---
    const globalCfg = require('../utils/config').getConfig();
    const isPublic = globalCfg.ownerdewasa;
    const isRented = sewaData[remoteJid] && sewaData[remoteJid].expire > Date.now();
    const isActiveGroup = isPublic || isRented;

    const settings = groupSettings[remoteJid] || {};

    // Fitur moderasi yang SELALU aktif (tidak butuh sewa/public)
    const hasAnyProtection = settings.antilink || settings.antilinkgc || settings.antilinkch || 
                             settings.antibadword || settings.antidelete || settings.antiviewonce ||
                             settings.antibot || settings.welcome || settings.left;
    if (!isActiveGroup && !hasAnyProtection) return;

    // --- CHECK BLACKLIST ---
    if (isActiveGroup && blacklistData[remoteJid] && blacklistData[remoteJid].includes(sender)) {
        await sock.groupParticipantsUpdate(remoteJid, [sender], 'remove');
        return;
    }
    
    // 1. Deteksi Link (Semua HTTP/HTTPS)
    const hasAllLink = textContent.match(/https?:\/\/[^\s]+/gi);
    
    // 2. Deteksi Link WhatsApp Group
    const hasGcLink = textContent.match(/chat\.whatsapp\.com\/[a-zA-Z0-9]/i) || 
                      textContent.match(/wa\.me\//i);
    
    // 3. Deteksi Forward dari Saluran (Channel)
    const msgContent = msg.message || {};
    const contextInfo = msgContent.extendedTextMessage?.contextInfo || 
                        msgContent.imageMessage?.contextInfo || 
                        msgContent.videoMessage?.contextInfo || 
                        msgContent.documentMessage?.contextInfo ||
                        msgContent.audioMessage?.contextInfo ||
                        msgContent.stickerMessage?.contextInfo ||
                        msgContent.contactMessage?.contextInfo ||
                        msgContent.locationMessage?.contextInfo ||
                        msgContent.viewOnceMessage?.message?.imageMessage?.contextInfo ||
                        msgContent.viewOnceMessage?.message?.videoMessage?.contextInfo ||
                        msgContent.viewOnceMessageV2?.message?.imageMessage?.contextInfo ||
                        msgContent.viewOnceMessageV2?.message?.videoMessage?.contextInfo ||
                        msgContent.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                        {};
    const isForwardedChannel = !!(
        contextInfo.forwardedNewsletterMessageInfo ||
        contextInfo.newsletterParentKey ||
        (contextInfo.externalAdReply?.containsAutoReply === false && contextInfo.externalAdReply?.renderLargerThumbnail)
    );
    if (settings.antilinkch) {
        const msgKeys = Object.keys(msg.message || {});
        const ctxKeys = Object.keys(contextInfo);
        console.log(`[ANTICH DEBUG] msgKeys=${JSON.stringify(msgKeys)} isForwarded=${contextInfo.isForwarded} score=${contextInfo.forwardingScore} newsletterInfo=${!!contextInfo.forwardedNewsletterMessageInfo} newsletterKey=${!!contextInfo.newsletterParentKey} detected=${isForwardedChannel} ctxKeys=${JSON.stringify(ctxKeys)}`);
    }

    let isAdmin = false;
    let botIsAdmin = false;
    try {
        const metadata = await sock.groupMetadata(remoteJid);
        const clean = require('../utils/config').cleanNumber;
        const cleanSender = clean(sender);
        
        const p = metadata.participants.find(x => clean(x.id) === cleanSender);
        isAdmin = p ? (p.admin === 'admin' || p.admin === 'superadmin') : false;

        const myJid = clean(sock.user.id);
        const botP = metadata.participants.find(x => clean(x.id) === myJid);
        botIsAdmin = botP ? (botP.admin === 'admin' || botP.admin === 'superadmin') : false;
    } catch (e) { }

    if (isAdmin) return;

    let isViolating = false;
    let violationReason = '';

    // Cek Pelanggaran Berdasarkan Setting
    if (settings.antilink && hasAllLink) {
        isViolating = true;
        violationReason = 'Mengirim Link';
    } else if (settings.antilinkgc && hasGcLink) {
        isViolating = true;
        violationReason = 'Mengirim Link Grup WA';
    } else if (settings.antilinkch && isForwardedChannel) {
        isViolating = true;
        violationReason = 'Forward dari Saluran';
    }

    if (isViolating) {
        if (!botIsAdmin) {
            console.log(`⚠️ [Moderasi] Pelanggaran terdeteksi tapi bot bukan admin di ${remoteJid}`);
            return;
        }

        // 1. Hapus Pesan
        await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});

        // 2. Kick jika antikick ON
        if (settings.antikick) {
            await sock.sendMessage(remoteJid, { text: `🚫 *ANTILINK SYSTEM*\n\nMaaf @user, kamu melanggar aturan: *${violationReason}*.\nSesuai pengaturan grup, kamu akan dikeluarkan.`, mentions: [sender] });
            await sock.groupParticipantsUpdate(remoteJid, [sender], "remove").catch(() => { });
        }
    }
}

// handleGroupParticipantsUpdate removed because of duplicate at the end of file

async function handleGroupCommand(sock, msg, textContent, remoteJid, isBotOwner) {
    if (!remoteJid.endsWith('@g.us')) return false;

    const args = textContent.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    
    const prefix = require('../utils/config').getConfig().prefix || '.';

    const sender = msg.key.participant || msg.key.remoteJid;

    // --- CHECK GLOBAL MODE (Restricted vs Public) ---
    const globalCfg = require('../utils/config').getConfig();
    const isPublic = globalCfg.ownerdewasa;
    const isRented = sewaData[remoteJid] && sewaData[remoteJid].expire > Date.now();

    // Jika bukan owner dan mode publik MATI, cek apakah grup sudah sewa
    if (!isBotOwner && !isPublic && !isRented && command.startsWith(prefix)) {
        // Daftar perintah yang tetap boleh diakses meskipun belum sewa (opsional)
        const whiteList = [prefix + 'ceksewa', prefix + 'owner']; 
        if (!whiteList.includes(command)) {
            await sock.sendMessage(remoteJid, { text: `🚫 *AKSES DIBATASI*\n\nGrup ini belum terdaftar dalam sistem sewa. Silakan hubungi Owner untuk menyewa bot agar semua fitur bisa digunakan.` });
            return true;
        }
    }

    if (afkData[sender]) {
        const data = afkData[sender];
        const duration = Date.now() - data.time;
        const timeStr = formatDuration(duration);
        delete afkData[sender];
        saveAfkData();
        await sock.sendMessage(remoteJid, { text: `✨ *Sambut Kembali!* @${sender.split('@')[0]} sudah tidak AFK.\n\n📝 Alasan: ${data.reason}\n⏳ Durasi: ${timeStr}`, mentions: [sender] }, { quoted: msg });
    }

    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    for (const jid of mentions) {
        if (afkData[jid]) {
            const data = afkData[jid];
            const duration = Date.now() - data.time;
            const timeStr = formatDuration(duration);
            await sock.sendMessage(remoteJid, { text: `🚫 *Sedang AFK!* @${jid.split('@')[0]} sedang tidak ditempat.\n\n📝 Alasan: ${data.reason}\n⏳ Sejak: ${timeStr} yang lalu`, mentions: [jid] }, { quoted: msg });
        }
    }

    const groupCommands = [
        prefix + 'kick', prefix + 'add', prefix + 'promote', prefix + 'demote', prefix + 'setnamegc', prefix + 'setdescgc', prefix + 'setopen', prefix + 'setclose',
        prefix + 'hidetag', prefix + 'tagall', prefix + 'leavegc', prefix + 'linkgc', prefix + 'revokelink', prefix + 'groupinfo', prefix + 'welcome', prefix + 'setwelcome', 
        prefix + 'left', prefix + 'setleft', prefix + 'antilink', prefix + 'antilinkgc', prefix + 'antilinkch', prefix + 'antikick', prefix + 'antibadword', prefix + 'antibadwordnokick', 
        prefix + 'addbadword', prefix + 'delbadword', prefix + 'listbadword', prefix + 'resetbadword',
        prefix + 'afk', prefix + 'antidelete', prefix + 'antiviewonce',
        prefix + 'absen', prefix + 'cekabsen', prefix + 'deleteabsen', prefix + 'mulaiabsen',
        prefix + 'addlist', prefix + 'dellist', prefix + 'list',
        prefix + 'warn', prefix + 'cekwarn', prefix + 'delwarn', prefix + 'listwarn',
        prefix + 'blacklist', prefix + 'delblacklist', prefix + 'listblacklist',
        prefix + 'addsewa', prefix + 'ceksewa', prefix + 'delsewa', prefix + 'listsewa',
        prefix + 'antibot', prefix + 'antibot_kick', 
        prefix + 'automute', prefix + 'setmute', prefix + 'setunmute',
        prefix + 'setppgc', prefix + 'ownerdewasa', prefix + 'settings', prefix + 'ceksetting'
    ];

    // --- HANDLE LIST (Custom Response) ---
    if (listData[remoteJid] && listData[remoteJid][command.slice(prefix.length)]) {
        const response = listData[remoteJid][command.slice(prefix.length)];
        await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
        return true;
    }

    if (!groupCommands.includes(command)) return false;

    let isAdmin = false;
    let botIsAdmin = false;
    
    try {
        let metadata = await sock.groupMetadata(remoteJid);
        let participants = metadata.participants;
        
        // --- NORMALISASI JID ---
        const clean = (jid) => require('../utils/config').cleanNumber(jid);
        const cleanSender = clean(msg.key.participant || msg.key.remoteJid);
        
        const findParticipant = (list, targetClean) => {
            return list.find(x => {
                const cleanXid = clean(x.id);
                if (cleanXid === targetClean) return true;
                // Support LID check if available in metadata
                if (x.lid && clean(x.lid) === targetClean) return true;
                return false;
            });
        };

        // 1. Cek User Admin
        const p = findParticipant(participants, cleanSender);
        isAdmin = p ? (p.admin === 'admin' || p.admin === 'superadmin') : false;
        
        // 2. Cek Bot Admin
        const myJid = clean(sock.user.id);
        const myLid = sock.user.lid ? clean(sock.user.lid) : null;
        
        const botP = participants.find(x => {
            const cleanXid = clean(x.id);
            const isMatch = cleanXid === myJid || (myLid && cleanXid === myLid) || (x.lid && clean(x.lid) === myJid) || (x.lid && myLid && clean(x.lid) === myLid);
            return isMatch;
        });
        
        botIsAdmin = botP ? (botP.admin === 'admin' || botP.admin === 'superadmin') : false;

        // --- FALLBACK REFRESH ---
        // Jika bot baru dipromosikan, metadata mungkin masih cache lama.
        // Jika butuh bot admin tapi di metadata belum, coba paksa refresh sekali.
        const requireBotAdmin = [prefix + 'kick', prefix + 'add', prefix + 'promote', prefix + 'demote', prefix + 'setnamegc', prefix + 'setdescgc', prefix + 'setopen', prefix + 'setclose', prefix + 'linkgc', prefix + 'revokelink'];
        if (requireBotAdmin.includes(command) && !botIsAdmin) {
            // Re-fetch metadata (beberapa library/cache butuh waktu)
            metadata = await sock.groupMetadata(remoteJid);
            participants = metadata.participants;
            const botP2 = participants.find(x => {
                const cleanXid = clean(x.id);
                return cleanXid === myJid || (myLid && cleanXid === myLid) || (x.lid && clean(x.lid) === myJid);
            });
            botIsAdmin = botP2 ? (botP2.admin === 'admin' || botP2.admin === 'superadmin') : false;
        }
    } catch (e) { }

    const readOnlyCommands = [prefix + 'settings', prefix + 'ceksetting'];
    const isAuthorized = isBotOwner || isAdmin;
    if (!isAuthorized && !readOnlyCommands.includes(command)) {
        await sock.sendMessage(remoteJid, { text: `❌ Perintah ini hanya untuk Admin Grup.` }, { quoted: msg });
        return true;
    }

    const requireBotAdmin = [prefix + 'kick', prefix + 'add', prefix + 'promote', prefix + 'demote', prefix + 'setnamegc', prefix + 'setdescgc', prefix + 'setopen', prefix + 'setclose', prefix + 'linkgc', prefix + 'revokelink'];
    if (requireBotAdmin.includes(command) && !botIsAdmin) {
        await sock.sendMessage(remoteJid, { text: `❌ Bot harus menjadi Admin untuk menggunakan perintah ini.` }, { quoted: msg });
        return true;
    }

    try {
        if (command === prefix + 'settings' || command === prefix + 'ceksetting') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const s = groupSettings[remoteJid];
            const on = '🟢 *ON*';
            const off = '🔴 *OFF*';
            
            let text = `⚙️ *PENGATURAN GRUP*\n\n` +
                `🛡️ *MODERASI & KEAMANAN*\n` +
                `🔹 Anti-Link: ${s.antilink ? on : off}\n` +
                `🔹 Anti-Link GC: ${s.antilinkgc ? on : off}\n` +
                `🔹 Anti-Channel: ${s.antilinkch ? on : off}\n` +
                `🔹 Anti-Bot: ${s.antibot ? on : off}\n` +
                `🔹 Anti-ViewOnce: ${s.antiviewonce ? on : off}\n` +
                `🔹 Anti-Delete: ${s.antidelete ? on : off}\n` +
                `🔹 Anti-Badword: ${s.antibadword ? on : off}\n\n` +
                `⚖️ *KEBIJAKAN HUKUMAN*\n` +
                `🔹 Mode Kick: ${s.antikick ? '🚫 *KICK*' : '🗑️ *HAPUS SAJA*'}\n\n` +
                `👋 *OTOMATISASI*\n` +
                `🔹 Welcome: ${s.welcome ? on : off}\n` +
                `🔹 Left: ${s.left ? on : off}\n` +
                `🔹 Auto-Mute: ${s.automute ? on : off}\n\n` +
                `💡 _Ketik perintah fitur (misal: .antilink) tanpa on/off untuk penjelasan detail._`;
            
            await sock.sendMessage(remoteJid, { text });
        }
        else if (command === prefix + 'kick') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            
            const response = await sock.groupParticipantsUpdate(remoteJid, users, "remove");
            
            // Cek status per user
            let success = [];
            let failed = [];
            for (let res of response) {
                if (res.status === '200') success.push(res.jid);
                else failed.push(res.jid);
            }
            
            if (success.length > 0) {
                await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengeluarkan ${success.length} member.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Gagal mengeluarkan member. Status: ${response[0]?.status || 'unknown'}` });
            }
        }
        else if (command === prefix + 'add') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan nomor target.' });
            
            const response = await sock.groupParticipantsUpdate(remoteJid, users, "add");
            
            let success = [];
            let failed = [];
            for (let res of response) {
                if (res.status === '200') success.push(res.jid);
                else failed.push({ jid: res.jid, status: res.status });
            }

            if (success.length > 0) {
                await sock.sendMessage(remoteJid, { text: `✅ Berhasil menambahkan ${success.length} member.` });
            }
            
            if (failed.length > 0) {
                for (let f of failed) {
                    if (f.status === '403') {
                        await sock.sendMessage(remoteJid, { text: `⚠️ Gagal menambahkan @${f.jid.split('@')[0]} karena privasi (403).\nSilakan kirim link grup manual saja.`, mentions: [f.jid] });
                    } else if (f.status === '408') {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal menambahkan @${f.jid.split('@')[0]}: Member baru saja keluar grup (408).`, mentions: [f.jid] });
                    } else if (f.status === '409') {
                        await sock.sendMessage(remoteJid, { text: `⚠️ @${f.jid.split('@')[0]} sudah ada di dalam grup ini.`, mentions: [f.jid] });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal menambahkan @${f.jid.split('@')[0]}. Status: ${f.status}`, mentions: [f.jid] });
                    }
                }
            }
        }
        else if (command === prefix + 'promote') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "promote");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil promote menjadi admin.` });
        }
        else if (command === prefix + 'demote') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "demote");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil demote dari admin.` });
        }
        else if (command === prefix + 'setnamegc') {
            const newName = args.slice(1).join(' ');
            if (!newName) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan nama grup baru.' });
            await sock.groupUpdateSubject(remoteJid, newName);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengubah nama grup.` });
        }
        else if (command === prefix + 'setdescgc') {
            const newDesc = args.slice(1).join(' ');
            if (!newDesc) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan deskripsi grup baru.' });
            await sock.groupUpdateDescription(remoteJid, newDesc);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengubah deskripsi grup.` });
        }
        else if (command === prefix + 'setopen') {
            await sock.groupSettingUpdate(remoteJid, 'not_announcement');
            await sock.sendMessage(remoteJid, { text: `✅ Grup dibuka.` });
        }
        else if (command === prefix + 'setclose') {
            await sock.groupSettingUpdate(remoteJid, 'announcement');
            await sock.sendMessage(remoteJid, { text: `✅ Grup ditutup.` });
        }
        else if (command === prefix + 'hidetag') {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(remoteJid);
            const participants = groupMetadata.participants.map(p => p.id);
            await sock.sendMessage(remoteJid, { text: textMsg || '📢 Perhatian', mentions: participants });
        }
        else if (command === prefix + 'tagall') {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(remoteJid);
            const participants = groupMetadata.participants;
            let tek = `*📢 TAG ALL*\n\n${textMsg ? `Pesan: ${textMsg}\n\n` : ''}`;
            for (let mem of participants) tek += `• @${mem.id.split('@')[0]}\n`;
            await sock.sendMessage(remoteJid, { text: tek, mentions: participants.map(p => p.id) });
        }
        else if (command === prefix + 'leavegc') {
            await sock.sendMessage(remoteJid, { text: `👋 Bot akan keluar.` });
            await sock.groupLeave(remoteJid);
        }
        else if (command === prefix + 'linkgc') {
            const code = await sock.groupInviteCode(remoteJid);
            await sock.sendMessage(remoteJid, { text: `🔗 *Link Grup:*\nhttps://chat.whatsapp.com/${code}` });
        }
        else if (command === prefix + 'revokelink') {
            await sock.groupRevokeInvite(remoteJid);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mereset link invite grup.` });
        }
        else if (command === prefix + 'groupinfo') {
            const groupMetadata = await sock.groupMetadata(remoteJid);
            let textInfo = `*📊 INFO GRUP*\n\n*Nama:* ${groupMetadata.subject}\n*ID:* ${groupMetadata.id}\n*Dibuat:* ${new Date(groupMetadata.creation * 1000).toLocaleString()}\n*Member:* ${groupMetadata.participants.length}\n*Admin:* ${groupMetadata.participants.filter(p => p.admin).length}\n*Deskripsi:*\n${groupMetadata.desc ? groupMetadata.desc.toString() : 'Tidak ada'}`;
            await sock.sendMessage(remoteJid, { text: textInfo });
        }
        else if (command === prefix + 'welcome') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].welcome = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Fitur *Welcome* (Pesan Sambutan) telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].welcome = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ Fitur *Welcome* (Pesan Sambutan) telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].welcome ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `👋 *Fitur Welcome*\n\nBerfungsi untuk mengirim pesan sambutan otomatis saat ada member baru bergabung.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}welcome on/off*` 
                });
            }
        }
        else if (command === prefix + 'setwelcome') {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan teks.\nContoh: .setwelcome Halo @user!` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].welcomeMsg = teks;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Teks welcome diset.` });
        }
        else if (command === prefix + 'left') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].left = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Fitur *Left* (Pesan Perpisahan) telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].left = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ Fitur *Left* (Pesan Perpisahan) telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].left ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🏃 *Fitur Left*\n\nBerfungsi untuk mengirim pesan otomatis saat ada member keluar dari grup.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}left on/off*` 
                });
            }
        }
        else if (command === prefix + 'setleft') {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan teks.\nContoh: .setleft Bye @user!` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].leftMsg = teks;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Teks left diset.` });
        }
        else if (command === prefix + 'setwelcomeimg') {
            if (!isAuthorized) return true;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const isImg = msg.message?.imageMessage || quoted?.imageMessage;
            if (isImg) {
                const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                const targetMsg = msg.message?.imageMessage ? msg.message.imageMessage : quoted.imageMessage;
                const stream = await downloadContentFromMessage(targetMsg, 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                
                const filename = `welcome_${remoteJid.split('@')[0]}.jpg`;
                const filePath = path.join(__dirname, '../../data/media/welcome', filename);
                if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, buffer);
                
                if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
                groupSettings[remoteJid].welcomeImg = filePath;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Gambar welcome berhasil disimpan.` });
            } else if (args[1] && args[1].startsWith('http')) {
                if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
                groupSettings[remoteJid].welcomeImg = args[1];
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ URL gambar welcome berhasil diset.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Reply gambar atau masukkan URL gambar dengan perintah *${prefix}setwelcomeimg*` });
            }
        }
        else if (command === prefix + 'delwelcomeimg') {
            if (!isAuthorized) return true;
            if (groupSettings[remoteJid]?.welcomeImg) {
                delete groupSettings[remoteJid].welcomeImg;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Gambar welcome berhasil dihapus.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Tidak ada gambar welcome yang diatur.` });
            }
        }
        else if (command === prefix + 'setleftimg') {
            if (!isAuthorized) return true;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const isImg = msg.message?.imageMessage || quoted?.imageMessage;
            if (isImg) {
                const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                const targetMsg = msg.message?.imageMessage ? msg.message.imageMessage : quoted.imageMessage;
                const stream = await downloadContentFromMessage(targetMsg, 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                
                const filename = `left_${remoteJid.split('@')[0]}.jpg`;
                const filePath = path.join(__dirname, '../../data/media/welcome', filename);
                if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, buffer);
                
                if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
                groupSettings[remoteJid].leftImg = filePath;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Gambar left berhasil disimpan.` });
            } else if (args[1] && args[1].startsWith('http')) {
                if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
                groupSettings[remoteJid].leftImg = args[1];
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ URL gambar left berhasil diset.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Reply gambar atau masukkan URL gambar dengan perintah *${prefix}setleftimg*` });
            }
        }
        else if (command === prefix + 'delleftimg') {
            if (!isAuthorized) return true;
            if (groupSettings[remoteJid]?.leftImg) {
                delete groupSettings[remoteJid].leftImg;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Gambar left berhasil dihapus.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Tidak ada gambar left yang diatur.` });
            }
        }
        else if (command === prefix + 'antilink') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antilink = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Link* (Semua Link) telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antilink = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Link* (Semua Link) telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antilink ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🔗 *Fitur Anti-Link*\n\nJika aktif, bot akan otomatis menghapus pesan yang mengandung link (http/https).\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antilink on/off*` 
                });
            }
        }
        else if (command === prefix + 'antilinkgc') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antilinkgc = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Link Grup* telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antilinkgc = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Link Grup* telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antilinkgc ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `👥 *Fitur Anti-Link Grup*\n\nKhusus untuk mendeteksi dan menghapus link undangan grup WhatsApp.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antilinkgc on/off*` 
                });
            }
        }
        else if (command === prefix + 'antilinkch') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antilinkch = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Link Saluran* telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antilinkch = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Link Saluran* telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antilinkch ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `📢 *Fitur Anti-Forward Saluran*\n\nBot akan menghapus pesan yang diteruskan (forward) dari Saluran/Channel WhatsApp.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antilinkch on/off*` 
                });
            }
        }
        else if (command === prefix + 'antikick') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antikick = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Kick Pelanggar* telah AKTIF.\nPelanggar aturan (link/badword) akan langsung dikeluarkan.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antikick = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Kick Pelanggar* telah MATI.\nPelanggar aturan hanya akan dihapus pesannya saja.` });
            } else {
                const status = groupSettings[remoteJid].antikick ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🚫 *Fitur Anti-Kick*\n\nMenentukan apakah bot harus mengeluarkan (kick) member yang melanggar aturan.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antikick on/off*` 
                });
            }
        }
        else if (command === prefix + 'antibadword') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antibadword = true;
                groupSettings[remoteJid].antibadwordnokick = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Badword (Kick)* telah AKTIF.\nMember yang mengucapkan kata kasar akan langsung dikeluarkan.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antibadword = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Badword (Kick)* telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antibadword ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🤬 *Fitur Anti-Badword (Kick)*\n\nBot akan menghapus pesan kasar dan mengeluarkan member tersebut.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antibadword on/off*` 
                });
            }
        }
        else if (command === prefix + 'antibadwordnokick') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antibadwordnokick = true;
                groupSettings[remoteJid].antibadword = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Badword (No Kick)* telah AKTIF.\nBot hanya akan menghapus pesan kasar tanpa mengeluarkan member.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antibadwordnokick = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Badword (No Kick)* telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antibadwordnokick ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🤬 *Fitur Anti-Badword (No Kick)*\n\nBot hanya akan menghapus pesan kasar saja.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antibadwordnokick on/off*` 
                });
            }
        }
        else if (command === prefix + 'addbadword') {
            const word = args[1];
            if (!word) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan kata.` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            if (!groupSettings[remoteJid].badwords) groupSettings[remoteJid].badwords = [];
            if (!groupSettings[remoteJid].badwords.includes(word.toLowerCase())) {
                groupSettings[remoteJid].badwords.push(word.toLowerCase());
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Kata "${word}" ditambahkan.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `⚠️ Sudah ada.` });
            }
        }
        else if (command === prefix + 'delbadword') {
            const word = args[1];
            if (!word) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan kata.` });
            if (!groupSettings[remoteJid] || !groupSettings[remoteJid].badwords) return true;
            const index = groupSettings[remoteJid].badwords.indexOf(word.toLowerCase());
            if (index > -1) {
                groupSettings[remoteJid].badwords.splice(index, 1);
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ Kata "${word}" dihapus.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `⚠️ Tidak ditemukan.` });
            }
        }
        else if (command === prefix + 'listbadword') {
            if (!groupSettings[remoteJid] || !groupSettings[remoteJid].badwords || !groupSettings[remoteJid].badwords.length) {
                return await sock.sendMessage(remoteJid, { text: `📝 Kosong.` });
            }
            await sock.sendMessage(remoteJid, { text: `📝 *Badwords:*\n` + groupSettings[remoteJid].badwords.join(', ') });
        }
        else if (command === prefix + 'resetbadword') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].badwords = [];
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Daftar badword direset.` });
        }
        else if (command === prefix + 'afk') {
            const reason = args.slice(1).join(' ') || 'Tanpa alasan';
            afkData[sender] = {
                reason: reason,
                time: Date.now()
            };
            saveAfkData();
            await sock.sendMessage(remoteJid, { text: `💤 *AFK Aktif!* @${sender.split('@')[0]} sekarang sedang AFK.\n\n📝 Alasan: ${reason}\n\n_Kirim pesan apa saja untuk mematikan AFK._`, mentions: [sender] }, { quoted: msg });
        }
        else if (command === prefix + 'antidelete') {
            const settings = getGroupSettings(remoteJid);
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                settings.antiDelete = true;
                saveGroupSettings(remoteJid, settings);
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Delete* telah AKTIF.\nBot akan mengirim ulang pesan yang dihapus oleh member lain.` });
            } else if (opt === 'off') {
                settings.antiDelete = false;
                saveGroupSettings(remoteJid, settings);
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Delete* telah MATI.` });
            } else {
                const status = settings.antiDelete ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🚫 *Fitur Anti-Delete*\n\nBerfungsi untuk menangkap dan mengirim ulang pesan yang sengaja dihapus oleh orang lain.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antidelete on/off*` 
                });
            }
        }
        else if (command === prefix + 'antiviewonce') {
            const settings = getGroupSettings(remoteJid);
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                settings.antiViewOnce = true;
                saveGroupSettings(remoteJid, settings);
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-ViewOnce* telah AKTIF.\nBot akan membongkar pesan Sekali Lihat.` });
            } else if (opt === 'off') {
                settings.antiViewOnce = false;
                saveGroupSettings(remoteJid, settings);
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-ViewOnce* telah MATI.` });
            } else {
                const status = settings.antiViewOnce ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `👁️ *Fitur Anti-ViewOnce*\n\nBot akan otomatis membuka dan meneruskan pesan "Sekali Lihat" (View Once).\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antiviewonce on/off*` 
                });
            }
        }
        // --- ABSEN SYSTEM ---
        else if (command === prefix + 'mulaiabsen' || command === prefix + 'absen') {
            if (!absenData[remoteJid]) {
                if (command === prefix + 'absen') {
                    await sock.sendMessage(remoteJid, { text: `❌ Belum ada absen yang dimulai di grup ini.\nKetik *${prefix}mulaiabsen* untuk memulai.` }, { quoted: msg });
                    return true;
                }
                absenData[remoteJid] = [];
                saveAbsenData();
                await sock.sendMessage(remoteJid, { text: `✅ *Absen Dimulai!* 📝\n\nKetik *${prefix}absen* untuk ikut absen.` }, { quoted: msg });
            } else {
                if (command === prefix + 'mulaiabsen') {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Absen sudah berjalan. Ketik *${prefix}cekabsen* untuk lihat daftar.` }, { quoted: msg });
                    return true;
                }
                const pushName = msg.pushName || 'User';
                if (absenData[remoteJid].some(v => v.jid === sender)) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Anda sudah absen sebelumnya.` }, { quoted: msg });
                } else {
                    absenData[remoteJid].push({ jid: sender, name: pushName, time: Date.now() });
                    saveAbsenData();
                    await sock.sendMessage(remoteJid, { text: `✅ Berhasil absen!\n👥 Total: ${absenData[remoteJid].length} orang` }, { quoted: msg });
                }
            }
        }
        else if (command === prefix + 'cekabsen') {
            if (!absenData[remoteJid] || absenData[remoteJid].length === 0) {
                await sock.sendMessage(remoteJid, { text: `❌ Belum ada daftar absen.` }, { quoted: msg });
            } else {
                let list = `📝 *DAFTAR ABSEN GRUP*\n\n`;
                absenData[remoteJid].forEach((v, i) => {
                    list += `${i + 1}. @${v.jid.split('@')[0]} (${v.name})\n`;
                });
                await sock.sendMessage(remoteJid, { text: list, mentions: absenData[remoteJid].map(v => v.jid) }, { quoted: msg });
            }
        }
        else if (command === prefix + 'deleteabsen') {
            if (!isAuthorized) return true;
            delete absenData[remoteJid];
            saveAbsenData();
            await sock.sendMessage(remoteJid, { text: `✅ Daftar absen berhasil dihapus.` }, { quoted: msg });
        }
        // --- LIST SYSTEM ---
        else if (command === prefix + 'addlist') {
            if (!isAuthorized) return true;
            const listArgs = args.slice(1).join(' ').split('|');
            if (listArgs.length < 2) {
                await sock.sendMessage(remoteJid, { text: `❌ Format: *${prefix}addlist kunci|isi*\nContoh: *${prefix}addlist aturan|Dilarang spam!*` }, { quoted: msg });
                return true;
            }
            const key = listArgs[0].trim().toLowerCase();
            const value = listArgs.slice(1).join('|').trim();
            if (!listData[remoteJid]) listData[remoteJid] = {};
            listData[remoteJid][key] = value;
            saveListData();
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menambahkan list: *${key}*` }, { quoted: msg });
        }
        else if (command === prefix + 'dellist') {
            if (!isAuthorized) return true;
            const key = args.slice(1).join(' ').trim().toLowerCase();
            if (!key || !listData[remoteJid] || !listData[remoteJid][key]) {
                await sock.sendMessage(remoteJid, { text: `❌ List *${key}* tidak ditemukan.` }, { quoted: msg });
                return true;
            }
            delete listData[remoteJid][key];
            saveListData();
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menghapus list: *${key}*` }, { quoted: msg });
        }
        else if (command === prefix + 'list') {
            if (!listData[remoteJid] || Object.keys(listData[remoteJid]).length === 0) {
                await sock.sendMessage(remoteJid, { text: `❌ Belum ada list kustom di grup ini.` }, { quoted: msg });
            } else {
                let listStr = `📋 *DAFTAR LIST GRUP*\n\n`;
                Object.keys(listData[remoteJid]).forEach((k, i) => {
                    listStr += `${i + 1}. *${prefix}${k}*\n`;
                });
                await sock.sendMessage(remoteJid, { text: listStr }, { quoted: msg });
            }
        }
        // --- WARNING SYSTEM ---
        else if (command === prefix + 'warn') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply target yang ingin diberi peringatan.' });
            
            if (!warnData[remoteJid]) warnData[remoteJid] = {};
            
            for (let user of users) {
                if (!warnData[remoteJid][user]) warnData[remoteJid][user] = 0;
                warnData[remoteJid][user]++;
                
                const count = warnData[remoteJid][user];
                if (count >= 3) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ @${user.split('@')[0]} sudah mencapai 3 peringatan! Mengeluarkan dari grup...`, mentions: [user] });
                    await sock.groupParticipantsUpdate(remoteJid, [user], 'remove');
                    delete warnData[remoteJid][user];
                } else {
                    await sock.sendMessage(remoteJid, { text: `⚠️ @${user.split('@')[0]} diberi peringatan! (${count}/3)`, mentions: [user] });
                }
            }
            saveWarnData();
        }
        else if (command === prefix + 'delwarn') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply target.' });
            if (!warnData[remoteJid]) return true;
            
            for (let user of users) {
                if (warnData[remoteJid][user]) {
                    warnData[remoteJid][user]--;
                    if (warnData[remoteJid][user] <= 0) delete warnData[remoteJid][user];
                    await sock.sendMessage(remoteJid, { text: `✅ Peringatan dikurangi untuk @${user.split('@')[0]}.`, mentions: [user] });
                }
            }
            saveWarnData();
        }
        else if (command === prefix + 'cekwarn' || command === prefix + 'listwarn') {
            const users = getMentionedOrQuoted(msg, args);
            const target = users.length ? users[0] : sender;
            const count = (warnData[remoteJid] && warnData[remoteJid][target]) ? warnData[remoteJid][target] : 0;
            await sock.sendMessage(remoteJid, { text: `📊 *Status Peringatan*\n\n👤 Target: @${target.split('@')[0]}\n⚠️ Jumlah: ${count}/3`, mentions: [target] });
        }
        
        // --- BLACKLIST SYSTEM ---
        else if (command === prefix + 'blacklist') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply target yang ingin di-blacklist.' });
            
            if (!blacklistData[remoteJid]) blacklistData[remoteJid] = [];
            
            for (let user of users) {
                if (!blacklistData[remoteJid].includes(user)) {
                    blacklistData[remoteJid].push(user);
                    await sock.sendMessage(remoteJid, { text: `🚫 @${user.split('@')[0]} telah ditambahkan ke daftar hitam grup ini.`, mentions: [user] });
                    await sock.groupParticipantsUpdate(remoteJid, [user], 'remove').catch(() => {});
                }
            }
            saveBlacklistData();
        }
        else if (command === prefix + 'delblacklist') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply target.' });
            if (!blacklistData[remoteJid]) return true;
            
            blacklistData[remoteJid] = blacklistData[remoteJid].filter(u => !users.includes(u));
            saveBlacklistData();
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menghapus target dari blacklist.` });
        }
        else if (command === prefix + 'listblacklist') {
            if (!blacklistData[remoteJid] || !blacklistData[remoteJid].length) {
                await sock.sendMessage(remoteJid, { text: `📝 Daftar blacklist kosong.` });
            } else {
                let text = `🚫 *DAFTAR BLACKLIST GRUP*\n\n`;
                blacklistData[remoteJid].forEach((u, i) => {
                    text += `${i + 1}. @${u.split('@')[0]}\n`;
                });
                await sock.sendMessage(remoteJid, { text, mentions: blacklistData[remoteJid] });
            }
        }
        
        // --- ANTI-BOT ---
        else if (command === prefix + 'antibot') {
            if (!isAuthorized) return true;
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].antibot = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Bot* telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].antibot = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Anti-Bot* telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].antibot ? 'AKTIF' : 'MATI';
                await sock.sendMessage(remoteJid, { 
                    text: `🤖 *Fitur Anti-Bot*\n\nBot akan mendeteksi member baru yang menggunakan akun bot/otomatis dan memperingatkan/mengeluarkan mereka.\n\nStatus saat ini: *${status}*\nCara pakai: *${prefix}antibot on/off*` 
                });
            }
        }
        else if (command === prefix + 'antibot_kick') {
            if (!isAuthorized) return true;
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].antibot_kick = args[1] === 'on';
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Fitur Auto-Kick Anti-Bot di-${groupSettings[remoteJid].antibot_kick ? 'Aktifkan' : 'Matikan'}.` });
        }
        
        // --- AUTO-MUTE ---
        else if (command === prefix + 'automute') {
            if (!isAuthorized) return true;
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                groupSettings[remoteJid].automute = true;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `✅ *Auto-Mute* (Buka/Tutup Grup Otomatis) telah AKTIF.` });
            } else if (opt === 'off') {
                groupSettings[remoteJid].automute = false;
                saveSettings();
                await sock.sendMessage(remoteJid, { text: `❌ *Auto-Mute* (Buka/Tutup Grup Otomatis) telah MATI.` });
            } else {
                const status = groupSettings[remoteJid].automute ? 'AKTIF' : 'MATI';
                const mTime = groupSettings[remoteJid].mute_time || '--:--';
                const uTime = groupSettings[remoteJid].unmute_time || '--:--';
                await sock.sendMessage(remoteJid, { 
                    text: `🕙 *Fitur Auto-Mute*\n\nBerfungsi untuk membuka dan menutup grup secara otomatis pada jam yang ditentukan.\n\nStatus saat ini: *${status}*\n⏰ Tutup: *${mTime}*\n⏰ Buka: *${uTime}*\n\nCara pakai: *${prefix}automute on/off*` 
                });
            }
        }
        else if (command === prefix + 'setmute') {
            if (!isAuthorized) return true;
            if (!args[1] || !args[1].includes(':')) return await sock.sendMessage(remoteJid, { text: `❌ Format: *${prefix}setmute HH:MM*` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].mute_time = args[1];
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Jam tutup grup diset ke: *${args[1]}*` });
        }
        else if (command === prefix + 'setunmute') {
            if (!isAuthorized) return true;
            if (!args[1] || !args[1].includes(':')) return await sock.sendMessage(remoteJid, { text: `❌ Format: *${prefix}setunmute HH:MM*` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].unmute_time = args[1];
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Jam buka grup diset ke: *${args[1]}*` });
        }
        
        // --- SEWA SYSTEM ---
        else if (command === prefix + 'addsewa') {
            if (!isBotOwner) return true;
            const days = parseInt(args[1]);
            if (isNaN(days)) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan jumlah hari.\nContoh: *${prefix}addsewa 30*` });
            
            const now = Date.now();
            const duration = days * 24 * 60 * 60 * 1000;
            const expire = now + duration;
            
            sewaData[remoteJid] = {
                expire: expire,
                joinedAt: now,
                days: days
            };
            saveSewaData();
            
            const dateStr = new Date(expire).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil menambah masa sewa bot selama *${days} hari*.\n📅 Berakhir pada: *${dateStr}*` });
        }
        else if (command === prefix + 'ceksewa') {
            if (!sewaData[remoteJid]) {
                await sock.sendMessage(remoteJid, { text: `ℹ️ Grup ini tidak terdaftar dalam sistem sewa (Gratis/Permanen).` });
            } else {
                const now = Date.now();
                const remain = sewaData[remoteJid].expire - now;
                const dateStr = new Date(sewaData[remoteJid].expire).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                if (remain <= 0) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Masa sewa sudah HABIS pada: *${dateStr}*` });
                } else {
                    await sock.sendMessage(remoteJid, { text: `⏳ *MASA SEWA BOT*\n\n📅 Berakhir: *${dateStr}*\n🕒 Sisa waktu: *${formatDuration(remain)}*` });
                }
            }
        }
        else if (command === prefix + 'delsewa') {
            if (!isBotOwner) return true;
            delete sewaData[remoteJid];
            saveSewaData();
            await sock.sendMessage(remoteJid, { text: `🗑️ Grup ini berhasil dihapus dari sistem sewa.` });
        }
        else if (command === prefix + 'listsewa') {
            if (!isBotOwner) return true;
            const jids = Object.keys(sewaData);
            if (jids.length === 0) return await sock.sendMessage(remoteJid, { text: `📋 Belum ada grup yang menyewa bot.` });

            let txt = `📋 *DAFTAR GRUP SEWA (${jids.length})*\n\n`;
            const now = Date.now();

            for (let i = 0; i < jids.length; i++) {
                const jid = jids[i];
                const data = sewaData[jid];
                const remain = data.expire - now;
                const dateStr = new Date(data.expire).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                // Ambil nama grup jika ada di cache metadata
                let groupName = "Grup Tidak Diketahui";
                try {
                    const metadata = await sock.groupMetadata(jid).catch(() => null);
                    if (metadata) groupName = metadata.subject;
                } catch (e) {}

                txt += `${i + 1}. *${groupName}*\n`;
                txt += `   ID: \`${jid}\`\n`;
                txt += `   Exp: ${dateStr} (${remain > 0 ? formatDuration(remain) : 'EXPIRED'})\n\n`;
            }

            await sock.sendMessage(remoteJid, { text: txt });
        }
        
        // --- SET PP GC ---
        else if (command === prefix + 'setppgc') {
            if (!isAuthorized) return true;
            if (!botIsAdmin) return await sock.sendMessage(remoteJid, { text: `❌ Bot harus jadi admin!` });
            
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMsg?.imageMessage) return await sock.sendMessage(remoteJid, { text: `❌ Reply foto dengan perintah *${prefix}setppgc*` });
            
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            
            await sock.updateProfilePicture(remoteJid, buffer);
            await sock.sendMessage(remoteJid, { text: `✅ Foto profil grup berhasil diubah.` });
        }
        else if (command === prefix + 'ownerdewasa') {
            if (!isBotOwner) return true;
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                require('../utils/config').update('ownerdewasa', true);
                await sock.sendMessage(remoteJid, { text: `✅ *Mode Publik Aktif!*\nBot sekarang bisa digunakan di semua grup.` });
            } else if (opt === 'off') {
                require('../utils/config').update('ownerdewasa', false);
                await sock.sendMessage(remoteJid, { text: `❌ *Mode Publik Mati!*\nBot sekarang hanya bisa digunakan di grup yang sudah Sewa (.addsewa).` });
            } else {
                const current = require('../utils/config').getConfig().ownerdewasa;
                await sock.sendMessage(remoteJid, { text: `Status Mode Publik: *${current ? 'ON (Public)' : 'OFF (Sewa Only)'}*\nGunakan: ${prefix}ownerdewasa on/off` });
            }
        }
    } catch (e) {
        await sock.sendMessage(remoteJid, { text: `❌ Terjadi error: ${e.message}` }, { quoted: msg });
    }

    return true;
}

async function handleAntiDelete(sock, msg, msgCache) {
    if (!msg.message?.protocolMessage || msg.message.protocolMessage.type !== 3) return;
    
    const remoteJid = msg.key.remoteJid;
    const settings = getGroupSettings(remoteJid);
    if (!settings.antiDelete) return;

    const deletedId = msg.message.protocolMessage.key.id;
    const oldMsg = msgCache.get(deletedId);
    if (!oldMsg) return;

    const sender = msg.message.protocolMessage.key.participant || msg.message.protocolMessage.key.remoteJid;
    
    await sock.sendMessage(remoteJid, { text: `🚫 *ANTI DELETE DETECTED!*\n\n👤 Member: @${sender.split('@')[0]}\n🕒 Menghapus pesan di bawah ini:`, mentions: [sender] });
    await sock.copyNForward(remoteJid, { key: { remoteJid, id: deletedId }, message: oldMsg }, false);
}

async function handleAntiViewOnce(sock, msg) {
    const remoteJid = msg.key.remoteJid;
    const settings = getGroupSettings(remoteJid);
    if (!settings.antiViewOnce) return;

    let viewOnceMsg = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message;
    if (!viewOnceMsg) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    
    await sock.sendMessage(remoteJid, { text: `👁️ *ANTI VIEW-ONCE DETECTED!*\n\n👤 Member: @${sender.split('@')[0]}\n🔓 Membuka pesan rahasia...`, mentions: [sender] }, { quoted: msg });
    
    const content = JSON.parse(JSON.stringify(viewOnceMsg));
    if (content.imageMessage) delete content.imageMessage.viewOnce;
    if (content.videoMessage) delete content.videoMessage.viewOnce;

    await sock.sendMessage(remoteJid, { forward: { key: msg.key, message: content } });
}

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    
    let parts = [];
    if (days > 0) parts.push(`${days} hari`);
    if (hours > 0) parts.push(`${hours} jam`);
    if (minutes > 0) parts.push(`${minutes} menit`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} detik`);
    return parts.join(' ');
}

async function handleGroupParticipantsUpdate(sock, { id, participants, action }) {
    const remoteJid = id;
    
    // --- CHECK SEWA / PUBLIC MODE ---
    const globalCfg = require('../utils/config').getConfig();
    const isPublic = globalCfg.ownerdewasa;
    const isRented = sewaData[remoteJid] && sewaData[remoteJid].expire > Date.now();
    if (!isPublic && !isRented) return; // Skip welcome/kick if not public and not rented

    const settings = getGroupSettings(remoteJid);
    const metadata = await sock.groupMetadata(remoteJid).catch(() => ({}));
    const groupName = metadata.subject || 'Grup';
    
    for (let user of participants) {
        const cleanUser = user.replace(/:[0-9]+/, '');
        
        // 1. BLACKLIST AUTO-KICK
        if (action === 'add' && blacklistData[remoteJid]?.includes(user)) {
            await sock.sendMessage(remoteJid, { text: `🚫 @${cleanUser.split('@')[0]} ada dalam daftar hitam! Mengeluarkan...`, mentions: [user] });
            await sock.groupParticipantsUpdate(remoteJid, [user], 'remove').catch(() => {});
            continue;
        }

        // 2. ANTI-BOT AUTO-KICK
        // Deteksi bot biasanya dari JID yang punya suffix khusus atau pola tertentu.
        // Di Baileys/WhatsApp, bot seringkali punya device ID :0 atau JID @lid.
        const isBot = user.includes(':') || user.endsWith('@lid'); 
        if (action === 'add' && settings.antibot && isBot) {
            await sock.sendMessage(remoteJid, { text: `🤖 Anti-Bot: Terdeteksi akun bot @${cleanUser.split('@')[0]} mencoba masuk.`, mentions: [user] });
            if (settings.antibot_kick) {
                await sock.groupParticipantsUpdate(remoteJid, [user], 'remove').catch(() => {});
            }
            continue;
        }

        // 3. WELCOME / LEFT MESSAGE
        if (action === 'add' && settings.welcome) {
            let msg = settings.welcomeMsg || 'Selamat datang @user di grup @group!';
            msg = msg.replace('@user', `@${cleanUser.split('@')[0]}`).replace('@group', groupName);
            
            if (settings.welcomeImg) {
                const imgSource = settings.welcomeImg.startsWith('http') ? { url: settings.welcomeImg } : fs.readFileSync(settings.welcomeImg);
                await sock.sendMessage(remoteJid, { image: imgSource, caption: msg, mentions: [user] });
            } else {
                await sock.sendMessage(remoteJid, { text: msg, mentions: [user] });
            }
        } else if (action === 'remove' && settings.left) {
            let msg = settings.leftMsg || 'Selamat jalan @user, semoga tenang di sana.';
            msg = msg.replace('@user', `@${cleanUser.split('@')[0]}`).replace('@group', groupName);
            
            if (settings.leftImg) {
                const imgSource = settings.leftImg.startsWith('http') ? { url: settings.leftImg } : fs.readFileSync(settings.leftImg);
                await sock.sendMessage(remoteJid, { image: imgSource, caption: msg, mentions: [user] });
            } else {
                await sock.sendMessage(remoteJid, { text: msg, mentions: [user] });
            }
        }
    }
}

/** 
 * Loop Background untuk Sewa & Auto-Mute 
 * Dijalankan sekali saat bot start di index.js
 */
function initAutoManager(sock) {
    logger.info('🚀 Auto-Manager (Sewa & Auto-Mute) Started.');
    
    setInterval(async () => {
        const now = Date.now();
        const date = new Date();
        const currentTime = date.toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

        // 1. CEK SEWA EXPIRED
        for (let jid in sewaData) {
            if (now > sewaData[jid].expire) {
                try {
                    await sock.sendMessage(jid, { text: `⚠️ *MASA SEWA HABIS*\n\nMasa sewa bot di grup ini telah berakhir. Bot akan keluar otomatis. Terima kasih!` });
                    await sock.groupLeave(jid);
                    delete sewaData[jid];
                    saveSewaData();
                    logger.info(`👋 Sewa habis, keluar dari ${jid}`);
                } catch (e) { }
            }
        }

        // 2. CEK AUTO-MUTE / UNMUTE
        for (let jid in groupSettings) {
            const s = groupSettings[jid];
            if (!s.automute) continue;

            // Tutup Grup (Mute)
            if (s.mute_time === currentTime) {
                try {
                    await sock.groupSettingUpdate(jid, 'announcement');
                    await sock.sendMessage(jid, { text: `🕙 *WAKTUNYA ISTIRAHAT*\n\nGrup otomatis ditutup oleh bot. Sampai jumpa besok pagi!` });
                    // Hapus mute_time sementara agar tidak loop di menit yang sama (atau biarkan karena interval 1 menit)
                } catch (e) { }
            }

            // Buka Grup (Unmute)
            if (s.unmute_time === currentTime) {
                try {
                    await sock.groupSettingUpdate(jid, 'not_announcement');
                    await sock.sendMessage(jid, { text: `☀️ *SELAMAT PAGI*\n\nGrup otomatis dibuka kembali. Silakan beraktivitas!` });
                } catch (e) { }
            }
        }
    }, 60000); // Cek setiap 1 menit
}

module.exports = {
    handleGroupModeration,
    handleGroupParticipantsUpdate,
    handleGroupCommand,
    handleAntiDelete,
    handleAntiViewOnce,
    initAutoManager,
    sewaData
};
