const fs = require('fs');
const path = require('path');
const cfg = require('../utils/config');

const USAGE_PATH = path.join(__dirname, '../../data/usage.json');

let usage = {}; // { jid: { count: 0, date: 'YYYY-MM-DD' } }

function loadUsage() {
    try {
        if (fs.existsSync(USAGE_PATH)) {
            usage = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[LIMIT] Gagal load usage:', e.message);
    }
}

function saveUsage() {
    try {
        const dir = path.dirname(USAGE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2), 'utf-8');
    } catch (e) {
        console.error('[LIMIT] Gagal simpan usage:', e.message);
    }
}

loadUsage();

/**
 * Cek apakah user sudah mencapai limit
 * @param {string} senderJid 
 * @param {boolean} isAuthorized - owner/admin bypass
 * @returns {{isLimit: boolean, remaining: number}}
 */
function checkLimit(senderJid, isAuthorized) {
    if (isAuthorized) return { isLimit: false, remaining: 999 };
    
    const config = cfg.getConfig();
    if (!config.useLimit) return { isLimit: false, remaining: 999 };

    const jid = cfg.cleanNumber(senderJid);
    const today = new Date().toISOString().split('T')[0];

    // Reset jika hari sudah berganti
    if (!usage[jid] || usage[jid].date !== today) {
        usage[jid] = { count: 0, date: today };
    }

    if (usage[jid].count >= config.limitCount) {
        return { isLimit: true, remaining: 0 };
    }

    return { isLimit: false, remaining: config.limitCount - usage[jid].count };
}

/**
 * Tambah penggunaan user
 * @param {string} senderJid 
 * @param {boolean} isAuthorized 
 */
function addUsage(senderJid, isAuthorized) {
    if (isAuthorized) return;
    
    const config = cfg.getConfig();
    if (!config.useLimit) return;

    const jid = cfg.cleanNumber(senderJid);
    const today = new Date().toISOString().split('T')[0];

    if (!usage[jid] || usage[jid].date !== today) {
        usage[jid] = { count: 0, date: today };
    }

    usage[jid].count++;
    saveUsage();
}

/**
 * Reset limit untuk user tertentu atau semua user
 * @param {string} jid - opsional
 */
function resetLimit(jid = null) {
    if (jid) {
        const clean = cfg.cleanNumber(jid);
        delete usage[clean];
    } else {
        usage = {};
    }
    saveUsage();
}

module.exports = {
    checkLimit,
    addUsage,
    resetLimit
};
