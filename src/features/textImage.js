'use strict';

const { createCanvas } = require('@napi-rs/canvas');

/**
 * Buat gambar dari teks, dengan layout justified (seperti contoh gambar).
 *
 * @param {string} text        - Teks yang ingin dijadikan gambar
 * @param {object} [opts]      - Opsi tambahan
 * @returns {Buffer}           - Buffer gambar PNG
 */
function generateTextImage(text, opts = {}) {
    const {
        width      = 420,
        padding    = 36,
        fontSize   = 52,
        lineHeight = 76,
        bgColor    = '#ffffff',
        textColor  = '#1a1a1a',
        fontStyle  = `bold ${52}px Arial`,
    } = opts;

    // ── Auto-scale font jika teks terlalu panjang ──────────────────────────
    // (font lebih kecil jika banyak kata agar tidak overflow)
    const wordCount = text.trim().split(/\s+/).length;
    const dynFontSize = wordCount > 30 ? 34 : wordCount > 20 ? 40 : wordCount > 12 ? 46 : fontSize;
    const dynLineH    = dynFontSize + 24;
    const font        = `bold ${dynFontSize}px Arial`;
    const maxW        = width - 2 * padding;

    // ── Ukur teks & buat baris (word-wrap) ────────────────────────────────
    const tmpCanvas = createCanvas(width, 100);
    const tmpCtx    = tmpCanvas.getContext('2d');
    tmpCtx.font     = font;

    const words = text.trim().split(/\s+/);
    const lines  = [];
    let currentLine = [];

    for (const word of words) {
        const test = [...currentLine, word].join(' ');
        if (tmpCtx.measureText(test).width > maxW && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = [word];
        } else {
            currentLine.push(word);
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // ── Hitung dimensi kanvas ──────────────────────────────────────────────
    const textAreaH = lines.length * dynLineH;
    const canvasH   = textAreaH + padding * 2 + dynLineH * 0.4;

    // ── Gambar ke canvas ───────────────────────────────────────────────────
    const canvas = createCanvas(width, canvasH);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, canvasH);

    // Teks
    ctx.fillStyle = textColor;
    ctx.font      = font;

    lines.forEach((lineWords, i) => {
        const isLast = i === lines.length - 1;
        const y      = padding + (i + 1) * dynLineH;

        if (!isLast && lineWords.length > 1) {
            // Justify: hitung total lebar kata, spread sisanya sbg spasi antar kata
            const wordsWidth   = lineWords.reduce((acc, w) => acc + ctx.measureText(w).width, 0);
            const totalSpacing = maxW - wordsWidth;
            const gap          = totalSpacing / (lineWords.length - 1);

            let curX = padding;
            for (const w of lineWords) {
                ctx.fillText(w, curX, y);
                curX += ctx.measureText(w).width + gap;
            }
        } else {
            // Baris terakhir atau 1 kata: rata kiri biasa
            ctx.fillText(lineWords.join(' '), padding, y);
        }
    });

    return canvas.toBuffer('image/png');
}

module.exports = { generateTextImage };
