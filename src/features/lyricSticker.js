'use strict';

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
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

// ── Draw single lyric frame ── 512×512 PNG buffer ────────────────────────────
function drawLyricFrame(text) {
    const SIZE    = 512;
    const PADDING = 32;
    const maxW    = SIZE - PADDING * 2;

    // Auto font size based on text length
    const wc = text.trim().split(/\s+/).length;
    const cl = text.replace(/\s/g, '').length;
    let fontSize;
    if      (wc > 4 || cl > 16) fontSize = 58;
    else if (wc > 3 || cl > 12) fontSize = 68;
    else if (wc > 2 || cl > 8)  fontSize = 80;
    else if (cl > 5)             fontSize = 92;
    else                         fontSize = 104;

    const fontStr = `bold ${fontSize}px "${FONT_FAMILY}", Georgia, "Times New Roman", serif`;

    // Measure & word-wrap using temp canvas
    const tmpCanvas = createCanvas(SIZE, 100);
    const tmpCtx    = tmpCanvas.getContext('2d');
    tmpCtx.font     = fontStr;
    const lines     = wordWrap(tmpCtx, text, maxW);

    // Main canvas
    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Text style
    ctx.font         = fontStr;
    ctx.fillStyle    = TEXT_COLOR;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Vertical centering (slightly above center feels better for lyric cards)
    const lineH  = fontSize * 1.28;
    const totalH = lines.length * lineH;
    const startY = (SIZE - totalH) / 2 + lineH * 0.5 - 18;

    for (let i = 0; i < lines.length; i++) {
        const ly = startY + i * lineH;
        ctx.fillText(lines[i], SIZE / 2, ly);

        // Rain drips over this line
        const mw = Math.min(ctx.measureText(lines[i]).width, maxW);
        addRainDrips(ctx, SIZE / 2 - mw / 2, ly, mw, fontSize);
    }

    // Star at bottom center
    ctx.font         = `bold 22px Arial, sans-serif`;
    ctx.fillStyle    = TEXT_COLOR;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', SIZE / 2, SIZE - 48);

    return canvas.toBuffer('image/png');
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

module.exports = { createLyricSticker };
