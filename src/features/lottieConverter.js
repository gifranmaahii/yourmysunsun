'use strict';

/**
 * lottieConverter.js
 * Konversi Lottie sticker (.tgs / WhatsApp Lottie) ke gambar PNG / video MP4
 * Menggunakan lottie-web (canvas renderer) + @napi-rs/canvas + FFmpeg
 */

const { createCanvas } = require('@napi-rs/canvas');
const zlib  = require('zlib');
const path  = require('path');
const fs    = require('fs');
const { randomBytes } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

// ── Setup DOM mock untuk lottie-web (sekali saja) ────────────────────────────
// lottie-web canvas renderer membutuhkan minimal DOM API.
// @napi-rs/canvas menyediakan Canvas2D API yang cukup untuk rendering.
let _lottieSetupDone = false;
function setupDomMock() {
    if (_lottieSetupDone) return;
    _lottieSetupDone = true;

    // Buat canvas helper untuk mock
    const makeCanvas = (w = 512, h = 512) => {
        const c = createCanvas(w, h);
        // Tambahkan property DOM yang dibutuhkan lottie-web
        c.style = {};
        c.setAttribute  = () => {};
        c.removeAttribute = () => {};
        c.addEventListener    = () => {};
        c.removeEventListener = () => {};
        c.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h });
        Object.defineProperty(c, 'offsetWidth',  { get: () => w });
        Object.defineProperty(c, 'offsetHeight', { get: () => h });
        return c;
    };

    // Stub DOM element untuk non-canvas tags
    const stubEl = () => ({
        style: {},
        setAttribute: () => {},
        removeAttribute: () => {},
        appendChild: () => {},
        removeChild: () => {},
        insertBefore: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        childNodes: [],
        children:   [],
        classList:  { add: () => {}, remove: () => {}, contains: () => false },
    });

    // Di Node.js baru, beberapa global bersifat read-only — gunakan defineProperty
    const safeDefine = (key, value) => {
        try {
            Object.defineProperty(global, key, {
                value, writable: true, configurable: true, enumerable: true
            });
        } catch {
            try { global[key] = value; } catch {} // fallback
        }
    };

    safeDefine('window',   global);
    safeDefine('navigator', { userAgent: 'Mozilla/5.0 node.js', platform: 'Win32' });
    safeDefine('location',  { href: '', protocol: 'file:' });

    // requestAnimationFrame → setTimeout (sync-like)
    safeDefine('requestAnimationFrame',  (cb) => setTimeout(cb, 0));
    safeDefine('cancelAnimationFrame',   (id) => clearTimeout(id));

    global.document = {
        createElement(tag) {
            if (tag === 'canvas') return makeCanvas();
            return stubEl();
        },
        createElementNS(_ns, _tag) { return stubEl(); },
        getElementById: () => null,
        getElementsByTagName: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        body: { style: {}, appendChild: () => {}, removeChild: () => {} },
        documentElement: {
            style: {},
            getAttribute: () => null,
            setAttribute: () => {},
        },
    };
}

// ── Parse buffer TGS/Lottie → Lottie JSON object ─────────────────────────────
function parseLottieBuffer(buf) {
    // 1. Cek apakah ini .lottie / ZIP archive (diawali dengan PK.. bytes)
    if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(buf);
            const zipEntries = zip.getEntries();
            // Cari .json di dalam archives (bisa data.json atau file json apapun)
            for (const item of zipEntries) {
                if (item.name.endsWith('.json')) {
                    const jsonStr = zip.readAsText(item, 'utf8');
                    return JSON.parse(jsonStr);
                }
            }
            throw new Error('Tidak ada file JSON dalam Lottie ZIP');
        } catch (e) {
            throw new Error('Bukan file TGS/Lottie yang valid (Gagal ekstrak ZIP: ' + e.message + ')');
        }
    }

    // 2. Cek apakah ini TGS / gzip-compressed Lottie JSON
    try {
        const json = zlib.gunzipSync(buf).toString('utf-8');
        return JSON.parse(json);
    } catch {
        // 3. Mungkin sudah raw JSON
        try { return JSON.parse(buf.toString('utf-8')); } catch {}
        throw new Error('Bukan file TGS/Lottie yang valid');
    }
}

// ── Lazy load lottie-web ─────────────────────────────────────────────────────
let _lottieLib = null;
function getLottie() {
    if (!_lottieLib) {
        setupDomMock();
        _lottieLib = require('lottie-web/build/player/lottie_canvas');
    }
    return _lottieLib;
}

// ============================================================
// FUNGSI UTAMA: Lottie → PNG (frame pertama)
// ============================================================
async function lottieToImage(tgsBuffer) {
    const lottieData = parseLottieBuffer(tgsBuffer);

    const W = lottieData.w || 512;
    const H = lottieData.h || 512;

    const canvas = createCanvas(W, H);
    // Tambahkan prop DOM ke canvas utama
    canvas.style = {};
    canvas.setAttribute  = () => {};
    canvas.addEventListener    = () => {};
    canvas.removeEventListener = () => {};
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H });

    setupDomMock();
    const lottie = getLottie();

    const anim = lottie.loadAnimation({
        animationData  : lottieData,
        renderer       : 'canvas',
        loop           : false,
        autoplay       : false,
        rendererSettings: {
            canvas     : canvas,
            context    : canvas.getContext('2d'),
            clearCanvas: true,
        },
    });

    // Render frame ke-0
    anim.goToAndStop(0, true);

    const pngBuf = canvas.toBuffer('image/png');
    anim.destroy();
    return pngBuf;
}

// ============================================================
// FUNGSI UTAMA: Lottie → MP4 video (semua frame)
// ============================================================
async function lottieToVideo(tgsBuffer) {
    const lottieData = parseLottieBuffer(tgsBuffer);

    const W          = lottieData.w  || 512;
    const H          = lottieData.h  || 512;
    const FPS        = lottieData.fr || 30;
    const startFrame = lottieData.ip || 0;
    const endFrame   = lottieData.op || 60;
    const totalFrames = Math.max(1, Math.round(endFrame - startFrame));

    const canvas = createCanvas(W, H);
    canvas.style = {};
    canvas.setAttribute  = () => {};
    canvas.addEventListener    = () => {};
    canvas.removeEventListener = () => {};
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H });

    setupDomMock();
    const lottie = getLottie();

    const anim = lottie.loadAnimation({
        animationData  : lottieData,
        renderer       : 'canvas',
        loop           : false,
        autoplay       : false,
        rendererSettings: {
            canvas     : canvas,
            context    : canvas.getContext('2d'),
            clearCanvas: true,
        },
    });

    // Siapkan temp dir
    const tempId  = randomBytes(6).toString('hex');
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Render tiap frame → simpan sebagai PNG
    const framePaths = [];
    for (let i = 0; i < totalFrames; i++) {
        anim.goToAndStop(i, true);
        const frameBuf  = canvas.toBuffer('image/png');
        const framePath = path.join(tempDir, `lf_${tempId}_${String(i).padStart(5, '0')}.png`);
        fs.writeFileSync(framePath, frameBuf);
        framePaths.push(framePath);
    }
    anim.destroy();

    // Gabungkan frame PNG → MP4 via FFmpeg
    const outPath = path.join(tempDir, `lottie_${tempId}.mp4`);
    const inputPattern = path.join(tempDir, `lf_${tempId}_%05d.png`);

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputPattern)
            .inputOptions([`-framerate ${FPS}`])
            .outputOptions([
                '-c:v libx264',
                '-pix_fmt yuv420p',
                `-vf scale=${W % 2 === 0 ? W : W + 1}:${H % 2 === 0 ? H : H + 1}`,
                '-preset fast',
                '-crf 23',
            ])
            .on('end', resolve)
            .on('error', reject)
            .save(outPath);
    });

    const mp4Buf = fs.readFileSync(outPath);

    // Cleanup
    for (const p of framePaths) { try { fs.unlinkSync(p); } catch {} }
    try { fs.unlinkSync(outPath); } catch {}

    return mp4Buf;
}

module.exports = { lottieToImage, lottieToVideo };
