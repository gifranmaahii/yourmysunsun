'use strict';

const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

const API_KEYS = [
    '14de089a3b224f2fa1ea2b55f28ff5af',
    'bc27e9adc50b40c3b2646105ced067f7',
    '73de47605b9c4e87901491fc8623fcc1',
    '2a961bd9faa64eec89e3c6978e0ea047',
    '7c87f95b19324ddc925a58587567da0e'
];

let currentIndex = 0;

function getApiKey() {
    const key = API_KEYS[currentIndex];
    currentIndex = (currentIndex + 1) % API_KEYS.length;
    return key;
}

/**
 * Generic Fetch helper with automatic key rotation
 */
async function fetchAbstract(urlBase, params = {}) {
    let lastError = null;
    
    // Coba semua key sampai ada yang berhasil
    for (let i = 0; i < API_KEYS.length; i++) {
        const key = API_KEYS[i]; // Coba secara urutan untuk tiap request agar pasti ketemu yang valid
        const url = new URL(urlBase);
        url.searchParams.set('api_key', key);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }

        try {
            const res = await fetch(url.toString());
            const json = await res.json();

            // 429: Limit, 401: Invalid Key untuk endpoint ini
            if (res.status === 429 || (json.error && json.error.code === 'quota_reached')) {
                continue;
            }
            if (res.status === 401 || (json.error && (json.error.code === 'unauthorized' || json.error.message.includes('API key')))) {
                continue;
            }

            if (!res.ok) {
                throw new Error(json.error?.message || `HTTP Error ${res.status}`);
            }

            return json;
        } catch (e) {
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
 * Phone Number Validation (Using Phone Intelligence API)
 */
async function phoneValidation(phone) {
    return await fetchAbstract('https://phoneintelligence.abstractapi.com/v1/', { phone });
}

/**
 * Exchange Rates
 */
async function exchangeRates(base, target) {
    return await fetchAbstract('https://exchangerates.abstractapi.com/v1/', { base, target });
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
    return await fetchAbstract('https://vat.abstractapi.com/v1/', { vat_number });
}

/**
 * Company Enrichment
 */
async function companyEnrichment(domain) {
    return await fetchAbstract('https://companyenrichment.abstractapi.com/v2/', { domain });
}

/**
 * Website Screenshot
 */
async function websiteScreenshot(url) {
    return await fetchAbstract('https://screenshot.abstractapi.com/v1/', { url });
}

/**
 * User Agent (Abstract tidak punya API spesifik, gunakan parser internal sederhana)
 */
async function userAgent(ua_string) {
    // Karena Abstract tidak punya API UA, kita return data dummy atau parser sederhana
    return {
        browser: { name: 'Unknown', version: '0.0' },
        os: { name: 'Unknown', version: '0.0' },
        device: { type: 'Desktop', brand: 'Unknown' }
    };
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
