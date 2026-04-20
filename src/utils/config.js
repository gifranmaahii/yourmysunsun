'use strict';

/**
 * Config Manager — menyimpan konfigurasi bot secara persisten ke data/config.json
 * Mendukung: nama bot, nama sticker, daftar admin, owner, dsb.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/config.json');

// ── State in-memory ───────────────────────────────────────────────────────────
let _cfg = {
    botName:           'Robby Bot',
    stickerPackName:   'Robby Bot',
    stickerPackAuthor: 'Robby Bot',
    ownerNumber:       '',
    channelJid:        '',
    prefix:            '.',
    admins:            [],   // array nomor HP tanpa @s.whatsapp.net
};

// ── Persist ke file ───────────────────────────────────────────────────────────
function _save() {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cfg, null, 2), 'utf-8');
    } catch (e) {
        console.error('[CONFIG] Gagal simpan config:', e.message);
    }
}

// ── Bersihkan nomor HP (hapus @... dan karakter non-angka) ────────────────────
function cleanNumber(raw) {
    return String(raw || '')
        .replace(/:[\d]+@.*$/, '')  // handle 628xxx:12@s.whatsapp.net
        .replace(/@.*$/, '')        // hapus @s.whatsapp.net dll
        .replace(/[^0-9]/g, '');    // hanya angka
}

// ── Init: load dari .env defaults + file tersimpan ────────────────────────────
function initConfig(envDefaults = {}) {
    // Merge env defaults dulu
    _cfg = { ..._cfg, ...envDefaults };

    // Load dari file (jika ada), override kecuali ownerNumber (env wins untuk keamanan)
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const ownerFromEnv = _cfg.ownerNumber; // simpan dulu dari env
            _cfg = { ..._cfg, ...saved };
            if (ownerFromEnv) _cfg.ownerNumber = ownerFromEnv; // env selalu menang
        }
    } catch (e) {
        console.error('[CONFIG] Gagal load config file:', e.message);
    }

    console.log(`[CONFIG] Init OK — botName="${_cfg.botName}", admins=${_cfg.admins.length}, owner=${_cfg.ownerNumber}`);
    return _cfg;
}

function getConfig()             { return _cfg; }

/** Update satu field dan simpan ke file */
function update(key, value) {
    _cfg[key] = value;
    _save();
    return _cfg;
}

// ── Admin management ──────────────────────────────────────────────────────────
function addAdmin(numberRaw) {
    const n = cleanNumber(numberRaw);
    if (!n) return _cfg.admins;
    if (!_cfg.admins.includes(n)) {
        _cfg.admins.push(n);
        _save();
    }
    return _cfg.admins;
}

function removeAdmin(numberRaw) {
    const n = cleanNumber(numberRaw);
    _cfg.admins = _cfg.admins.filter(a => a !== n);
    _save();
    return _cfg.admins;
}

// ── Cek peran pengirim ────────────────────────────────────────────────────────
function isOwner(senderJid) {
    const sn = cleanNumber(senderJid);
    const on = cleanNumber(_cfg.ownerNumber);
    return sn !== '' && on !== '' && sn === on;
}

function isAdmin(senderJid) {
    const sn = cleanNumber(senderJid);
    return _cfg.admins.includes(sn);
}

/** Owner ATAU admin */
function isAuthorized(senderJid) {
    return isOwner(senderJid) || isAdmin(senderJid);
}

module.exports = {
    initConfig,
    getConfig,
    update,
    addAdmin,
    removeAdmin,
    isOwner,
    isAdmin,
    isAuthorized,
    cleanNumber,
};
