'use strict';

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// ── Register Arial Narrow dari system fonts Windows ────────────────────────
// Font ini yang dipakai bratgenerator.com (font-family: arial_narrowregular)
try {
    GlobalFonts.registerFromPath(
        path.join('C:\\Windows\\Fonts\\ARIALN.TTF'),
        'Arial Narrow'
    );
    GlobalFonts.registerFromPath(
        path.join('C:\\Windows\\Fonts\\ARIALNB.TTF'),
        'Arial Narrow Bold'
    );
} catch (_) {
    // Fallback jika tidak ada di sistem
}

// ============================================================
// Helper: word-wrap teks ke dalam array baris
// ============================================================
function wordWrap(ctx, text, maxWidth) {
    const words   = text.trim().split(/\s+/);
    const lines   = [];
    let current   = [];

    for (const word of words) {
        const test = [...current, word].join(' ');
        if (ctx.measureText(test).width > maxWidth && current.length > 0) {
            lines.push(current);
            current = [word];
        } else {
            current.push(word);
        }
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

// ============================================================
// GENERATE TEXT IMAGE — style "quote card" (teks justified)
// Command: .teks / .quote
// ============================================================
function generateTextImage(text, opts = {}) {
    const {
        width     = 420,
        padding   = 36,
        bgColor   = '#ffffff',
        textColor = '#1a1a1a',
    } = opts;

    const wordCount  = text.trim().split(/\s+/).length;
    const fontSize   = wordCount > 30 ? 34 : wordCount > 20 ? 40 : wordCount > 12 ? 46 : 52;
    const lineHeight = fontSize + 24;
    const font       = `bold ${fontSize}px Arial`;
    const maxW       = width - 2 * padding;

    const tmp    = createCanvas(width, 100);
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.font  = font;
    const lines  = wordWrap(tmpCtx, text, maxW);

    const canvasH = lines.length * lineHeight + padding * 2 + Math.round(lineHeight * 0.4);
    const canvas  = createCanvas(width, canvasH);
    const ctx     = canvas.getContext('2d');

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, canvasH);
    ctx.fillStyle = textColor;
    ctx.font      = font;

    lines.forEach((lineWords, i) => {
        const isLast = i === lines.length - 1;
        const y      = padding + (i + 1) * lineHeight;

        if (!isLast && lineWords.length > 1) {
            const wordsWidth = lineWords.reduce((acc, w) => acc + ctx.measureText(w).width, 0);
            const gap        = (maxW - wordsWidth) / (lineWords.length - 1);
            let curX         = padding;
            for (const w of lineWords) {
                ctx.fillText(w, curX, y);
                curX += ctx.measureText(w).width + gap;
            }
        } else {
            ctx.fillText(lineWords.join(' '), padding, y);
        }
    });

    return canvas.toBuffer('image/png');
}

// ============================================================
// GENERATE BRAT IMAGE — style fratgenerator.com (exact replication)
//
// Spesifikasi dari inspeksi bratgenerator.com:
//   • Font: arial_narrowregular → fallback "Arial Narrow"
//   • Font weight: 500 (medium/regular, bukan bold)
//   • Text align: justified (spread tiap baris kecuali baris terakhir)
//   • Background: #ffffff (putih)
//   • Text color: #000000 (hitam)
//   • Lowercase: ya
//   • No blur (clean, crisp)
//   • Square: 512x512
// ============================================================
function generateBratImage(text) {
    const SIZE    = 512;
    const PADDING = 36;           // margin kiri-kanan
    const MAX_W   = SIZE - PADDING * 2;

    // Force lowercase
    const bratText = text.toLowerCase().trim();

    // ── Auto font-size: lebih besar jika teks sedikit ────────
    const wCount   = bratText.split(/\s+/).length;
    const fontSize = wCount > 20 ? 52
                   : wCount > 12 ? 62
                   : wCount > 7  ? 74
                   : wCount > 4  ? 88
                   : 104;
    const lineH    = Math.round(fontSize * 1.22);

    // Arial Narrow — font resmi bratgenerator.com
    const font = `500 ${fontSize}px "Arial Narrow", "Arial Narrow Bold", Arial, sans-serif`;

    // ── Word wrap ─────────────────────────────────────────────
    const tmp    = createCanvas(SIZE, 100);
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.font  = font;
    const lines  = wordWrap(tmpCtx, bratText, MAX_W);

    // ── Render ────────────────────────────────────────────────
    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    // Background putih
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.font         = font;
    ctx.fillStyle    = '#000000';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    // Vertikal center
    const totalH = lines.length * lineH;
    const startY  = Math.round((SIZE - totalH) / 2) + fontSize;

    lines.forEach((lineWords, i) => {
        const isLast = i === lines.length - 1;
        const y      = startY + i * lineH;

        if (!isLast && lineWords.length > 1) {
            // Justified: spread kata merata ke seluruh lebar
            const wordsWidth = lineWords.reduce((acc, w) => acc + ctx.measureText(w).width, 0);
            const gap        = (MAX_W - wordsWidth) / (lineWords.length - 1);
            let curX         = PADDING;
            for (const w of lineWords) {
                ctx.fillText(w, curX, y);
                curX += ctx.measureText(w).width + gap;
            }
        } else {
            // Baris terakhir  rata kiri
            ctx.fillText(lineWords.join(' '), PADDING, y);
        }
    });

    return canvas.toBuffer('image/png');
}

module.exports = { generateTextImage, generateBratImage };
