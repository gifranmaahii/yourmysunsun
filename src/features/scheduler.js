'use strict';

/**
 * Scheduler — menjadwalkan pengiriman media/teks ke channel WhatsApp
 * Tipe jadwal: sekali, harian, mingguan
 * Timezone: WIB (UTC+7)
 */

const fs = require('fs');
const path = require('path');
const { generateWaveform } = require('../utils/audioConverter');

const SCHEDULES_FILE = path.join(__dirname, '../../data/schedules.json');
const MEDIA_DIR = path.join(__dirname, '../../data/scheduled_media');

const HARI = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];

let _schedules = [];
let _intervalId = null;
let _sock = null;

// ── WIB Helpers ───────────────────────────────────────────────────────────────

function getWIB() {
    const now = new Date();
    return new Date(now.getTime() + (7 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
}

function getWIBDateStr(date) {
    const d = date || new Date();
    const wib = new Date(d.getTime() + (7 * 60 * 60 * 1000) + (d.getTimezoneOffset() * 60 * 1000));
    return `${wib.getFullYear()}-${String(wib.getMonth() + 1).padStart(2, '0')}-${String(wib.getDate()).padStart(2, '0')}`;
}

function getWIBString() {
    const wib = getWIB();
    const hh = String(wib.getHours()).padStart(2, '0');
    const mm = String(wib.getMinutes()).padStart(2, '0');
    const dd = String(wib.getDate()).padStart(2, '0');
    const mo = String(wib.getMonth() + 1).padStart(2, '0');
    const yy = wib.getFullYear();
    const dayName = HARI[wib.getDay()];
    return {
        hh, mm, dd, mo, yy, dayName,
        full: `${dayName}, ${dd}/${mo}/${yy} ${hh}:${mm} WIB`,
        timeOnly: `${hh}:${mm}`,
        dayIndex: wib.getDay(),
    };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSchedules() {
    try {
        if (fs.existsSync(SCHEDULES_FILE)) {
            _schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('[SCHEDULER] Gagal load:', e.message);
        _schedules = [];
    }
    return _schedules;
}

function saveSchedules() {
    try {
        const dir = path.dirname(SCHEDULES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(_schedules, null, 2), 'utf-8');
    } catch (e) {
        console.error('[SCHEDULER] Gagal save:', e.message);
    }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function generateId() {
    const { randomBytes } = require('crypto');
    return 'j_' + randomBytes(4).toString('hex');
}

function addSchedule({ type, time, day, channelJid, mediaType, mediaBuffer, scheduledText }) {
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

    const id = generateId();
    const schedule = {
        id,
        type,           // 'sekali' | 'harian' | 'mingguan'
        time,           // 'HH:MM'
        day: day ?? null, // 0-6 untuk mingguan
        channelJid,
        mediaType,      // 'audio' | 'sticker' | 'text'
        mediaFile: null,
        scheduledText: scheduledText || '',
        createdAt: new Date().toISOString(),
        lastSent: null,
    };

    if (mediaBuffer) {
        const ext = mediaType === 'audio' ? '.ogg' : '.webp';
        const filename = id + ext;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), mediaBuffer);
        schedule.mediaFile = filename;
    }

    _schedules.push(schedule);
    saveSchedules();
    return schedule;
}

function removeSchedule(id) {
    const s = _schedules.find(s => s.id === id);
    if (s && s.mediaFile) {
        try { fs.unlinkSync(path.join(MEDIA_DIR, s.mediaFile)); } catch (_) {}
    }
    _schedules = _schedules.filter(s => s.id !== id);
    saveSchedules();
    return _schedules;
}

function removeAllSchedules() {
    for (const s of _schedules) {
        if (s.mediaFile) {
            try { fs.unlinkSync(path.join(MEDIA_DIR, s.mediaFile)); } catch (_) {}
        }
    }
    _schedules = [];
    saveSchedules();
}

function getSchedules() {
    return _schedules;
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function executeSchedule(sock, schedule) {
    const { channelJid, mediaType, mediaFile, scheduledText } = schedule;

    if (mediaType === 'text') {
        await sock.sendMessage(channelJid, { text: scheduledText });
    } else if (mediaType === 'audio') {
        const buf = fs.readFileSync(path.join(MEDIA_DIR, mediaFile));
        await sock.sendMessage(channelJid, {
            audio: buf,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            waveform: generateWaveform(),
        });
    } else if (mediaType === 'sticker') {
        const buf = fs.readFileSync(path.join(MEDIA_DIR, mediaFile));
        await sock.sendMessage(channelJid, { sticker: buf });
    }
}

// ── Scheduler Loop ────────────────────────────────────────────────────────────

function startScheduler(sock) {
    _sock = sock;
    loadSchedules();
    console.log(`[SCHEDULER] ⏰ Loaded ${_schedules.length} jadwal — cek setiap 30 detik`);

    if (_intervalId) clearInterval(_intervalId);

    _intervalId = setInterval(async () => {
        const wib = getWIBString();
        const currentTime = wib.timeOnly;
        const currentDay = wib.dayIndex;
        const todayStr = getWIBDateStr(new Date());

        for (const sched of [..._schedules]) {
            if (sched.time !== currentTime) continue;

            // Cek apakah sudah dikirim hari ini
            if (sched.lastSent) {
                const lastDateStr = getWIBDateStr(new Date(sched.lastSent));
                if (lastDateStr === todayStr) continue;
            }

            // Untuk mingguan: cek hari
            if (sched.type === 'mingguan' && sched.day !== currentDay) continue;

            // Untuk sekali: skip jika sudah pernah dikirim
            if (sched.type === 'sekali' && sched.lastSent) continue;

            try {
                await executeSchedule(_sock, sched);
                sched.lastSent = new Date().toISOString();

                if (sched.type === 'sekali') {
                    removeSchedule(sched.id);
                } else {
                    saveSchedules();
                }
                console.log(`[SCHEDULER] ✅ ${sched.id} terkirim → ${sched.channelJid}`);
            } catch (err) {
                console.error(`[SCHEDULER] ❌ ${sched.id} gagal:`, err.message);
            }
        }
    }, 30000);
}

function stopScheduler() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
}

// ── Parse Args ────────────────────────────────────────────────────────────────

function parseScheduleArgs(args) {
    let type = 'sekali';
    let day = null;
    let channelJid = null;
    const textParts = [];

    for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === 'harian') {
            type = 'harian';
        } else if (lower === 'sekali') {
            type = 'sekali';
        } else if (HARI.includes(lower)) {
            type = 'mingguan';
            day = HARI.indexOf(lower);
        } else if (arg.includes('@')) {
            channelJid = arg;
        } else {
            textParts.push(arg);
        }
    }

    return { type, day, channelJid, textParts };
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatSchedule(s, idx) {
    const typeLabel = s.type === 'mingguan'
        ? `Mingguan (${HARI[s.day] ? HARI[s.day].charAt(0).toUpperCase() + HARI[s.day].slice(1) : '?'})`
        : s.type === 'harian' ? 'Harian' : 'Sekali';
    const mediaLabel = s.mediaType === 'audio' ? '🎵 Audio'
        : s.mediaType === 'sticker' ? '🖼️ Stiker'
        : `💬 Teks`;
    const textPreview = s.scheduledText ? ` — "${s.scheduledText.slice(0, 40)}${s.scheduledText.length > 40 ? '...' : ''}"` : '';
    return `${idx}. 🆔 \`${s.id}\`\n   📋 ${typeLabel} | ⏰ ${s.time} WIB\n   📡 ${s.channelJid}\n   ${mediaLabel}${textPreview}`;
}

module.exports = {
    loadSchedules, addSchedule, removeSchedule, removeAllSchedules,
    getSchedules, startScheduler, stopScheduler,
    parseScheduleArgs, getWIBString, formatSchedule, HARI,
};
