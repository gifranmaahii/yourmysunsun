'use strict';

const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

const API_KEYS = [
    '14de089a3b224f2fa1ea2b55f28ff5af',
    'bc27e9adc50b40c3b2646105ced067f7',
    '73de47605b9c4e87901491fc8623fcc1',
    '2a961bd9faa64eec89e3c6978e0ea047'
];

let currentIndex = 0;

/**
 * Mendapatkan API Key secara bergantian (Round Robin)
 */
function getApiKey() {
    const key = API_KEYS[currentIndex];
    currentIndex = (currentIndex + 1) % API_KEYS.length;
    return key;
}

/**
 * Fetch helper dengan rotasi key otomatis jika limit tercapai
 */
async function fetchAbstract(urlBase, params = {}) {
    let lastError = null;
    
    // Coba semua key jika perlu
    for (let i = 0; i < API_KEYS.length; i++) {
        const key = getApiKey();
        const url = new URL(urlBase);
        url.searchParams.set('api_key', key);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }

        try {
            const res = await fetch(url.toString());
            const json = await res.json();
            
            // Abstract API returns 429 for limit, 401 for invalid key
            if (res.status === 429 || (json.error && json.error.code === 'quota_reached')) {
                logger.warn(`[ABSTRACT] Key ${key.substring(0, 5)}... limit tercapai, mencoba key berikutnya.`);
                continue;
            }

            if (res.status === 401 || (json.error && (json.error.code === 'unauthorized' || json.error.message.includes('API key')))) {
                logger.warn(`[ABSTRACT] Key ${key.substring(0, 5)}... tidak valid untuk endpoint ini, mencoba key berikutnya.`);
                continue;
            }

            if (!res.ok) {
                throw new Error(json.error?.message || `HTTP Error ${res.status}`);
            }

            return json;
        } catch (e) {
            // Jika error network atau JSON parsing, tetap log tapi coba key lain jika belum habis
            logger.error(`[ABSTRACT] Request failed with key ${key.substring(0, 5)}...: ${e.message}`);
            lastError = e;
        }
    }
    throw lastError || new Error('Semua API Key Abstract gagal atau tidak valid untuk fitur ini.');
}

/**
 * IP Geolocation
 */
async function ipGeolocation(ip) {
    return await fetchAbstract('https://ipgeolocation.abstractapi.com/v1/', { ip_address: ip });
}

/**
 * Email Verification
 */
async function emailVerification(email) {
    return await fetchAbstract('https://emailvalidation.abstractapi.com/v1/', { email });
}

/**
 * Phone Number Validation
 */
async function phoneValidation(phone) {
    return await fetchAbstract('https://phonevalidation.abstractapi.com/v1/', { phone });
}

/**
 * Exchange Rates
 */
async function exchangeRates(base, target) {
    return await fetchAbstract('https://exchange-rates.abstractapi.com/v1/live/', { base, target });
}

/**
 * Holidays
 */
async function getHolidays(country, year, month, day) {
    const params = { country, year };
    if (month) params.month = month;
    if (day) params.day = day;
    return await fetchAbstract('https://holidays.abstractapi.com/v1/', params);
}

/**
 * Timezone
 */
async function timezone(location) {
    return await fetchAbstract('https://timezone.abstractapi.com/v1/', { location });
}

/**
 * VAT Validation
 */
async function vatValidation(vat_number) {
    return await fetchAbstract('https://vatvalidation.abstractapi.com/v1/', { vat_number });
}

/**
 * Company Enrichment
 */
async function companyEnrichment(domain) {
    return await fetchAbstract('https://companyenrichment.abstractapi.com/v1/', { domain });
}

/**
 * Website Screenshot
 */
async function websiteScreenshot(url) {
    return await fetchAbstract('https://screenshots.abstractapi.com/v1/', { url });
}

/**
 * User Agent
 */
async function userAgent(ua_string) {
    return await fetchAbstract('https://useragent.abstractapi.com/v1/', { ua_string });
}

module.exports = {
    ipGeolocation,
    emailVerification,
    phoneValidation,
    exchangeRates,
    getHolidays,
    timezone,
    vatValidation,
    companyEnrichment,
    websiteScreenshot,
    userAgent,
    getApiKey
};
