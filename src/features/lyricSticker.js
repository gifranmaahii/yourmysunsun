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

// ── Multi-font registration ──────────────────────────────────────────────────
const _FW = 'C:\\Windows\\Fonts\\';
const FONT_DEFS = [
    { key: 'serif',     aliases: ['georgia','classic','elegan','romantis'],   paths: ['georgiab.ttf','georgia.ttf'],    family: 'LF_Serif',    weight: 'bold'   },
    { key: 'impact',    aliases: ['heavy','tebal','besar'],                    paths: ['impact.ttf'],                   family: 'LF_Impact',   weight: 'normal' },
    { key: 'comic',     aliases: ['comic','fun','lucu','santai'],              paths: ['comicbd.ttf','comic.ttf'],      family: 'LF_Comic',    weight: 'bold'   },
    { key: 'verdana',   aliases: ['clean','rapi'],                             paths: ['verdanab.ttf','verdana.ttf'],   family: 'LF_Verdana',  weight: 'bold'   },
    { key: 'tahoma',    aliases: ['compact','tahoma'],                         paths: ['tahomabd.ttf','tahoma.ttf'],    family: 'LF_Tahoma',   weight: 'bold'   },
    { key: 'arial',     aliases: ['sans','biasa'],                             paths: ['arialbd.ttf','arial.ttf'],      family: 'LF_Arial',    weight: 'bold'   },
    { key: 'courier',   aliases: ['mono','typewriter','ketik','mesin'],        paths: ['courbd.ttf','cour.ttf'],        family: 'LF_Courier',  weight: 'bold'   },
    { key: 'trebuchet', aliases: ['trebo','stylish'],                          paths: ['trebucbd.ttf','trebuc.ttf'],    family: 'LF_Trebuch',  weight: 'bold'   },
];

const _fontMap  = {};
const LYRIC_FONT_KEYS = [];
let   _defFont  = { family: 'Georgia', weight: 'bold' };

for (const def of FONT_DEFS) {
    for (const p of def.paths) {
        try {
            if (fs.existsSync(_FW + p)) {
                GlobalFonts.registerFromPath(_FW + p, def.family);
                const opts = { family: def.family, weight: def.weight };
                _fontMap[def.key] = opts;
                for (const a of def.aliases) _fontMap[a] = opts;
                LYRIC_FONT_KEYS.push(def.key);
                if (def.key === 'serif') _defFont = opts;
                break;
            }
        } catch (_) {}
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
const LYRIC_EFFECT_KEYS = ['shadow', 'outline', 'glow'];

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

// ── Text effect renderer ─────────────────────────────────────────────────────
function fillTextWithEffect(ctx, text, x, y, fontSize, textColor, effect) {
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
function drawLyricFrame(text, animPhase = 0, fontKey = null, effect = null, bgColOvr = null, txtColOvr = null, bgGradient = null) {
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
        fillTextWithEffect(ctx, lines[i], SIZE / 2, ly, fontSize, txtCol, effect);
        const mw    = Math.min(ctx.measureText(lines[i]).width, maxW);
        const drips = createDripSet(SIZE / 2 - mw / 2, mw, fontSize);
        drawAnimatedRain(ctx, drips, ly, fontSize, txtCol, animPhase);
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
function drawCumulativeFrame(frameIdx, allGroups, fontSize, textColor, bgColor, bgImg, animPhase = 0, fontOpts = null, effect = null, bgGradient = null) {
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
                fillTextWithEffect(ctx, lineText, SIZE / 2, curY, fontSize, textColor, effect);
                const mw    = Math.min(ctx.measureText(lineText).width, maxW);
                const drips = createDripSet(SIZE / 2 - mw / 2, mw, fontSize);
                drawAnimatedRain(ctx, drips, curY, fontSize, textColor, animPhase);
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
async function createLyricStickerStatic(lines, bgColor = BG_COLOR, bgImageBuffer = null, secPerLine = 2, fontKey = null, effect = null, themeKey = null, bgGradient = null) {
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
                const buf = drawCumulativeFrame(g, allGroups, fontSize, textColor, bgColor, bgImg, animPhase, fOpts, effect, bgGradient);
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
async function createLyricSticker(lines, secPerLine = 2, fontKey = null, effect = null, themeKey = null) {
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
                fs.writeFileSync(fp, drawLyricFrame(lines[i], animPhase, fontKey, effect, bgColOvr, txtColOvr, bgGrad));
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

module.exports = { createLyricSticker, createLyricStickerStatic, parseColor, parseGradient, LYRIC_FONT_KEYS, LYRIC_THEME_KEYS, LYRIC_EFFECT_KEYS };
