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

// ── Register serif font (Georgia Bold utama, fallback Times New Roman) ──
let FONT_FAMILY = 'Georgia';
const serifCandidates = [
    { path: 'C:\\Windows\\Fonts\\georgiab.ttf',  name: 'LyricSerif' },
    { path: 'C:\\Windows\\Fonts\\georgia.ttf',   name: 'LyricSerif' },
    { path: 'C:\\Windows\\Fonts\\timesbd.ttf',   name: 'LyricSerif' },
    { path: 'C:\\Windows\\Fonts\\times.ttf',     name: 'LyricSerif' },
];
for (const candidate of serifCandidates) {
    try {
        if (fs.existsSync(candidate.path)) {
            GlobalFonts.registerFromPath(candidate.path, candidate.name);
            FONT_FAMILY = candidate.name;
            break;
        }
    } catch (_) {}
}

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

// ── Rain drip effect ─────────────────────────────────────────────────────────
function addRainDrips(ctx, lineX, lineY, lineWidth, fontSize) {
    const numDrips = Math.max(4, Math.round(lineWidth / 26));
    for (let d = 0; d < numDrips; d++) {
        const x        = lineX + Math.random() * lineWidth;
        const startY   = lineY - fontSize * 0.28 + Math.random() * fontSize * 0.2;
        const dripLen  = fontSize * 0.38 + Math.random() * fontSize * 0.52;
        const dripW    = 0.6 + Math.random() * 1.5;
        const wobble   = (Math.random() - 0.5) * 5;

        const grad = ctx.createLinearGradient(x, startY, x, startY + dripLen);
        grad.addColorStop(0,   'rgba(90, 26, 42, 0.60)');
        grad.addColorStop(0.5, 'rgba(90, 26, 42, 0.28)');
        grad.addColorStop(1,   'rgba(90, 26, 42, 0)');

        ctx.save();
        ctx.strokeStyle = grad;
        ctx.lineWidth   = dripW;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(x, startY);
        ctx.quadraticCurveTo(
            x + wobble,
            startY + dripLen * 0.55,
            x + wobble * 0.6,
            startY + dripLen
        );
        ctx.stroke();
        ctx.restore();
    }
}

// ── Shrink-to-fit font size for one group of text ────────────────────────────
function fitFontSize(text, maxW, maxH, startSize = 100, minSize = 22) {
    for (let fs = startSize; fs >= minSize; fs -= 3) {
        const tmp    = createCanvas(600, 100);
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.font  = `bold ${fs}px "${FONT_FAMILY}", Georgia, serif`;
        const wrapped = wordWrap(tmpCtx, text, maxW);
        const lineH   = fs * 1.28;
        if (wrapped.length * lineH <= maxH) return { fontSize: fs, wrapped };
    }
    const tmp    = createCanvas(600, 100);
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.font  = `bold ${minSize}px "${FONT_FAMILY}", Georgia, serif`;
    return { fontSize: minSize, wrapped: wordWrap(tmpCtx, text, maxW) };
}

// ── Draw single animated lyric frame ── 512×512 PNG buffer ───────────────────
function drawLyricFrame(text) {
    const SIZE    = 512;
    const PADDING = 36;
    const maxW    = SIZE - PADDING * 2;
    const maxH    = SIZE - 80; // leave 80px for star + margins

    const { fontSize, wrapped: lines } = fitFontSize(text, maxW, maxH);
    const fontStr = `bold ${fontSize}px "${FONT_FAMILY}", Georgia, "Times New Roman", serif`;
    const lineH   = fontSize * 1.28;
    const totalH  = lines.length * lineH;

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.font         = fontStr;
    ctx.fillStyle    = TEXT_COLOR;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    const startY = (SIZE - totalH) / 2 + lineH * 0.5 - 10;

    for (let i = 0; i < lines.length; i++) {
        const ly = startY + i * lineH;
        ctx.fillText(lines[i], SIZE / 2, ly);
        const mw = Math.min(ctx.measureText(lines[i]).width, maxW);
        addRainDrips(ctx, SIZE / 2 - mw / 2, ly, mw, fontSize);
    }

    ctx.font         = `bold 22px Arial, sans-serif`;
    ctx.fillStyle    = TEXT_COLOR;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', SIZE / 2, SIZE - 40);

    return canvas.toBuffer('image/png');
}

// ── Render one cumulative frame ───────────────────────────────────────────────
// frameIdx = how many lyric groups are visible (0-based)
// allGroups = all wrapped-line arrays for every input line
// Layout always uses full-text height so lines don't "jump" as they appear
function drawCumulativeFrame(frameIdx, allGroups, fontSize, textColor, bgColor, bgImg) {
    const SIZE     = 512;
    const PADDING  = 36;
    const maxW     = SIZE - PADDING * 2;
    const lineH    = fontSize * 1.28;
    const groupGap = lineH * 0.38;

    const totalAllLines = allGroups.reduce((s, g) => s + g.length, 0);
    const totalAllH     = totalAllLines * lineH + (allGroups.length - 1) * groupGap;

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    // Background
    if (bgImg) {
        const scale = Math.max(SIZE / bgImg.width, SIZE / bgImg.height);
        const sw    = bgImg.width * scale;
        const sh    = bgImg.height * scale;
        ctx.drawImage(bgImg, (SIZE - sw) / 2, (SIZE - sh) / 2, sw, sh);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0, 0, SIZE, SIZE);
    } else {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, SIZE, SIZE);
    }

    const fontStr = `bold ${fontSize}px "${FONT_FAMILY}", Georgia, "Times New Roman", serif`;
    ctx.font         = fontStr;
    ctx.fillStyle    = textColor;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Position is fixed to the final full layout — text won't shift between frames
    let curY = (SIZE - totalAllH) / 2 + lineH * 0.5;

    for (let g = 0; g < allGroups.length; g++) {
        for (let i = 0; i < allGroups[g].length; i++) {
            if (g <= frameIdx) {
                const lineText = allGroups[g][i];
                ctx.fillText(lineText, SIZE / 2, curY);
                const mw = Math.min(ctx.measureText(lineText).width, maxW);
                addRainDrips(ctx, SIZE / 2 - mw / 2, curY, mw, fontSize);
            }
            curY += lineH;
        }
        if (g < allGroups.length - 1) curY += groupGap;
    }

    // Star
    ctx.font         = `bold 20px Arial, sans-serif`;
    ctx.fillStyle    = textColor;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', SIZE / 2, SIZE - 28);

    return canvas.toBuffer('image/png');
}

// ── Create animated WebP sticker — cumulative reveal + custom background ──────
async function createLyricStickerStatic(lines, bgColor = BG_COLOR, bgImageBuffer = null) {
    const SIZE     = 512;
    const PADDING  = 36;
    const maxW     = SIZE - PADDING * 2;
    const STAR_H   = 46;
    const maxH     = SIZE - PADDING * 2 - STAR_H;

    // Pre-load background image once
    let bgImg = null;
    if (bgImageBuffer) {
        bgImg = await loadImage(bgImageBuffer);
    }

    // Determine text color
    let textColor = TEXT_COLOR;
    if (bgImg) {
        textColor = '#FFFFFF';
    } else if (bgColor.toLowerCase() !== BG_COLOR.toLowerCase()) {
        textColor = isColorDark(bgColor) ? '#FFFFFF' : '#1A1A1A';
    }

    // Find font size that fits ALL lines
    let fontSize = 88;
    let allGroups = [];
    for (; fontSize >= 18; fontSize -= 3) {
        const tmp    = createCanvas(600, 100);
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.font  = `bold ${fontSize}px "${FONT_FAMILY}", Georgia, serif`;
        allGroups = lines.map(l => wordWrap(tmpCtx, l, maxW));
        const lineH    = fontSize * 1.28;
        const groupGap = lineH * 0.38;
        const totalLines = allGroups.reduce((s, g) => s + g.length, 0);
        const totalH   = totalLines * lineH + (allGroups.length - 1) * groupGap;
        if (totalH <= maxH) break;
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
        // Render one frame per lyric group (cumulative)
        for (let i = 0; i < lines.length; i++) {
            const fp  = path.join(tempDir, `lyric2_frame_${tempId}_${i}.png`);
            const buf = drawCumulativeFrame(i, allGroups, fontSize, textColor, bgColor, bgImg);
            fs.writeFileSync(fp, buf);
            framePaths.push(fp);
        }

        // Concat list
        const toFFPath = p => p.replace(/\\/g, '/');
        let concatTxt = '';
        for (const fp of framePaths) {
            concatTxt += `file '${toFFPath(fp)}'\nduration 2\n`;
        }
        concatTxt += `file '${toFFPath(framePaths[framePaths.length - 1])}'\nduration 0.001\n`;
        fs.writeFileSync(concatPath, concatTxt);

        return await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions([
                    '-vcodec libwebp',
                    '-vf', 'format=rgba',
                    '-lossless 0',
                    '-compression_level 6',
                    '-q:v 80',
                    '-loop 0',
                    '-preset default',
                    '-an',
                    '-vsync 0'
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
                        logger.info(`🎵 Lyric2 sticker encoded: ${lines.length} frame(s)`);
                    } catch (e) { cleanup(); reject(e); }
                })
                .on('error', (err) => {
                    logger.error(`❌ Lyric2 sticker ffmpeg error: ${err.message}`);
                    cleanup();
                    reject(err);
                })
                .save(outputPath);
        });

    } catch (e) {
        cleanup();
        throw e;
    }
}

// ── Create animated WebP sticker from lyric lines ────────────────────────────
async function createLyricSticker(lines) {
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
        // Render PNG frames for each lyric line
        for (let i = 0; i < lines.length; i++) {
            const fp = path.join(tempDir, `lyric_frame_${tempId}_${i}.png`);
            fs.writeFileSync(fp, drawLyricFrame(lines[i]));
            framePaths.push(fp);
        }

        // Write concat list — ffmpeg requires forward slashes
        const toFFPath = p => p.replace(/\\/g, '/');
        let concatTxt = '';
        for (const fp of framePaths) {
            concatTxt += `file '${toFFPath(fp)}'\nduration 2\n`;
        }
        // Duplicate last frame so its duration is honoured by the demuxer
        concatTxt += `file '${toFFPath(framePaths[framePaths.length - 1])}'\nduration 0.001\n`;
        fs.writeFileSync(concatPath, concatTxt);

        // Encode to animated WebP via ffmpeg concat demuxer
        return await new Promise((resolve, reject) => {
            ffmpeg()
                .input(concatPath)
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions([
                    '-vcodec libwebp',
                    '-vf', 'format=rgba',
                    '-lossless 0',
                    '-compression_level 6',
                    '-q:v 80',
                    '-loop 0',
                    '-preset default',
                    '-an',
                    '-vsync 0'
                ])
                .toFormat('webp')
                .on('end', async () => {
                    try {
                        const outBuf = fs.readFileSync(outputPath);
                        cleanup();
                        try {
                            const cfg = getConfig();
                            resolve(await addExif(outBuf, cfg.stickerPackName, cfg.stickerPackAuthor));
                        } catch (_) {
                            resolve(outBuf);
                        }
                        logger.info(`🎵 Lyric sticker encoded: ${lines.length} frame(s)`);
                    } catch (e) {
                        cleanup();
                        reject(e);
                    }
                })
                .on('error', (err) => {
                    logger.error(`❌ Lyric sticker ffmpeg error: ${err.message}`);
                    cleanup();
                    reject(err);
                })
                .save(outputPath);
        });

    } catch (e) {
        cleanup();
        throw e;
    }
}

module.exports = { createLyricSticker, createLyricStickerStatic, parseColor };
