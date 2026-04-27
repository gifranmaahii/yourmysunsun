const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../data/groupSettings.json');
let groupSettings = {};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        groupSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch (e) { }
}

function saveSettings() {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings, null, 2));
    } catch (e) { }
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
    if (fromMe) return; // Jangan hapus pesan sendiri
    if (!textContent) return;

    const settings = groupSettings[remoteJid] || {};
    const sender = msg.key.participant;
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
    const groupCommands = [
        prefix + 'kick', prefix + 'add', prefix + 'promote', prefix + 'demote', prefix + 'setnamegc', prefix + 'setdescgc', prefix + 'setopen', prefix + 'setclose',
        prefix + 'hidetag', prefix + 'tagall', prefix + 'leavegc', prefix + 'linkgc', prefix + 'revokelink', prefix + 'groupinfo', prefix + 'welcome', prefix + 'setwelcome', 
        prefix + 'left', prefix + 'setleft', prefix + 'antilink', prefix + 'antilinknokick', prefix + 'antibadword', prefix + 'antibadwordnokick', 
        prefix + 'addbadword', prefix + 'delbadword', prefix + 'listbadword', prefix + 'resetbadword'
    ];

    if (!groupCommands.includes(command)) return false;

    // Cek apakah sender adalah admin grup atau owner bot
    const sender = msg.key.participant || msg.key.remoteJid;
    let isAdmin = false;
    let botIsAdmin = false;
    
    try {
        // Ambil metadata terbaru
        const metadata = await sock.groupMetadata(remoteJid);
        const sender = msg.key.participant || msg.key.remoteJid;
        const p = metadata.participants.find(x => x.id === sender);
        isAdmin = p ? !!p.admin : false;
        
        // Ambil semua kemungkinan ID bot (JID dan LID) dan BERSIHKAN :suffix
        const myJid = sock.user.id.replace(/:[0-9]+/, '');
        const myLid = sock.user.lid ? sock.user.lid.replace(/:[0-9]+/, '') : null;
        
        // Cari bot di daftar peserta: cocokkan dengan JID atau LID
        const botP = metadata.participants.find(x => x.id === myJid || (myLid && x.id === myLid));
        botIsAdmin = botP ? (botP.admin === 'admin' || botP.admin === 'superadmin') : false;
        
        console.log(`[GROUP DEBUG] Bot JID: ${myJid}, Bot LID: ${myLid}, Bot Found: ${!!botP}, Status Admin: ${botP?.admin}`);
        
        if (!botP) {
            console.log(`[GROUP DEBUG] Bot TIDAK ditemukan di daftar peserta grup!`);
            const allIds = metadata.participants.map(x => x.id);
            console.log(`[GROUP DEBUG] Daftar ID di grup: ${allIds.slice(0, 5).join(', ')}...`);
        }
    } catch (e) { 
        console.error(`[GROUP ERROR] Gagal ambil metadata: ${e.message}`);
    }

    const isAuthorized = isBotOwner || isAdmin;
    
    console.log(`[GROUP CMD] Command: ${command}, Sender: ${sender}, isOwner: ${isBotOwner}, isAdmin: ${isAdmin}`);

    if (!isAuthorized) {
        await sock.sendMessage(remoteJid, { text: `❌ Perintah ini hanya untuk Admin Grup.` }, { quoted: msg });
        return true;
    }

    // Perintah yang butuh bot jadi admin
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
    } catch (e) {
        await sock.sendMessage(remoteJid, { text: `❌ Terjadi error: ${e.message}` }, { quoted: msg });
    }

    return true;
}

module.exports = {
    handleGroupModeration,
    handleGroupParticipantsUpdate,
    handleGroupCommand
};
