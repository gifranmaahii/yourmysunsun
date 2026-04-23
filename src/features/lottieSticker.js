'use strict';

/**
 * lottieSticker.js  –  WhatsApp Animated Sticker (.was / Lottie)
 *
 * Membuat sticker Lottie asli yang muncul GEDE di WhatsApp.
 * Cara kerja:
 *   1. Ambil template Lottie JSON (dari Colab source)
 *   2. Ganti gambar base64 di dalam JSON dengan gambar user
 *   3. Terapkan preset animasi (spin / expand)
 *   4. ZIP jadi format .was
 *   5. Kirim via Baileys dengan mimetype "application/was"
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const yazl = require('yazl');
const { logger } = require('../utils/logger');
const { getConfig } = require('../utils/config');

// Path ke template asli dari Colab
const TEMPLATE_BASE = path.resolve(__dirname, '../../temp/colab_src/src/exemple');
const TEMPLATE_JSON = 'animation/animation_secondary.json';

const TEMPLATES = {
    spin: 'spin',
    expand: 'expand',
};
const DEFAULT_TEMPLATE = 'expand';

// ── Helper functions (dari Colab source) ───────────────────────

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, item.name);
        const to = path.join(dest, item.name);
        if (item.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function readLottieJson(jsonPath) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function writeLottieJson(jsonPath, json) {
    fs.writeFileSync(jsonPath, JSON.stringify(json));
}

function getEmbeddedAssetFromJson(json) {
    if (!Array.isArray(json.assets)) throw new Error('JSON has no assets.');
    const asset = json.assets.find(a => typeof a?.p === 'string' && a.p.startsWith('data:image/'));
    if (!asset) throw new Error('No base64 image found in the Lottie JSON.');
    return asset;
}

function getImageLayers(json) {
    if (!Array.isArray(json.layers)) return [];
    return json.layers.filter(l => l?.ty === 2 && typeof l?.refId === 'string');
}

function setAnimatedScalar(prop, keyframes) {
    if (!prop) return;
    prop.a = 1;
    prop.k = keyframes;
}

function setAnimatedScale(prop, keyframes) {
    if (!prop) return;
    prop.a = 1;
    prop.k = keyframes;
}

function setStaticPoint(prop, point) {
    if (!prop || prop.a !== 0 || !Array.isArray(prop.k)) return;
    prop.k = [point[0], point[1], prop.k[2] ?? 0];
}

function resizeReferencedLayers(layers, refId, width, height) {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
        if (layer?.refId === refId) {
            setStaticPoint(layer.ks?.a, [width / 2, height / 2]);
        }
    }
}

function updateAssetSize(json, asset, width, height) {
    asset.w = width;
    asset.h = height;
    resizeReferencedLayers(json.layers, asset.id, width, height);
    for (const nestedAsset of json.assets) {
        resizeReferencedLayers(nestedAsset?.layers, asset.id, width, height);
    }
}

// ── Preset animasi ─────────────────────────────────────────────

function applySpinPreset(json) {
    // Spin preset: gambar berputar 360° (tidak modifikasi, template sudah punya animasi spin)
    return json;
}

function applyExpandPreset(json) {
    // Expand preset: gambar muncul dengan efek expand (dari kecil → besar → settle)
    const layers = getImageLayers(json);
    for (const layer of layers) {
        // Reset rotasi
        setAnimatedScalar(layer.ks?.r, [
            { t: 0, s: [0], e: [0] },
            { t: 240 }
        ]);
        // Fade in
        setAnimatedScalar(layer.ks?.o, [
            { t: 0, s: [0], e: [100] },
            { t: 16, s: [100], e: [100] },
            { t: 240 }
        ]);
        // Scale: kecil → besar → settle (ini yang bikin efek "meledak keluar")
        setAnimatedScale(layer.ks?.s, [
            { t: 0,   s: [30, 30, 100],  e: [125, 125, 100] },
            { t: 36,  s: [125, 125, 100], e: [100, 100, 100] },
            { t: 72,  s: [100, 100, 100], e: [104, 104, 100] },
            { t: 132, s: [104, 104, 100], e: [100, 100, 100] },
            { t: 192, s: [100, 100, 100], e: [102, 102, 100] },
            { t: 240, s: [102, 102, 100] }
        ]);
    }
    return json;
}

function applyTemplatePreset(json, templateName) {
    if (!templateName || templateName === 'spin' || templateName === 'none') {
        return applySpinPreset(json);
    }
    if (templateName === 'expand') {
        return applyExpandPreset(json);
    }
    return applySpinPreset(json);
}

// ── Metadata override ──────────────────────────────────────────

function applyMetadataOverrides(baseFolder, metadata = {}) {
    const metadataPath = path.join(baseFolder, 'animation', 'animation.json.overridden_metadata');
    const current = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};

    if (metadata.packId) current['sticker-pack-id'] = metadata.packId;
    if (metadata.packName) current['sticker-pack-name'] = metadata.packName;
    if (metadata.publisher) current['sticker-pack-publisher'] = metadata.publisher;
    if (Array.isArray(metadata.emojis)) current.emojis = metadata.emojis;

    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(current));
}

// ── ZIP ke .was ────────────────────────────────────────────────

function listFilesRecursive(dirPath, basePath = dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const abs = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(abs, basePath));
        } else {
            files.push({
                absolutePath: abs,
                relativePath: path.relative(basePath, abs).split(path.sep).join('/')
            });
        }
    }
    return files;
}

function zipToBuffer(folder) {
    return new Promise((resolve, reject) => {
        const zipFile = new yazl.ZipFile();
        const chunks = [];

        zipFile.outputStream.on('data', chunk => chunks.push(chunk));
        zipFile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        zipFile.outputStream.on('error', reject);

        for (const file of listFilesRecursive(folder)) {
            zipFile.addFile(file.absolutePath, file.relativePath);
        }
        zipFile.end();
    });
}

// ── Main function ──────────────────────────────────────────────

async function createLottieSticker(imageBuffer, template = DEFAULT_TEMPLATE) {

    const tpl = TEMPLATES[template.toLowerCase()] || DEFAULT_TEMPLATE;
    logger.info(`🎭 Membuat Lottie sticker (.was) — template: ${tpl}`);

    // Buat temp directory
    const tempId = crypto.randomBytes(6).toString('hex');
    const tempDir = path.join(os.tmpdir(), `lottie-was-${tempId}`);

    try {
        // 1. Copy template ke temp
        copyDir(TEMPLATE_BASE, tempDir);

        // 2. Terapkan metadata
        const cfg = getConfig();
        applyMetadataOverrides(tempDir, {
            packId: 'robby-bot-lottie',
            packName: cfg.stickerPackName || 'Robby Bot',
            publisher: cfg.stickerPackAuthor || 'Robby Bot',
            emojis: ['✨', '🔥']
        });

        // 3. Baca Lottie JSON
        const jsonPath = path.join(tempDir, TEMPLATE_JSON);
        const json = applyTemplatePreset(cloneJson(readLottieJson(jsonPath)), tpl);
        const asset = getEmbeddedAssetFromJson(json);

        // 4. Resize gambar user sesuai asset size
        const targetW = asset.w || 540;
        const targetH = asset.h || 540;
        const resizedBuf = await sharp(imageBuffer)
            .resize(targetW, targetH, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer();

        // 5. Ganti base64 image di JSON
        const dataUri = `data:image/png;base64,${resizedBuf.toString('base64')}`;
        asset.p = dataUri;
        updateAssetSize(json, asset, targetW, targetH);

        // 6. Tulis JSON yang sudah dimodifikasi
        writeLottieJson(jsonPath, json);

        // 7. ZIP jadi .was buffer
        const wasBuffer = await zipToBuffer(tempDir);
        logger.info(`✅ Lottie sticker (.was) berhasil — ${(wasBuffer.length / 1024).toFixed(1)} KB`);

        return wasBuffer;
    } finally {
        // Cleanup temp
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
}

function getTemplateList() {
    return Object.keys(TEMPLATES);
}

module.exports = { createLottieSticker, getTemplateList, TEMPLATES, DEFAULT_TEMPLATE };
