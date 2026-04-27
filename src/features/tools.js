const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

/**
 * Pinterest Search
 */
async function pinterestSearch(query) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/s/pinterest?query=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (json.status && json.data && json.data.length > 0) {
            return json.data.map(item => item.image_url); // Siputzx returns data[].image_url
        }
    } catch (e) {
        logger.error('[TOOLS] Pinterest Search failed: ' + e.message);
    }
    return null;
}

/**
 * Screenshot Web
 */
async function ssweb(url) {
    try {
        // Siputzx SSWeb
        const ssUrl = `https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(url)}&theme=dark&device=desktop`;
        // Check if it returns an image directly
        const res = await fetch(ssUrl);
        if (res.ok) {
            return ssUrl;
        }
    } catch (e) {
        logger.error('[TOOLS] SSWeb failed: ' + e.message);
    }
    return null;
}

/**
 * Google Search
 */
async function googleSearch(query) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/s/google?query=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (json.status && json.data && json.data.length > 0) {
            return json.data; // Siputzx usually uses json.data
        }
    } catch (e) {
        logger.error('[TOOLS] Google Search failed: ' + e.message);
    }
    return null;
}

/**
 * Jadwal Sholat
 */
async function jadwalSholat(kota) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/tools/jadwalsholat?kota=${encodeURIComponent(kota)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] Jadwal Sholat failed: ' + e.message);
    }
    return null;
}

module.exports = {
    pinterestSearch,
    ssweb,
    googleSearch,
    jadwalSholat
};
