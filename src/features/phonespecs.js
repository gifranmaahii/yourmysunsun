'use strict';

const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

const BASE_URL = 'https://azharimm-phone-specs-api.vercel.app';

/**
 * Search Phones
 */
async function searchPhones(query) {
    try {
        const res = await fetch(`${BASE_URL}/search?query=${encodeURIComponent(query)}`);
        const json = await res.json();
        return json.status ? json.data : null;
    } catch (e) {
        logger.error('[PHONE-SPECS] Search failed: ' + e.message);
        return null;
    }
}

/**
 * Get Latest Phones
 */
async function getLatestPhones() {
    try {
        const res = await fetch(`${BASE_URL}/latest`);
        const json = await res.json();
        return json.status ? json.data : null;
    } catch (e) {
        logger.error('[PHONE-SPECS] Latest failed: ' + e.message);
        return null;
    }
}

/**
 * Get Phone Details
 */
async function getPhoneDetail(slug) {
    try {
        const res = await fetch(`${BASE_URL}/${slug}`);
        const json = await res.json();
        return json.status ? json.data : null;
    } catch (e) {
        logger.error('[PHONE-SPECS] Detail failed: ' + e.message);
        return null;
    }
}

/**
 * Get Brands
 */
async function getBrands() {
    try {
        const res = await fetch(`${BASE_URL}/brands`);
        const json = await res.json();
        return json.status ? json.data : null;
    } catch (e) {
        logger.error('[PHONE-SPECS] Brands failed: ' + e.message);
        return null;
    }
}

/**
 * Get Top Phones
 */
async function getTopPhones(type = 'interest') {
    const endpoint = type === 'fans' ? 'top-by-fans' : 'top-by-interest';
    try {
        const res = await fetch(`${BASE_URL}/${endpoint}`);
        const json = await res.json();
        return json.status ? json.data : null;
    } catch (e) {
        logger.error('[PHONE-SPECS] Top failed: ' + e.message);
        return null;
    }
}

module.exports = {
    searchPhones,
    getLatestPhones,
    getPhoneDetail,
    getBrands,
    getTopPhones
};
