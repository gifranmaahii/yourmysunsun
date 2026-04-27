const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../data/groupSettings.json');
const afkDataPath = path.join(__dirname, '../../data/afkData.json');
const absenDataPath = path.join(__dirname, '../../data/absenData.json');
const listDataPath = path.join(__dirname, '../../data/listData.json');
const warnDataPath = path.join(__dirname, '../../data/warnData.json');
const blacklistDataPath = path.join(__dirname, '../../data/blacklistData.json');

let groupSettings = {};
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        groupSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch (e) { }
}

let afkData = {};
if (fs.existsSync(afkDataPath)) { try { afkData = JSON.parse(fs.readFileSync(afkDataPath, 'utf8')); } catch (e) { } }
let absenData = {};
if (fs.existsSync(absenDataPath)) { try { absenData = JSON.parse(fs.readFileSync(absenDataPath, 'utf8')); } catch (e) { } }
let listData = {};
if (fs.existsSync(listDataPath)) { try { listData = JSON.parse(fs.readFileSync(listDataPath, 'utf8')); } catch (e) { } }
let warnData = {};
if (fs.existsSync(warnDataPath)) { try { warnData = JSON.parse(fs.readFileSync(warnDataPath, 'utf8')); } catch (e) { } }
let blacklistData = {};
if (fs.existsSync(blacklistDataPath)) { try { blacklistData = JSON.parse(fs.readFileSync(blacklistDataPath, 'utf8')); } catch (e) { } }

function saveSettings() {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings, null, 2));
    } catch (e) { }
}

function saveAfkData() { fs.writeFileSync(afkDataPath, JSON.stringify(afkData, null, 2)); }
function saveAbsenData() { fs.writeFileSync(absenDataPath, JSON.stringify(absenData, null, 2)); }
function saveListData() { fs.writeFileSync(listDataPath, JSON.stringify(listData, null, 2)); }
function saveWarnData() { fs.writeFileSync(warnDataPath, JSON.stringify(warnData, null, 2)); }
function saveBlacklistData() { fs.writeFileSync(blacklistDataPath, JSON.stringify(blacklistData, null, 2)); }

function getGroupSettings(jid) {
    return groupSettings[jid] || {};
}

function saveGroupSettings(jid, settings) {
    groupSettings[jid] = settings;
    saveSettings();
}

const getMentionedOrQuoted = (msg, args) => {
    const messageType = Object.keys(msg.message)[0];
    const mentioned = msg.message[messageType]?.contextInfo?.mentionedJid || [];
    if (mentioned.length > 0) return mentioned;
    const quoted = msg.message[messageType]?.contextInfo?.participant;
    if (quoted) return [quoted];
    const textNum = args[1] ? args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null;
    if (textNum && textNum !== '@s.whatsapp.net') return [textNum];
    return [];
};

async function handleGroupModeration(sock, msg, textContent, remoteJid, fromMe) {
    if (!remoteJid.endsWith('@g.us')) return;
    if (fromMe) return; 

    const sender = msg.key.participant || msg.key.remoteJid;

    // --- CHECK BLACKLIST ---
    if (blacklistData[remoteJid] && blacklistData[remoteJid].includes(sender)) {
        await sock.groupParticipantsUpdate(remoteJid, [sender], 'remove');
        return;
    }

    const settings = groupSettings[remoteJid] || {};
    const isLink = textContent.match(/chat\.whatsapp\.com\/[a-zA-Z0-9]/i) || textContent.match(/wa\.me\//i);

    let isAdmin = false;
    try {
        const metadata = await sock.groupMetadata(remoteJid);
        const p = metadata.participants.find(x => x.id === sender);
        isAdmin = p ? p.admin : false;
    } catch (e) { }

    if (!isAdmin) {
        let isViolating = false;
        let shouldKick = false;

        if (isLink && (settings.antilink || settings.antilinknokick)) {
            isViolating = true;
            if (settings.antilink) shouldKick = true;
        }

        if (!isViolating && (settings.antibadword || settings.antibadwordnokick)) {
            const badwords = settings.badwords || [];
            const textLower = textContent.toLowerCase();
            const isBad = badwords.some(word => textLower.includes(word.toLowerCase()));
            if (isBad) {
                isViolating = true;
                if (settings.antibadword) shouldKick = true;
            }
        }

        if (isViolating) {
            await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => { });
            if (shouldKick) {
                await sock.groupParticipantsUpdate(remoteJid, [sender], "remove").catch(() => { });
            }
        }
    }
}

async function handleGroupParticipantsUpdate(sock, update) {
    const { id, participants, action } = update;
    try {
        const settings = groupSettings[id] || {};
        const groupMetadata = await sock.groupMetadata(id).catch(() => null);
        const groupName = groupMetadata ? groupMetadata.subject : 'Grup';

        for (let participant of participants) {
            if (action === 'add' && settings.welcome) {
                let msg = settings.welcomeMsg || `Halo @user, selamat datang di @group!`;
                msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`).replace(/@group/g, groupName);
                await sock.sendMessage(id, { text: msg, mentions: [participant] });
            } else if (action === 'remove' && settings.left) {
                let msg = settings.leftMsg || `Selamat tinggal @user dari @group!`;
                msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`).replace(/@group/g, groupName);
                await sock.sendMessage(id, { text: msg, mentions: [participant] });
            }
        }
    } catch (err) { }
}

async function handleGroupCommand(sock, msg, textContent, remoteJid, isBotOwner) {
    if (!remoteJid.endsWith('@g.us')) return false;

    const args = textContent.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    
    const prefix = require('../utils/config').getConfig().prefix || '.';

    const sender = msg.key.participant || msg.key.remoteJid;
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
        prefix + 'left', prefix + 'setleft', prefix + 'antilink', prefix + 'antilinknokick', prefix + 'antibadword', prefix + 'antibadwordnokick', 
        prefix + 'addbadword', prefix + 'delbadword', prefix + 'listbadword', prefix + 'resetbadword',
        prefix + 'afk', prefix + 'antidelete', prefix + 'antiviewonce',
        prefix + 'absen', prefix + 'cekabsen', prefix + 'deleteabsen', prefix + 'mulaiabsen',
        prefix + 'addlist', prefix + 'dellist', prefix + 'list',
        prefix + 'warn', prefix + 'cekwarn', prefix + 'delwarn', prefix + 'listwarn',
        prefix + 'blacklist', prefix + 'delblacklist', prefix + 'listblacklist'
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
        const metadata = await sock.groupMetadata(remoteJid);
        const p = metadata.participants.find(x => x.id === sender);
        isAdmin = p ? !!p.admin : false;
        const myJid = sock.user.id.replace(/:[0-9]+/, '');
        const myLid = sock.user.lid ? sock.user.lid.replace(/:[0-9]+/, '') : null;
        const botP = metadata.participants.find(x => x.id === myJid || (myLid && x.id === myLid));
        botIsAdmin = botP ? (botP.admin === 'admin' || botP.admin === 'superadmin') : false;
    } catch (e) { }

    const isAuthorized = isBotOwner || isAdmin;
    if (!isAuthorized) {
        await sock.sendMessage(remoteJid, { text: `❌ Perintah ini hanya untuk Admin Grup.` }, { quoted: msg });
        return true;
    }

    const requireBotAdmin = ['.kick', '.add', '.promote', '.demote', '.setnamegc', '.setdescgc', '.setopen', '.setclose', '.linkgc', '.revokelink'];
    if (requireBotAdmin.includes(command) && !botIsAdmin) {
        await sock.sendMessage(remoteJid, { text: `❌ Bot harus menjadi Admin untuk menggunakan perintah ini.` }, { quoted: msg });
        return true;
    }

    try {
        if (command === '.kick') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "remove");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil kick target.` });
        }
        else if (command === '.add') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan nomor target.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "add");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengundang target.` });
        }
        else if (command === '.promote') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "promote");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil promote menjadi admin.` });
        }
        else if (command === '.demote') {
            const users = getMentionedOrQuoted(msg, args);
            if (!users.length) return await sock.sendMessage(remoteJid, { text: '❌ Tag/reply/masukkan nomor.' });
            await sock.groupParticipantsUpdate(remoteJid, users, "demote");
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil demote dari admin.` });
        }
        else if (command === '.setnamegc') {
            const newName = args.slice(1).join(' ');
            if (!newName) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan nama grup baru.' });
            await sock.groupUpdateSubject(remoteJid, newName);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengubah nama grup.` });
        }
        else if (command === '.setdescgc') {
            const newDesc = args.slice(1).join(' ');
            if (!newDesc) return await sock.sendMessage(remoteJid, { text: '❌ Masukkan deskripsi grup baru.' });
            await sock.groupUpdateDescription(remoteJid, newDesc);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mengubah deskripsi grup.` });
        }
        else if (command === '.setopen') {
            await sock.groupSettingUpdate(remoteJid, 'not_announcement');
            await sock.sendMessage(remoteJid, { text: `✅ Grup dibuka.` });
        }
        else if (command === '.setclose') {
            await sock.groupSettingUpdate(remoteJid, 'announcement');
            await sock.sendMessage(remoteJid, { text: `✅ Grup ditutup.` });
        }
        else if (command === '.hidetag') {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(remoteJid);
            const participants = groupMetadata.participants.map(p => p.id);
            await sock.sendMessage(remoteJid, { text: textMsg || '📢 Perhatian', mentions: participants });
        }
        else if (command === '.tagall') {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(remoteJid);
            const participants = groupMetadata.participants;
            let tek = `*📢 TAG ALL*\n\n${textMsg ? `Pesan: ${textMsg}\n\n` : ''}`;
            for (let mem of participants) tek += `• @${mem.id.split('@')[0]}\n`;
            await sock.sendMessage(remoteJid, { text: tek, mentions: participants.map(p => p.id) });
        }
        else if (command === '.leavegc') {
            await sock.sendMessage(remoteJid, { text: `👋 Bot akan keluar.` });
            await sock.groupLeave(remoteJid);
        }
        else if (command === '.linkgc') {
            const code = await sock.groupInviteCode(remoteJid);
            await sock.sendMessage(remoteJid, { text: `🔗 *Link Grup:*\nhttps://chat.whatsapp.com/${code}` });
        }
        else if (command === '.revokelink') {
            await sock.groupRevokeInvite(remoteJid);
            await sock.sendMessage(remoteJid, { text: `✅ Berhasil mereset link invite grup.` });
        }
        else if (command === '.groupinfo') {
            const groupMetadata = await sock.groupMetadata(remoteJid);
            let textInfo = `*📊 INFO GRUP*\n\n*Nama:* ${groupMetadata.subject}\n*ID:* ${groupMetadata.id}\n*Dibuat:* ${new Date(groupMetadata.creation * 1000).toLocaleString()}\n*Member:* ${groupMetadata.participants.length}\n*Admin:* ${groupMetadata.participants.filter(p => p.admin).length}\n*Deskripsi:*\n${groupMetadata.desc ? groupMetadata.desc.toString() : 'Tidak ada'}`;
            await sock.sendMessage(remoteJid, { text: textInfo });
        }
        else if (command === '.welcome') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].welcome = !groupSettings[remoteJid].welcome;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Welcome di-${groupSettings[remoteJid].welcome ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.setwelcome') {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan teks.\nContoh: .setwelcome Halo @user!` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].welcomeMsg = teks;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Teks welcome diset.` });
        }
        else if (command === '.left') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].left = !groupSettings[remoteJid].left;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Left di-${groupSettings[remoteJid].left ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.setleft') {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(remoteJid, { text: `❌ Masukkan teks.\nContoh: .setleft Bye @user!` });
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].leftMsg = teks;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Teks left diset.` });
        }
        else if (command === '.antilink') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].antilink = !groupSettings[remoteJid].antilink;
            if (groupSettings[remoteJid].antilink) groupSettings[remoteJid].antilinknokick = false;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Anti-Link (Kick) di-${groupSettings[remoteJid].antilink ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.antilinknokick') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].antilinknokick = !groupSettings[remoteJid].antilinknokick;
            if (groupSettings[remoteJid].antilinknokick) groupSettings[remoteJid].antilink = false;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Anti-Link (No Kick) di-${groupSettings[remoteJid].antilinknokick ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.antibadword') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].antibadword = !groupSettings[remoteJid].antibadword;
            if (groupSettings[remoteJid].antibadword) groupSettings[remoteJid].antibadwordnokick = false;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Anti-Badword (Kick) di-${groupSettings[remoteJid].antibadword ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.antibadwordnokick') {
            if (!groupSettings[remoteJid]) groupSettings[remoteJid] = {};
            groupSettings[remoteJid].antibadwordnokick = !groupSettings[remoteJid].antibadwordnokick;
            if (groupSettings[remoteJid].antibadwordnokick) groupSettings[remoteJid].antibadword = false;
            saveSettings();
            await sock.sendMessage(remoteJid, { text: `✅ Anti-Badword (No Kick) di-${groupSettings[remoteJid].antibadwordnokick ? 'Aktifkan' : 'Matikan'}.` });
        }
        else if (command === '.addbadword') {
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
        else if (command === '.delbadword') {
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
        else if (command === '.listbadword') {
            if (!groupSettings[remoteJid] || !groupSettings[remoteJid].badwords || !groupSettings[remoteJid].badwords.length) {
                return await sock.sendMessage(remoteJid, { text: `📝 Kosong.` });
            }
            await sock.sendMessage(remoteJid, { text: `📝 *Badwords:*\n` + groupSettings[remoteJid].badwords.join(', ') });
        }
        else if (command === '.resetbadword') {
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
            settings.antiDelete = !settings.antiDelete;
            saveGroupSettings(remoteJid, settings);
            await sock.sendMessage(remoteJid, { text: `✅ Anti-Delete berhasil di *${settings.antiDelete ? 'AKTIFKAN' : 'MATIKAN'}* untuk grup ini.` }, { quoted: msg });
        }
        else if (command === prefix + 'antiviewonce') {
            const settings = getGroupSettings(remoteJid);
            settings.antiViewOnce = !settings.antiViewOnce;
            saveGroupSettings(remoteJid, settings);
            await sock.sendMessage(remoteJid, { text: `✅ Anti-ViewOnce berhasil di *${settings.antiViewOnce ? 'AKTIFKAN' : 'MATIKAN'}* untuk grup ini.` }, { quoted: msg });
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
    
    let parts = [];
    if (hours > 0) parts.push(`${hours} jam`);
    if (minutes > 0) parts.push(`${minutes} menit`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} detik`);
    return parts.join(' ');
}

module.exports = {
    handleGroupModeration,
    handleGroupParticipantsUpdate,
    handleGroupCommand,
    handleAntiDelete,
    handleAntiViewOnce
};
