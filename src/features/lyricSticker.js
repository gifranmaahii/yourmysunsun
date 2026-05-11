'use strict';

const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { addExif } = require('./sticker');
const { getConfig } = require('../utils/config');
const { logger } = require('../utils/logger');

// ── Rain frames dari video asli (screen blend — bg gelap hilang otomatis) ────
// src/features/ -> ../../assets = root/assets
const _RAIN_FRAMES_CANDIDATES = [
    path.join(__dirname, '../../assets'),
    path.join(__dirname, '../assets'),
    path.join(process.cwd(), 'assets'),
];
let _rainFrames = null;

async function getRainFrames() {
    if (_rainFrames !== null) return _rainFrames;
    _rainFrames = [];
    let dir = null;
    for (const d of _RAIN_FRAMES_CANDIDATES) {
        if (fs.existsSync(path.join(d, 'rain_frame_01.jpg'))) { dir = d; break; }
    }
    if (!dir) {
        logger.warn('[Rain] rain_frame_01.jpg not found in: ' + _RAIN_FRAMES_CANDIDATES.join(', '));
        return _rainFrames;
    }
    logger.info('[Rain] Found frames dir: ' + dir);
    for (let i = 1; i <= 16; i++) {
        const fp = path.join(dir, `rain_frame_${String(i).padStart(2,'0')}.jpg`);
        if (!fs.existsSync(fp)) continue;
        try {
            // BG sudah hitam — simpan as-is, pakai screen blend saat render
            _rainFrames.push(await loadImage(fp));
        } catch(e) { logger.warn('rain frame load fail: ' + fp); }
    }
    logger.info(`Rain frames loaded+processed: ${_rainFrames.length}`);
    return _rainFrames;
}

// ── Multi-font registration ──────────────────────────────────────────────────
const _FONT_DIRS = [
    path.join(__dirname, '../../assets/fonts'),   // bundled (Linux/panel)
    'C:\\Windows\\Fonts',                          // Windows fallback
    '/usr/share/fonts/truetype',                   // Linux system fallback
    '/usr/share/fonts',
];
const FONT_DEFS = [
    { key: 'serif',     aliases: ['georgia','classic','elegan','romantis'],   paths: ['georgiab.ttf','georgia.ttf'],    family: 'LF_Serif',    weight: 'bold'   },
    { key: 'impact',    aliases: ['heavy','tebal','besar'],                    paths: ['impact.ttf'],                   family: 'LF_Impact',   weight: 'normal' },
    { key: 'comic',     aliases: ['comic','fun','lucu','santai'],              paths: ['comicbd.ttf','comic.ttf'],      family: 'LF_Comic',    weight: 'bold'   },
    { key: 'verdana',   aliases: ['clean','rapi'],                             paths: ['verdanab.ttf','verdana.ttf'],   family: 'LF_Verdana',  weight: 'bold'   },
    { key: 'tahoma',    aliases: ['compact','tahoma'],                         paths: ['tahomabd.ttf','tahoma.ttf'],    family: 'LF_Tahoma',   weight: 'bold'   },
    { key: 'arial',     aliases: ['sans','biasa'],                             paths: ['arialbd.ttf','arial.ttf'],      family: 'LF_Arial',    weight: 'bold'   },
    { key: 'courier',   aliases: ['mono','typewriter','ketik','mesin'],        paths: ['courbd.ttf','cour.ttf'],        family: 'LF_Courier',  weight: 'bold'   },
    { key: 'trebuchet', aliases: ['trebo','stylish'],                          paths: ['trebucbd.ttf','trebuc.ttf'],    family: 'LF_Trebuch',  weight: 'bold'   },
    { key: 'montserrat', aliases: ['mont','modern','nightclub','club'],        paths: ['montserrat.woff2','Montserrat-Bold.ttf'], family: 'LF_Montserrat', weight: 'bold' },
];

const _fontMap  = {};
const LYRIC_FONT_KEYS = [];
let   _defFont  = { family: 'LF_Serif', weight: 'bold' };

for (const def of FONT_DEFS) {
    let registered = false;
    for (const dir of _FONT_DIRS) {
        if (registered) break;
        for (const p of def.paths) {
            const fullPath = path.join(dir, p);
            try {
                if (fs.existsSync(fullPath)) {
                    GlobalFonts.registerFromPath(fullPath, def.family);
                    const opts = { family: def.family, weight: def.weight };
                    _fontMap[def.key] = opts;
                    for (const a of def.aliases) _fontMap[a] = opts;
                    LYRIC_FONT_KEYS.push(def.key);
                    if (def.key === 'serif') _defFont = opts;
                    registered = true;
                    break;
                }
            } catch (_) {}
        }
    }
}

function resolveFont(key) {
    if (!key) return _defFont;
    return _fontMap[key.toLowerCase().trim()] || _defFont;
}

const FONT_FAMILY = _defFont.family; // kept for legacy fallback

// ── Register emoji font (Apple Color Emoji, fallback Noto) ────────────────────
const _emojiCandidates = [
    path.join(__dirname, '../../assets/fonts/AppleColorEmoji.ttf'),
    path.join(__dirname, '../../assets/fonts/NotoColorEmoji.ttf'),
];
let _emojiFamily = null;
for (const ep of _emojiCandidates) {
    try {
        if (fs.existsSync(ep)) {
            GlobalFonts.registerFromPath(ep, 'LF_Emoji');
            _emojiFamily = 'LF_Emoji';
            break;
        }
    } catch (_) {}
}
const _emojiFallback = _emojiFamily ? `"${_emojiFamily}", ` : '';

const BG_COLOR   = '#FAE8CC';   // warm cream
const TEXT_COLOR = '#5A1A2A';   // dark brownish-red

// ── Color helpers ─────────────────────────────────────────────────────────────
const COLOR_MAP = {
    merah: '#C0392B', biru: '#2471A3', hijau: '#1E8449',
    kuning: '#D4AC0D', hitam: '#1A1A1A', putih: '#FFFFFF',
    pink: '#E91E8C', ungu: '#7D3C98', orange: '#CA6F1E',
    cream: '#FAE8CC', abu: '#717D7E', coklat: '#784212',
    navy: '#1B2631', tosca: '#0E6655',
    grey: '#717D7E', gray: '#717D7E',
    red: '#C0392B', blue: '#2471A3', green: '#1E8449',
    yellow: '#D4AC0D', black: '#1A1A1A', white: '#FFFFFF',
    purple: '#7D3C98', brown: '#784212',
};

function parseColor(str) {
    if (!str) return null;
    const lc = str.toLowerCase().trim();
    if (COLOR_MAP[lc]) return COLOR_MAP[lc];
    if (/^#[0-9A-Fa-f]{6}$/.test(str.trim())) return str.trim();
    if (/^[0-9A-Fa-f]{6}$/.test(str.trim())) return '#' + str.trim();
    return null;
}

function isColorDark(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function parseGradient(str) {
    if (!str || !str.includes('>')) return null;
    const [a, b] = str.split('>');
    const c1 = parseColor(a.trim());
    const c2 = parseColor(b.trim());
    return (c1 && c2) ? [c1, c2] : null;
}

// ── Preset themes ─────────────────────────────────────────────────────────────
const THEMES = {
    dark:    { bgColor: '#121212',  textColor: '#FFFFFF', bgGradient: null },
    sakura:  { bgColor: '#FFB7C5',  textColor: '#5A1A2A', bgGradient: null },
    neon:    { bgColor: '#0A0A0A',  textColor: '#00FF88', bgGradient: null },
    sunset:  { bgColor: null,       textColor: '#FFFFFF', bgGradient: ['#FF6B35', '#C0392B'] },
    ocean:   { bgColor: null,       textColor: '#FFFFFF', bgGradient: ['#1B2631', '#1A5276'] },
    minimal: { bgColor: '#F5F5F5',  textColor: '#1A1A1A', bgGradient: null },
    gold:    { bgColor: '#1A1100',  textColor: '#FFD700', bgGradient: null },
    violet:  { bgColor: null,       textColor: '#FFFFFF', bgGradient: ['#4A0E8F', '#7D3C98'] },
    forest:  { bgColor: null,       textColor: '#FFFFFF', bgGradient: ['#1E8449', '#145A32'] },
    rose:    { bgColor: null,       textColor: '#FFFFFF', bgGradient: ['#C0392B', '#8E44AD'] },
};
const LYRIC_THEME_KEYS  = Object.keys(THEMES);
const LYRIC_EFFECT_KEYS = ['shadow', 'outline', 'glow', 'neon2', 'emboss', 'blur', 'gradient', 'y2k'];
const LYRIC_ANIM_KEYS   = ['rain', 'fire', 'snow', 'bubbles', 'lightning', 'none'];

// ── Word wrap helper ─────────────────────────────────────────────────────────
function wordWrap(ctx, text, maxWidth) {
    const words = text.trim().split(/\s+/);
    const lines = [];
    let cur = [];
    for (const w of words) {
        const test = [...cur, w].join(' ');
        if (ctx.measureText(test).width > maxWidth && cur.length > 0) {
            lines.push(cur.join(' '));
            cur = [w];
        } else {
            cur.push(w);
        }
    }
    if (cur.length > 0) lines.push(cur.join(' '));
    return lines;
}

// ── Animated rain system ──────────────────────────────────────────────────────
const FPS = 8; // frames per second for rain animation

function hexToRgb(hex) {
    const h = (hex || '#5A1A2A').replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// Deterministic pseudo-random drip positions (no Math.random — consistent across frames)
function createDripSet(lineX, lineWidth, fontSize) {
    const count = Math.max(5, Math.round(lineWidth / 22));
    const drips = [];
    for (let d = 0; d < count; d++) {
        const r1 = Math.abs(Math.sin(d * 127.1 + 311.7)) % 1;
        const r2 = Math.abs(Math.sin(d * 269.5 + 183.3)) % 1;
        const r3 = Math.abs(Math.sin(d * 419.2 +  97.1)) % 1;
        const r4 = Math.abs(Math.sin(d * 537.4 + 233.7)) % 1;
        drips.push({
            x:           lineX + r1 * lineWidth,
            phaseOffset: r2,                           // stagger drip phases
            speed:       0.55 + r3 * 0.9,             // vary fall speed
            maxLen:      fontSize * (0.38 + r4 * 0.52),
            width:       0.5 + r1 * 1.6,
            wobble:      (r2 - 0.5) * 7,
        });
    }
    return drips;
}

// Animated rain drip — curvy streaks that grow, hold, then fade
function drawAnimatedRain(ctx, drips, lineY, fontSize, textColor, animPhase) {
    const [r, g, b] = hexToRgb(textColor);
    for (const drip of drips) {
        const phase  = (animPhase * drip.speed + drip.phaseOffset) % 1;
        const startY = lineY + fontSize * 0.04;
        const len    = drip.maxLen * Math.min(phase * 2.8, 1);

        // fade-in 0–0.18, hold 0.18–0.72, fade-out 0.72–1.0
        let alpha;
        if      (phase < 0.18) alpha = (phase / 0.18) * 0.65;
        else if (phase < 0.72) alpha = 0.65;
        else                    alpha = ((1 - phase) / 0.28) * 0.65;

        if (alpha < 0.03 || len < 1) continue;

        const grad = ctx.createLinearGradient(drip.x, startY, drip.x, startY + len);
        grad.addColorStop(0,    `rgba(${r},${g},${b},${alpha.toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(${r},${g},${b},${(alpha * 0.38).toFixed(3)})`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);

        ctx.save();
        ctx.strokeStyle = grad;
        ctx.lineWidth   = drip.width;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(drip.x, startY);
        ctx.quadraticCurveTo(
            drip.x + drip.wobble * phase,
            startY + len * 0.52,
            drip.x + drip.wobble * phase * 0.55,
            startY + len
        );
        ctx.stroke();
        ctx.restore();
    }
}

// ── Color & sparkle helpers ──────────────────────────────────────────────
function lightenHex(hex, amt) {
    if (!hex || hex.length !== 7) return '#FFFFFF';
    const r = Math.min(255, parseInt(hex.slice(1,3), 16) + amt);
    const g = Math.min(255, parseInt(hex.slice(3,5), 16) + amt);
    const b = Math.min(255, parseInt(hex.slice(5,7), 16) + amt);
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}
function seededRand(seed) {
    const x = Math.sin(seed * 9301 + 49297) * 233280;
    return x - Math.floor(x);
}
function drawY2KSparkles(ctx, cx, lineY, textW, fontSize, animPhase, textColor) {
    const chars  = ['✶','✧','✶','★','✧','✶','✶','✧','✶','✧'];
    const count  = 10;
    const spread = textW * 0.55 + fontSize * 1.8;
    const sz     = Math.max(8, fontSize * 0.26);
    ctx.save();
    ctx.font         = `bold ${sz}px "${_emojiFamily || 'Arial'}", Arial, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = textColor;
    for (let i = 0; i < count; i++) {
        const px    = cx + (seededRand(i * 7 + 1) - 0.5) * spread;
        const py    = lineY + (seededRand(i * 13 + 3) - 0.5) * fontSize * 1.3;
        const phase = (animPhase + i / count) % 1;
        const alpha = Math.pow(Math.abs(Math.sin(phase * Math.PI)), 0.6);
        if (alpha < 0.08) continue;
        ctx.globalAlpha = alpha;
        ctx.fillText(chars[i % chars.length], px, py);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ── Additional animation effects ───────────────────────────────────────────────
function drawAnimatedFire(ctx, lineX, lineY, textW, fontSize, animPhase) {
    const count = Math.max(7, Math.floor(textW / 16));
    for (let i = 0; i < count; i++) {
        const baseX = lineX + seededRand(i * 5779) * textW;
        const phase  = (animPhase + seededRand(i * 3001)) % 1;
        const height = fontSize * (0.65 + seededRand(i * 9001) * 0.9);
        const py   = lineY + fontSize * 0.25 - phase * height;
        const px   = baseX + Math.sin(phase * Math.PI * 3 + seededRand(i * 4001) * 6) * fontSize * 0.1;
        const sz   = Math.max(2, (1 - phase) * fontSize * 0.16);
        const fade = phase < 0.12 ? phase / 0.12 : phase > 0.65 ? (1 - phase) / 0.35 : 1;
        if (fade < 0.04) continue;
        const g = Math.floor(200 * Math.max(0, 1 - phase));
        ctx.save();
        ctx.globalAlpha = fade * 0.88;
        ctx.fillStyle   = `rgb(255,${g},0)`;
        ctx.shadowColor = 'rgba(255,140,0,0.5)';
        ctx.shadowBlur  = sz * 2.5;
        ctx.beginPath();
        ctx.arc(px, py, sz, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
function drawAnimatedSnow(ctx, lineX, lineY, textW, fontSize, animPhase) {
    const count = Math.max(6, Math.floor(textW / 22));
    for (let i = 0; i < count; i++) {
        const baseX = lineX + seededRand(i * 6271) * textW;
        const phase  = (animPhase + seededRand(i * 2011)) % 1;
        const py   = lineY - fontSize * 0.7 + phase * fontSize * 1.8;
        const px   = baseX + Math.sin(phase * Math.PI * 2.5 + seededRand(i * 3333) * 4) * fontSize * 0.06;
        const sz   = Math.max(2, (seededRand(i * 7777) * 0.5 + 0.5) * fontSize * 0.07);
        const fade = phase < 0.1 ? phase * 10 : phase > 0.88 ? (1 - phase) / 0.12 : 1;
        if (fade < 0.04) continue;
        ctx.save();
        ctx.globalAlpha = fade * 0.82;
        ctx.fillStyle   = 'rgb(220,240,255)';
        ctx.shadowColor = 'rgba(200,220,255,0.6)';
        ctx.shadowBlur  = sz * 1.5;
        ctx.beginPath();
        ctx.arc(px, py, sz, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
function drawAnimatedBubbles(ctx, lineX, lineY, textW, fontSize, animPhase, textColor) {
    const count = Math.max(4, Math.floor(textW / 28));
    for (let i = 0; i < count; i++) {
        const baseX = lineX + seededRand(i * 5347) * textW;
        const phase  = (animPhase + seededRand(i * 2999)) % 1;
        const py   = lineY + fontSize * 0.3 - phase * fontSize * 1.8;
        const px   = baseX + Math.sin(phase * Math.PI * 4 + seededRand(i * 4111) * 5) * fontSize * 0.06;
        const sz   = Math.max(3, (seededRand(i * 8888) * 0.4 + 0.35) * fontSize * 0.14);
        const fade = phase < 0.08 ? phase / 0.08 : phase > 0.85 ? (1 - phase) / 0.15 : 1;
        if (fade < 0.04) continue;
        ctx.save();
        ctx.globalAlpha = fade * 0.58;
        ctx.strokeStyle = textColor;
        ctx.lineWidth   = Math.max(1, sz * 0.18);
        ctx.beginPath();
        ctx.arc(px, py, sz, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = fade * 0.07;
        ctx.fillStyle   = textColor;
        ctx.fill();
        ctx.restore();
    }
}
function drawAnimatedLightning(ctx, lineX, lineY, textW, fontSize, animPhase) {
    for (let j = 0; j < 3; j++) {
        const flashPhase = (animPhase + j / 3) % 1;
        if (flashPhase > 0.14) continue;
        const alpha = flashPhase < 0.07 ? flashPhase / 0.07 : (0.14 - flashPhase) / 0.07;
        if (alpha < 0.05) continue;
        const seed = Math.floor(animPhase * 5 + 100) + j * 17;
        const sx   = lineX + seededRand(seed * 3) * textW;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = 'rgba(255,255,180,0.95)';
        ctx.lineWidth   = Math.max(1.5, fontSize * 0.04);
        ctx.shadowColor = 'rgba(255,255,0,0.9)';
        ctx.shadowBlur  = fontSize * 0.3;
        ctx.beginPath();
        let cx = sx, cy = lineY - fontSize * 0.6;
        ctx.moveTo(cx, cy);
        for (let s = 0; s < 6; s++) {
            cx += (seededRand(seed * (s + 1) * 7) - 0.5) * fontSize * 0.35;
            cy += fontSize * 0.18;
            ctx.lineTo(cx, cy);
        }
        ctx.stroke();
        ctx.restore();
    }
}

// ── Text effect renderer ─────────────────────────────────────────────────────
function fillTextWithEffect(ctx, text, x, y, fontSize, textColor, effect, animPhase = 0) {
    ctx.save();
    ctx.fillStyle = textColor;
    if (effect === 'shadow') {
        ctx.shadowColor   = 'rgba(0,0,0,0.80)';
        ctx.shadowBlur    = fontSize * 0.14;
        ctx.shadowOffsetX = fontSize * 0.05;
        ctx.shadowOffsetY = fontSize * 0.07;
        ctx.fillText(text, x, y);
    } else if (effect === 'outline') {
        ctx.lineWidth   = Math.max(2, fontSize * 0.048);
        ctx.lineJoin    = 'round';
        ctx.strokeStyle = isColorDark(textColor) ? 'rgba(255,255,255,0.80)' : 'rgba(0,0,0,0.72)';
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
    } else if (effect === 'glow') {
        ctx.shadowColor = textColor;
        ctx.shadowBlur  = fontSize * 0.30;
        ctx.fillText(text, x, y);
        ctx.shadowBlur  = fontSize * 0.14;
        ctx.fillText(text, x, y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur  = 0;
        ctx.fillText(text, x, y);
    } else if (effect === 'neon2') {
        const aura = isColorDark(textColor) ? 'rgba(255,0,255,0.55)' : 'rgba(0,220,255,0.55)';
        ctx.shadowColor = aura;
        ctx.shadowBlur  = fontSize * 0.55;
        ctx.fillText(text, x, y);
        ctx.shadowColor = textColor;
        ctx.shadowBlur  = fontSize * 0.22;
        ctx.fillText(text, x, y);
        ctx.shadowBlur  = fontSize * 0.10;
        ctx.fillText(text, x, y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur  = 0;
        ctx.fillText(text, x, y);
    } else if (effect === 'emboss') {
        const off = Math.max(1, fontSize * 0.04);
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.fillText(text, x - off, y - off);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillText(text, x + off, y + off);
        ctx.fillStyle = textColor;
        ctx.fillText(text, x, y);
    } else if (effect === 'blur') {
        try {
            ctx.filter = `blur(${Math.max(2, fontSize * 0.035)}px)`;
            ctx.fillText(text, x, y);
            ctx.filter = 'none';
        } catch (_) { ctx.fillText(text, x, y); }
    } else if (effect === 'gradient') {
        const light = lightenHex(textColor, 90);
        const grad  = ctx.createLinearGradient(x - fontSize * 3, y - fontSize * 0.5, x + fontSize * 3, y + fontSize * 0.5);
        grad.addColorStop(0,   light);
        grad.addColorStop(0.5, textColor);
        grad.addColorStop(1,   light);
        ctx.fillStyle = grad;
        ctx.fillText(text, x, y);
    } else if (effect === 'y2k') {
        const shimmer = lightenHex(textColor, 100);
        const grad    = ctx.createLinearGradient(x, y - fontSize * 0.5, x, y + fontSize * 0.5);
        grad.addColorStop(0,   shimmer);
        grad.addColorStop(0.3, textColor);
        grad.addColorStop(0.5, shimmer);
        grad.addColorStop(0.7, textColor);
        grad.addColorStop(1,   shimmer);
        ctx.fillStyle   = grad;
        ctx.shadowColor = shimmer;
        ctx.shadowBlur  = fontSize * 0.15;
        ctx.fillText(text, x, y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur  = 0;
    } else {
        ctx.fillText(text, x, y);
    }
    ctx.restore();
}

// ── Shrink-to-fit font size for one group of text ────────────────────────────
function fitFontSize(text, maxW, maxH, startSize = 100, minSize = 22, fontOpts = null) {
    const { family, weight } = fontOpts || _defFont;
    for (let fs = startSize; fs >= minSize; fs -= 3) {
        const tmp    = createCanvas(600, 100);
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.font  = `${weight} ${fs}px "${family}", ${_emojiFallback}Georgia, serif`;
        const wrapped = wordWrap(tmpCtx, text, maxW);
        const lineH   = fs * 1.28;
        if (wrapped.length * lineH <= maxH) return { fontSize: fs, wrapped };
    }
    const tmp    = createCanvas(600, 100);
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.font  = `${weight} ${minSize}px "${family}", ${_emojiFallback}Georgia, serif`;
    return { fontSize: minSize, wrapped: wordWrap(tmpCtx, text, maxW) };
}

// ── Draw single animated lyric frame ── 512×512 PNG buffer ───────────────────
// animPhase: 0‥1 — position in the rain animation cycle
function drawLyricFrame(text, animPhase = 0, fontKey = null, effect = null, bgColOvr = null, txtColOvr = null, bgGradient = null, animEffect = 'rain') {
    const SIZE    = 512;
    const PADDING = 36;
    const maxW    = SIZE - PADDING * 2;
    const maxH    = SIZE - 80;
    const fOpts   = resolveFont(fontKey);
    const bgCol   = bgColOvr  || BG_COLOR;
    const txtCol  = txtColOvr || TEXT_COLOR;

    const { fontSize, wrapped: lines } = fitFontSize(text, maxW, maxH, 100, 22, fOpts);
    const fontStr = `${fOpts.weight} ${fontSize}px "${fOpts.family}", ${_emojiFallback}Georgia, "Times New Roman", serif`;
    const lineH   = fontSize * 1.28;
    const totalH  = lines.length * lineH;

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    if (bgGradient && bgGradient.length === 2) {
        const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
        grad.addColorStop(0, bgGradient[0]);
        grad.addColorStop(1, bgGradient[1]);
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = bgCol;
    }
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.font         = fontStr;
    ctx.fillStyle    = txtCol;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    const startY = (SIZE - totalH) / 2 + lineH * 0.5 - 10;

    for (let i = 0; i < lines.length; i++) {
        const ly = startY + i * lineH;
        fillTextWithEffect(ctx, lines[i], SIZE / 2, ly, fontSize, txtCol, effect, animPhase);
        const mw = Math.min(ctx.measureText(lines[i]).width, maxW);
        const lx = SIZE / 2 - mw / 2;
        if      (!animEffect || animEffect === 'rain') { drawAnimatedRain(ctx, createDripSet(lx, mw, fontSize), ly, fontSize, txtCol, animPhase); }
        else if (animEffect === 'fire')               { drawAnimatedFire(ctx, lx, ly, mw, fontSize, animPhase); }
        else if (animEffect === 'snow')               { drawAnimatedSnow(ctx, lx, ly, mw, fontSize, animPhase); }
        else if (animEffect === 'bubbles')            { drawAnimatedBubbles(ctx, lx, ly, mw, fontSize, animPhase, txtCol); }
        else if (animEffect === 'lightning')          { drawAnimatedLightning(ctx, lx, ly, mw, fontSize, animPhase); }
        if (effect === 'y2k') drawY2KSparkles(ctx, SIZE / 2, ly, mw, fontSize, animPhase, txtCol);
    }

    ctx.font         = `bold 22px Arial, sans-serif`;
    ctx.fillStyle    = txtCol;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', SIZE / 2, SIZE - 40);

    return canvas.toBuffer('image/png');
}

// ── Render one cumulative frame ───────────────────────────────────────────────
// frameIdx = how many lyric groups are visible (0-based)
// allGroups = all wrapped-line arrays for every input line
// Layout always uses full-text height so lines don't "jump" as they appear
function drawCumulativeFrame(frameIdx, allGroups, fontSize, textColor, bgColor, bgImg, animPhase = 0, fontOpts = null, effect = null, bgGradient = null, animEffect = 'rain') {
    const { family: fFam, weight: fWgt } = fontOpts || _defFont;
    const SIZE     = 512;
    const PADDING  = 36;
    const maxW     = SIZE - PADDING * 2;
    const lineH    = fontSize * 1.28;
    const groupGap = lineH * 0.38;

    const totalAllLines = allGroups.reduce((s, g) => s + g.length, 0);
    const totalAllH     = totalAllLines * lineH + (allGroups.length - 1) * groupGap;

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    if (bgImg) {
        const scale = Math.max(SIZE / bgImg.width, SIZE / bgImg.height);
        const sw    = bgImg.width * scale;
        const sh    = bgImg.height * scale;
        ctx.drawImage(bgImg, (SIZE - sw) / 2, (SIZE - sh) / 2, sw, sh);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0, 0, SIZE, SIZE);
    } else if (bgGradient && bgGradient.length === 2) {
        const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
        grad.addColorStop(0, bgGradient[0]);
        grad.addColorStop(1, bgGradient[1]);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, SIZE, SIZE);
    } else {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, SIZE, SIZE);
    }

    const fontStr = `${fWgt} ${fontSize}px "${fFam}", ${_emojiFallback}Georgia, "Times New Roman", serif`;
    ctx.font         = fontStr;
    ctx.fillStyle    = textColor;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    let curY = (SIZE - totalAllH) / 2 + lineH * 0.5;

    for (let g = 0; g < allGroups.length; g++) {
        for (let i = 0; i < allGroups[g].length; i++) {
            if (g <= frameIdx) {
                const lineText = allGroups[g][i];
                fillTextWithEffect(ctx, lineText, SIZE / 2, curY, fontSize, textColor, effect, animPhase);
                const mw = Math.min(ctx.measureText(lineText).width, maxW);
                const lx = SIZE / 2 - mw / 2;
                if      (!animEffect || animEffect === 'rain') { drawAnimatedRain(ctx, createDripSet(lx, mw, fontSize), curY, fontSize, textColor, animPhase); }
                else if (animEffect === 'fire')               { drawAnimatedFire(ctx, lx, curY, mw, fontSize, animPhase); }
                else if (animEffect === 'snow')               { drawAnimatedSnow(ctx, lx, curY, mw, fontSize, animPhase); }
                else if (animEffect === 'bubbles')            { drawAnimatedBubbles(ctx, lx, curY, mw, fontSize, animPhase, textColor); }
                else if (animEffect === 'lightning')          { drawAnimatedLightning(ctx, lx, curY, mw, fontSize, animPhase); }
                if (effect === 'y2k') drawY2KSparkles(ctx, SIZE / 2, curY, mw, fontSize, animPhase, textColor);
            }
            curY += lineH;
        }
        if (g < allGroups.length - 1) curY += groupGap;
    }

    ctx.font         = `bold 20px Arial, sans-serif`;
    ctx.fillStyle    = textColor;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', SIZE / 2, SIZE - 28);

    return canvas.toBuffer('image/png');
}

// ── Create animated WebP sticker — cumulative reveal + animated rain + custom bg ──
async function createLyricStickerStatic(lines, bgColor = BG_COLOR, bgImageBuffer = null, secPerLine = 2, fontKey = null, effect = null, themeKey = null, bgGradient = null, animEffect = 'rain') {
    const PADDING  = 36;
    const maxW     = 512 - PADDING * 2;
    const maxH     = 512 - PADDING * 2 - 46;
    const framesPerGroup = Math.max(2, Math.round(FPS * secPerLine));
    const fOpts    = resolveFont(fontKey);

    // Apply theme (overrides bgColor / textColor / bgGradient)
    const theme = themeKey ? THEMES[themeKey] : null;
    if (theme) {
        if (theme.bgColor)    bgColor    = theme.bgColor;
        if (theme.bgGradient) bgGradient = theme.bgGradient;
    }

    let bgImg = null;
    if (bgImageBuffer) bgImg = await loadImage(bgImageBuffer);

    let textColor = TEXT_COLOR;
    if (bgImg) {
        textColor = '#FFFFFF';
    } else if (theme?.textColor) {
        textColor = theme.textColor;
    } else if (bgGradient) {
        textColor = '#FFFFFF';
    } else if (bgColor.toLowerCase() !== BG_COLOR.toLowerCase()) {
        textColor = isColorDark(bgColor) ? '#FFFFFF' : '#1A1A1A';
    }

    // Fit font for ALL lines
    let fontSize = 88;
    let allGroups = [];
    for (; fontSize >= 18; fontSize -= 3) {
        const tmp    = createCanvas(600, 100);
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.font  = `${fOpts.weight} ${fontSize}px "${fOpts.family}", ${_emojiFallback}Georgia, serif`;
        allGroups = lines.map(l => wordWrap(tmpCtx, l, maxW));
        const lineH  = fontSize * 1.28;
        const gap    = lineH * 0.38;
        const totL   = allGroups.reduce((s, g) => s + g.length, 0);
        if (totL * lineH + (allGroups.length - 1) * gap <= maxH) break;
    }

    const tempId  = randomBytes(6).toString('hex');
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const framePaths = [];
    const concatPath = path.join(tempDir, `lyric2_concat_${tempId}.txt`);
    const outputPath = path.join(tempDir, `lyric2_out_${tempId}.webp`);

    function cleanup() {
        for (const fp of framePaths) { try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {} }
        try { if (fs.existsSync(concatPath)) fs.unlinkSync(concatPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }

    try {
        let globalTick = 0;
        for (let g = 0; g < lines.length; g++) {
            for (let f = 0; f < framesPerGroup; f++) {
                const animPhase = (globalTick / FPS) % 1;
                const buf = drawCumulativeFrame(g, allGroups, fontSize, textColor, bgColor, bgImg, animPhase, fOpts, effect, bgGradient, animEffect);
                const fp  = path.join(tempDir, `lyric2_frame_${tempId}_${globalTick}.png`);
                fs.writeFileSync(fp, buf);
                framePaths.push(fp);
                globalTick++;
            }
        }

        const frameDur  = (1 / FPS).toFixed(4);
        const toFFPath  = p => p.replace(/\\/g, '/');
        let concatTxt   = '';
        for (const fp of framePaths) concatTxt += `file '${toFFPath(fp)}'\nduration ${frameDur}\n`;
        concatTxt += `file '${toFFPath(framePaths[framePaths.length - 1])}'\nduration 0.001\n`;
        fs.writeFileSync(concatPath, concatTxt);

        return await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions([
                    '-vcodec libwebp', '-vf', 'format=rgba',
                    '-lossless 0', '-compression_level 6',
                    '-q:v 75', '-loop 0', '-preset default', '-an', '-vsync 0'
                ])
                .toFormat('webp')
                .on('end', async () => {
                    try {
                        const outBuf = fs.readFileSync(outputPath);
                        cleanup();
                        try {
                            const cfg = getConfig();
                            resolve(await addExif(outBuf, cfg.stickerPackName, cfg.stickerPackAuthor));
                        } catch (_) { resolve(outBuf); }
                        logger.info(`🎵 Lyric2 sticker: ${lines.length} group(s) × ${framesPerGroup} frames`);
                    } catch (e) { cleanup(); reject(e); }
                })
                .on('error', (err) => { logger.error(`❌ Lyric2 ffmpeg: ${err.message}`); cleanup(); reject(err); })
                .save(outputPath);
        });
    } catch (e) { cleanup(); throw e; }
}

// ── Create animated WebP sticker from lyric lines (sequential, one line per group) ──
async function createLyricSticker(lines, secPerLine = 2, fontKey = null, effect = null, themeKey = null, animEffect = 'rain') {
    const framesPerLine = Math.max(2, Math.round(FPS * secPerLine));

    // Resolve theme
    const theme     = themeKey ? THEMES[themeKey] : null;
    const bgColOvr  = theme ? (theme.bgColor || BG_COLOR) : null;
    const txtColOvr = theme ? theme.textColor : null;
    const bgGrad    = theme ? theme.bgGradient : null;

    const tempId  = randomBytes(6).toString('hex');
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const framePaths = [];
    const concatPath = path.join(tempDir, `lyric_concat_${tempId}.txt`);
    const outputPath = path.join(tempDir, `lyric_out_${tempId}.webp`);

    function cleanup() {
        for (const fp of framePaths) { try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {} }
        try { if (fs.existsSync(concatPath)) fs.unlinkSync(concatPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }

    try {
        let globalTick = 0;
        for (let i = 0; i < lines.length; i++) {
            for (let f = 0; f < framesPerLine; f++) {
                const animPhase = (globalTick / FPS) % 1;
                const fp  = path.join(tempDir, `lyric_frame_${tempId}_${globalTick}.png`);
                fs.writeFileSync(fp, drawLyricFrame(lines[i], animPhase, fontKey, effect, bgColOvr, txtColOvr, bgGrad, animEffect));
                framePaths.push(fp);
                globalTick++;
            }
        }

        const frameDur = (1 / FPS).toFixed(4);
        const toFFPath = p => p.replace(/\\/g, '/');
        let concatTxt  = '';
        for (const fp of framePaths) concatTxt += `file '${toFFPath(fp)}'\nduration ${frameDur}\n`;
        concatTxt += `file '${toFFPath(framePaths[framePaths.length - 1])}'\nduration 0.001\n`;
        fs.writeFileSync(concatPath, concatTxt);

        return await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions([
                    '-vcodec libwebp', '-vf', 'format=rgba',
                    '-lossless 0', '-compression_level 6',
                    '-q:v 75', '-loop 0', '-preset default', '-an', '-vsync 0'
                ])
                .toFormat('webp')
                .on('end', async () => {
                    try {
                        const outBuf = fs.readFileSync(outputPath);
                        cleanup();
                        try {
                            const cfg = getConfig();
                            resolve(await addExif(outBuf, cfg.stickerPackName, cfg.stickerPackAuthor));
                        } catch (_) { resolve(outBuf); }
                        logger.info(`🎵 Lyric sticker: ${lines.length} line(s) × ${framesPerLine} frames`);
                    } catch (e) { cleanup(); reject(e); }
                })
                .on('error', (err) => { logger.error(`❌ Lyric ffmpeg: ${err.message}`); cleanup(); reject(err); })
                .save(outputPath);
        });
    } catch (e) { cleanup(); throw e; }
}

// ── Create cover sticker (static, typography) ──────────────────────────────
async function createStickerCover(title, artist = '', opts = {}) {
    const { fontKey = null, effect = null, themeKey = null, bgColor: bgColorIn = BG_COLOR, bgGradient: bgGradientIn = null } = opts;
    const SIZE    = 512;
    const PADDING = 36;
    const fOpts   = resolveFont(fontKey);

    const theme = themeKey ? THEMES[themeKey] : null;
    let bgColor    = theme?.bgColor    || bgColorIn;
    let bgGradient = theme?.bgGradient || bgGradientIn;
    let textColor  = TEXT_COLOR;
    if      (theme?.textColor)                                           textColor = theme.textColor;
    else if (bgGradient)                                                 textColor = '#FFFFFF';
    else if (bgColor.toLowerCase() !== BG_COLOR.toLowerCase())
        textColor = isColorDark(bgColor) ? '#FFFFFF' : '#1A1A1A';

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    if (bgGradient && bgGradient.length === 2) {
        const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
        grad.addColorStop(0, bgGradient[0]);
        grad.addColorStop(1, bgGradient[1]);
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = bgColor;
    }
    ctx.fillRect(0, 0, SIZE, SIZE);

    const maxTitleW = SIZE - PADDING * 2;
    const maxTitleH = SIZE * 0.56;
    const { fontSize: titleFs, wrapped: titleLines } = fitFontSize(title || '?', maxTitleW, maxTitleH, 100, 26, fOpts);
    const titleFontStr = `${fOpts.weight} ${titleFs}px "${fOpts.family}", ${_emojiFallback}Georgia, serif`;
    const titleLineH   = titleFs * 1.28;
    const titleTotalH  = titleLines.length * titleLineH;
    const artistFs     = Math.max(18, Math.min(34, Math.floor(titleFs * 0.40)));

    const decoFs = Math.max(20, titleFs * 0.32);
    ctx.font         = `bold ${decoFs}px "${_emojiFamily || 'Arial'}", Arial, sans-serif`;
    ctx.fillStyle    = textColor;
    ctx.globalAlpha  = 0.45;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', SIZE / 2, 46);
    ctx.globalAlpha  = 1;

    const titleAreaTop = 82;
    const titleAreaBot = SIZE * 0.70;
    const titleStartY  = titleAreaTop + (titleAreaBot - titleAreaTop - titleTotalH) / 2 + titleLineH * 0.5;

    ctx.font         = titleFontStr;
    ctx.fillStyle    = textColor;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < titleLines.length; i++) {
        fillTextWithEffect(ctx, titleLines[i], SIZE / 2, titleStartY + i * titleLineH, titleFs, textColor, effect, 0);
    }

    const sepY = SIZE * 0.755;
    ctx.save();
    ctx.strokeStyle = textColor;
    ctx.globalAlpha = 0.40;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(PADDING * 2.2, sepY);
    ctx.lineTo(SIZE - PADDING * 2.2, sepY);
    ctx.stroke();
    ctx.restore();

    if (artist) {
        ctx.font         = `normal ${artistFs}px "${fOpts.family}", ${_emojiFallback}Georgia, serif`;
        ctx.fillStyle    = textColor;
        ctx.globalAlpha  = 0.88;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(artist, SIZE / 2, SIZE * 0.835);
        ctx.globalAlpha  = 1;
    }

    ctx.font         = `bold ${Math.max(16, titleFs * 0.24)}px "${_emojiFamily || 'Arial'}", ${_emojiFallback}Arial, sans-serif`;
    ctx.fillStyle    = textColor;
    ctx.globalAlpha  = 0.60;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★  ★  ★', SIZE / 2, SIZE * 0.924);
    ctx.globalAlpha  = 1;

    const pngBuf  = canvas.toBuffer('image/png');
    const webpBuf = await sharp(pngBuf).webp({ quality: 90 }).toBuffer();
    const { stickerPackName, stickerPackAuthor } = getConfig();
    return addExif(webpBuf, stickerPackName, stickerPackAuthor);
}

// ─────────────────────────────────────────────────────────────────────────────
// createLyricSticker3 — Nightclub edition
//   • Font     : Montserrat Bold
//   • Lens      : Fisheye warp (barrel distortion via pixel remap)
//   • Camera    : Shake per-frame (random translate + slight rotate)
//   • Particles : Raindrop sparkles on text (green-screen style, bright drops)
// ─────────────────────────────────────────────────────────────────────────────
function drawGreenscreenRain(ctx, SIZE, frameIdx, animPhase) {
    // Rain tipis & bening — sedikit tetesan saja
    const STREAMS = 25;
    for (let i = 0; i < STREAMS; i++) {
        const px    = seededRand(i * 3131) * SIZE;
        const speed = 1.2 + seededRand(i * 2711) * 2.0; // cepat
        const phase = (animPhase * speed + seededRand(i * 1777)) % 1;
        const py    = phase * (SIZE + 120) - 120;

        const len   = 20 + seededRand(i * 5113) * 60;
        const w     = 1.2 + seededRand(i * 9001) * 2.0;
        const alpha = 0.15 + seededRand(i * 7777) * 0.25; // lebih bening/transparan
        const fade  = phase < 0.05 ? phase / 0.05 : phase > 0.90 ? (1 - phase) / 0.10 : 1;
        if (fade * alpha < 0.06) continue;

        ctx.save();
        ctx.globalAlpha = fade * alpha;

        // Kepala bulat bening di ujung atas
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        ctx.arc(px, py, w * 1.1, 0, Math.PI * 2);
        ctx.fill();

        // Batang lurus ke bawah — gradient fade tipis
        const g = ctx.createLinearGradient(px, py, px, py + len);
        g.addColorStop(0,   'rgba(255,255,255,0.50)');
        g.addColorStop(0.4, 'rgba(230,240,255,0.30)');
        g.addColorStop(1,   'rgba(255,255,255,0.0)');
        ctx.strokeStyle = g;
        ctx.lineWidth   = w;
        ctx.lineCap     = 'butt';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + len);
        ctx.stroke();

        ctx.restore();
    }
}

function applyFisheyeToCanvas(srcCanvas) {
    const SIZE   = srcCanvas.width;
    const dst    = createCanvas(SIZE, SIZE);
    const dctx   = dst.getContext('2d');
    const src    = srcCanvas.getContext('2d');
    const srcData = src.getImageData(0, 0, SIZE, SIZE);
    const dstData = dctx.createImageData(SIZE, SIZE);
    const cx = SIZE / 2, cy = SIZE / 2;
    const R  = SIZE / 2;
    const k  = 0.38; // barrel strength 0=none, 1=max
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const nx = (x - cx) / R;
            const ny = (y - cy) / R;
            const r  = Math.sqrt(nx * nx + ny * ny);
            const rf = r < 1 ? r * (1 + k * r * r) : r;
            const sx = Math.round(cx + (nx / r || 0) * rf * R);
            const sy = Math.round(cy + (ny / r || 0) * rf * R);
            const di = (y * SIZE + x) * 4;
            if (sx >= 0 && sx < SIZE && sy >= 0 && sy < SIZE) {
                const si = (sy * SIZE + sx) * 4;
                dstData.data[di]     = srcData.data[si];
                dstData.data[di + 1] = srcData.data[si + 1];
                dstData.data[di + 2] = srcData.data[si + 2];
                dstData.data[di + 3] = srcData.data[si + 3];
            }
        }
    }
    dctx.putImageData(dstData, 0, 0);
    return dst;
}

function drawGrainNoise(ctx, SIZE, frameIdx, intensity = 0.18) {
    // Gambar grain di canvas kecil (64x64) lalu scale ke 512 — jauh lebih cepat
    const G = 64;
    const grain = createCanvas(G, G);
    const gctx  = grain.getContext('2d');
    const gdata = gctx.createImageData(G, G);
    const d     = gdata.data;
    const base  = frameIdx * 9999;
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.floor((seededRand((i + base) % 999983) * 2 - 1) * intensity * 255);
        const g = Math.min(255, Math.max(0, 128 + v));
        d[i] = d[i+1] = d[i+2] = g;
        d[i+3] = 40; // alpha ringan supaya tidak tutup teks
    }
    gctx.putImageData(gdata, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = intensity * 1.2;
    ctx.drawImage(grain, 0, 0, SIZE, SIZE);
    ctx.restore();
}

function applyBulgeWarp(srcCtx, dstCtx, SIZE, strength = 0.45) {
    // Bulge BENAR (cembung ke depan, seperti mata ikan/fisheye lens):
    // Pixel dst (x,y) diambil dari src yang LEBIH DEKAT ke tengah
    // → area tengah src "diperbesar" ke seluruh dst
    // Formula: rf = r^(1/(1+strength)) — power curve, rf < r untuk r<1
    const src = srcCtx.getImageData(0, 0, SIZE, SIZE);
    const dst = dstCtx.createImageData(SIZE, SIZE);
    const cx = SIZE / 2, cy = SIZE / 2;
    const R  = SIZE / 2;
    const pw = 1 / (1 + strength * 0.8); // < 1, jadi rf < r
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const nx = (x - cx) / R;
            const ny = (y - cy) / R;
            const r  = Math.sqrt(nx * nx + ny * ny);
            if (r === 0) {
                const di = (y * SIZE + x) * 4;
                const si = (cy * SIZE + cx) * 4;
                dst.data[di] = src.data[si]; dst.data[di+1] = src.data[si+1];
                dst.data[di+2] = src.data[si+2]; dst.data[di+3] = src.data[si+3];
                continue;
            }
            // rf < r → src pixel diambil dari lebih dekat tengah → tengah membesar
            const rf = r < 1 ? Math.pow(r, pw) : r;
            const sx = Math.round(cx + (nx / r) * rf * R);
            const sy = Math.round(cy + (ny / r) * rf * R);
            const di = (y * SIZE + x) * 4;
            if (sx >= 0 && sx < SIZE && sy >= 0 && sy < SIZE) {
                const si = (sy * SIZE + sx) * 4;
                dst.data[di]   = src.data[si];   dst.data[di+1] = src.data[si+1];
                dst.data[di+2] = src.data[si+2]; dst.data[di+3] = src.data[si+3];
            }
        }
    }
    dstCtx.putImageData(dst, 0, 0);
}

function drawTextRaindrops(ctx, lx, ly, mw, fontSize, animPhase, frameIdx, lineIdx) {
    // Tetesan air menempel di bawah huruf — jatuh dari batas bawah teks
    const dropCount = Math.max(6, Math.floor(mw / 28));
    for (let d = 0; d < dropCount; d++) {
        const baseX  = lx + seededRand(d * 3131 + lineIdx * 999) * mw;
        const speed  = 0.5 + seededRand(d * 2711 + lineIdx * 777) * 1.0;
        const phase  = (animPhase * speed + seededRand(d * 1777 + lineIdx * 555)) % 1;
        // Tetes mulai dari bawah huruf, jatuh ke bawah
        const dropY  = ly + fontSize * 0.5 + phase * fontSize * 1.8;
        const dropX  = baseX + (seededRand(d * 4441 + lineIdx) - 0.5) * 4;
        const len    = 6 + seededRand(d * 5113) * fontSize * 0.22;
        const w      = 0.8 + seededRand(d * 9001) * 1.4;
        const fade   = phase < 0.08 ? phase / 0.08 : phase > 0.82 ? (1 - phase) / 0.18 : 1;
        const alpha  = fade * (0.35 + seededRand(d * 7777) * 0.45);
        if (alpha < 0.05) continue;

        ctx.save();
        ctx.globalAlpha = alpha;

        // Batang tetes
        const g = ctx.createLinearGradient(dropX, dropY, dropX, dropY + len);
        g.addColorStop(0,   'rgba(255,255,255,0.95)');
        g.addColorStop(0.6, 'rgba(200,230,255,0.7)');
        g.addColorStop(1,   'rgba(255,255,255,0.0)');
        ctx.strokeStyle = g;
        ctx.lineWidth   = w;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(dropX, dropY);
        ctx.lineTo(dropX + (seededRand(d * 3317) - 0.5) * 2, dropY + len);
        ctx.stroke();

        // Kepala bulat di atas
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(dropX, dropY, w * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

async function drawLyricFrame3(text, animPhase = 0, frameIdx = 0, showRain = false) {
    const SIZE = 512;
    const PAD  = 24;
    const maxW = SIZE - PAD * 2;
    const maxH = SIZE - 48;
    const fOpts = _fontMap['montserrat'] || _fontMap['impact'] || _defFont;

    // Fit font — turun sampai semua baris muat di maxH
    let fontSize = 128;
    let lines    = [];
    for (; fontSize >= 14; fontSize -= 2) {
        const tmp = createCanvas(maxW + 10, 100);
        const tc  = tmp.getContext('2d');
        tc.font   = `bold ${fontSize}px "${fOpts.family}", Impact, Arial Black, sans-serif`;
        const wrapped = wordWrap(tc, text, maxW);
        if (wrapped.length * fontSize * 1.18 <= maxH) { lines = wrapped; break; }
    }
    if (lines.length === 0) {
        const tmp = createCanvas(maxW + 10, 100);
        const tc  = tmp.getContext('2d');
        tc.font   = `bold 14px "${fOpts.family}", Impact, Arial Black, sans-serif`;
        lines     = wordWrap(tc, text, maxW);
        fontSize  = 14;
    }

    const lineH  = fontSize * 1.18;
    const totalH = lines.length * lineH;
    const startY = (SIZE - totalH) / 2 + lineH * 0.5;

    // ── Canvas 1: BG + Teks (untuk di-warp) ──────────────────────────────────
    const tmpCanvas = createCanvas(SIZE, SIZE);
    const tc        = tmpCanvas.getContext('2d');

    // BG hitam + flicker
    const fl = 6 + Math.floor(seededRand(frameIdx * 31) * 10);
    tc.fillStyle = `rgb(${fl},${fl},${fl})`;
    tc.fillRect(0, 0, SIZE, SIZE);

    // Teks
    const fontStr = `bold ${fontSize}px "${fOpts.family}", Impact, Arial Black, sans-serif`;
    tc.font         = fontStr;
    tc.textAlign    = 'left';
    tc.textBaseline = 'middle';
    tc.save();
    tc.beginPath();
    tc.rect(0, 0, SIZE, SIZE);
    tc.clip();
    for (let i = 0; i < lines.length; i++) {
        const ly = startY + i * lineH;
        const lx = PAD;
        tc.fillStyle = 'rgba(0,0,0,0.85)';
        tc.fillText(lines[i], lx + 3, ly + 3);
        tc.fillStyle = '#FFFFFF';
        tc.fillText(lines[i], lx, ly);
    }
    tc.restore();

    // ── Apply bulge warp ke canvas output ────────────────────────────────────
    const outCanvas = createCanvas(SIZE, SIZE);
    const oc        = outCanvas.getContext('2d');
    applyBulgeWarp(tc, oc, SIZE, 0.10);

    // ── Rain DI ATAS teks hasil warp — source-over biasa ─────────────────────
    try { if (!showRain) throw new Error('rain disabled');
        const rainFrames = await getRainFrames();
        if (rainFrames.length > 0) {
            const rf = rainFrames[frameIdx % rainFrames.length];
            const rainCanvas = createCanvas(SIZE, SIZE);
            const rctx = rainCanvas.getContext('2d');
            rctx.drawImage(rf, 0, 0, SIZE, SIZE);
            try {
                const imgData = rctx.getImageData(0, 0, SIZE, SIZE);
                const d = imgData.data;
                for (let p = 0; p < d.length; p += 4) {
                    const brightness = (d[p] + d[p+1] + d[p+2]) / 3;
                    if (brightness < 60) {
                        d[p+3] = 0; // hapus semua pixel gelap/hitam JPG
                    } else {
                        // Soft edge: makin terang makin opaque
                        const alpha = Math.min(255, Math.round((brightness - 60) * 2.8));
                        const boost = Math.min(255, Math.round(d[p] * 1.4));
                        d[p] = boost; d[p+1] = boost; d[p+2] = boost;
                        d[p+3] = alpha;
                    }
                }
                rctx.putImageData(imgData, 0, 0);
                oc.save();
                oc.globalCompositeOperation = 'source-over';
                oc.globalAlpha = 0.45; // lebih bening/transparan
                oc.drawImage(rainCanvas, 0, 0, SIZE, SIZE);
                oc.restore();
            } catch (pixErr) {
                // Fallback: pakai screen blend tanpa pixel manipulation
                logger.warn('[Lyric3] getImageData failed, using screen blend: ' + pixErr.message);
                oc.save();
                oc.globalCompositeOperation = 'screen';
                oc.globalAlpha = 0.9;
                oc.drawImage(rf, 0, 0, SIZE, SIZE);
                oc.restore();
            }
        } else {
            drawGreenscreenRain(oc, SIZE, frameIdx, animPhase);
        }
    } catch (rainErr) {
        logger.warn('[Lyric3] Rain overlay failed: ' + rainErr.message);
        drawGreenscreenRain(oc, SIZE, frameIdx, animPhase);
    }

    // Vignette
    const vig = oc.createRadialGradient(SIZE/2, SIZE/2, SIZE*0.18, SIZE/2, SIZE/2, SIZE*0.80);
    vig.addColorStop(0,   'rgba(0,0,0,0)');
    vig.addColorStop(0.55,'rgba(0,0,0,0.12)');
    vig.addColorStop(1,   'rgba(0,0,0,0.90)');
    oc.fillStyle = vig;
    oc.fillRect(0, 0, SIZE, SIZE);

    // Film grain
    drawGrainNoise(oc, SIZE, frameIdx, 0.18);

    return outCanvas.toBuffer('image/png');
}

async function createLyricSticker3(lines, secPerLine = 1.5, showRain = false) {
    const FPS3         = 8; // turun dari 15 untuk file lebih kecil
    const framesPerLine = Math.max(2, Math.round(FPS3 * secPerLine));
    const tempId       = randomBytes(6).toString('hex');
    const tempDir      = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const framePaths = [];
    const concatPath = path.join(tempDir, `lyric3_concat_${tempId}.txt`);
    const outputPath = path.join(tempDir, `lyric3_out_${tempId}.webp`);

    function cleanup() {
        for (const fp of framePaths) { try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {} }
        try { if (fs.existsSync(concatPath)) fs.unlinkSync(concatPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }

    try {
        logger.info(`[Lyric3] Start: ${lines.length} lines × ${framesPerLine} frames`);
        let globalTick = 0;
        for (let i = 0; i < lines.length; i++) {
            for (let f = 0; f < framesPerLine; f++) {
                const animPhase = (globalTick / FPS3) % 1;
                const rawBuf = await drawLyricFrame3(lines[i], animPhase, globalTick, showRain);
                const fp = path.join(tempDir, `lyric3_frame_${tempId}_${globalTick}.png`);
                fs.writeFileSync(fp, rawBuf);
                framePaths.push(fp);
                globalTick++;
            }
        }
        logger.info(`[Lyric3] Frames done: ${framePaths.length}`);

        const frameDur = (1 / FPS3).toFixed(4);
        const toFFPath = p => p.replace(/\\/g, '/');
        let concatTxt  = '';
        for (const fp of framePaths) concatTxt += `file '${toFFPath(fp)}'\nduration ${frameDur}\n`;
        concatTxt += `file '${toFFPath(framePaths[framePaths.length - 1])}'\nduration 0.001\n`;
        fs.writeFileSync(concatPath, concatTxt);

        logger.info(`[Lyric3] Running ffmpeg...`);
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('ffmpeg timeout 90s')); }, 90000);
            ffmpeg()
                .input(concatPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions([
                    '-vcodec libwebp', '-vf', 'scale=512:512',
                    '-lossless 0', '-compression_level 6',
                    '-q:v 60', '-loop 0', '-preset picture', '-an', '-vsync 0'
                ])
                .toFormat('webp')
                .on('end', async () => {
                    clearTimeout(timer);
                    try {
                        const outBuf = fs.readFileSync(outputPath);
                        cleanup();
                        const cfg = getConfig();
                        resolve(await addExif(outBuf, cfg.stickerPackName, cfg.stickerPackAuthor).catch(() => outBuf));
                        logger.info(`[Lyric3] ✅ Done: ${lines.length} line(s) × ${framesPerLine} frames`);
                    } catch (e) { clearTimeout(timer); cleanup(); reject(e); }
                })
                .on('error', (err) => { clearTimeout(timer); logger.error(`[Lyric3] ❌ ffmpeg: ${err.message}`); cleanup(); reject(err); })
                .save(outputPath);
        });
    } catch (e) { cleanup(); throw e; }
}

module.exports = { createLyricSticker, createLyricStickerStatic, createLyricSticker3, createStickerCover, parseColor, parseGradient, LYRIC_FONT_KEYS, LYRIC_THEME_KEYS, LYRIC_EFFECT_KEYS, LYRIC_ANIM_KEYS };
