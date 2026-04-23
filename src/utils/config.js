'use strict';

/**
 * Config Manager — menyimpan konfigurasi bot secara persisten ke data/config.json
 * Mendukung: nama bot, nama sticker, daftar admin, owner, dsb.
 * 
 * CATATAN @lid:
 *   WhatsApp versi baru mengirim JID dalam format @lid (ID internal, bukan nomor HP).
 *   Solusi: saat addAdmin dipanggil, simpan DUA entri — nomor HP (628xx) dan @lid.
 *   isAdmin() akan mencocokkan keduanya sehingga admin selalu dikenali.
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
    ownerLid:          '',   // @lid owner (diisi otomatis oleh bot dari log)
    channelJid:        '',
    prefix:            '.',
    helpRestricted:   true, // true = .help hanya untuk admin/owner
    admins:            [],   // array campuran: nomor HP (628xx) dan/atau @lid
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

// ── Bersihkan & normalisasi nomor ─────────────────────────────────────────────
// Menghapus @domain, format :device, dan karakter non-angka.
// Normalisasi nomor lokal Indonesia: 08xxx → 628xxx
function cleanNumber(raw) {
    let n = String(raw || '')
        .replace(/:[0-9]+@.*$/, '') // handle 628xxx:12@s.whatsapp.net
        .replace(/@.*$/, '')        // hapus @s.whatsapp.net, @lid, dsb.
        .replace(/[^0-9]/g, '');    // hanya angka

    // Normalisasi: 08xxx → 628xxx (format lokal Indonesia → format WA internasional)
    if (n.startsWith('0') && n.length >= 9) {
        n = '62' + n.slice(1);
    }

    return n;
}

// ── Init: load dari .env defaults + file tersimpan ────────────────────────────
function initConfig(envDefaults = {}) {
    // Merge env defaults dulu
    _cfg = { ..._cfg, ...envDefaults };

    // Load dari file (jika ada), override kecuali ownerNumber (env wins untuk keamanan)
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const ownerFromEnv = _cfg.ownerNumber;
            _cfg = { ..._cfg, ...saved };
            if (ownerFromEnv) _cfg.ownerNumber = ownerFromEnv; // env selalu menang
        }
    } catch (e) {
        console.error('[CONFIG] Gagal load config file:', e.message);
    }

    // Normalisasi semua nomor admin yang tersimpan (migrasi 08xx → 628xx)
    // Nomor @lid (panjang > 13 digit) dibiarkan apa adanya
    _cfg.admins = _cfg.admins
        .map(a => cleanNumber(a))
        .filter(a => a.length > 0);

    // Hapus duplikat
    _cfg.admins = [...new Set(_cfg.admins)];

    _save();

    console.log(`[CONFIG] Init OK — botName="${_cfg.botName}", admins=${_cfg.admins.length}, owner=${_cfg.ownerNumber}`);
    console.log(`[CONFIG] Admin list: [${_cfg.admins.join(', ')}]`);
    return _cfg;
}

function getConfig() { return _cfg; }

/** Update satu field dan simpan ke file */
function update(key, value) {
    _cfg[key] = value;
    _save();
    return _cfg;
}

// ── Admin management ──────────────────────────────────────────────────────────

/**
 * Tambah admin. Menerima nomor HP biasa (628xx / 08xx) atau @lid.
 * Selalu simpan dalam format bersih (tanpa @domain).
 */
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

/**
 * Cek apakah senderJid adalah owner.
 * Mendukung dua format: nomor HP (628xx) dan @lid.
 */
function isOwner(senderJid) {
    const sn = cleanNumber(senderJid);
    if (!sn) return false;

    // Cek dengan ownerNumber (nomor HP dari .env)
    const on = cleanNumber(_cfg.ownerNumber);
    if (on && sn === on) return true;

    // Cek dengan ownerLid (nomor @lid yang bisa di-set otomatis)
    if (_cfg.ownerLid) {
        const ol = cleanNumber(_cfg.ownerLid);
        if (ol && sn === ol) return true;
    }

    return false;
}

/**
 * Cek apakah senderJid adalah admin.
 * admins[] bisa berisi nomor HP (628xx) ATAU nomor @lid — keduanya dikenali.
 */
function isAdmin(senderJid) {
    const sn = cleanNumber(senderJid);
    if (!sn) return false;
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
