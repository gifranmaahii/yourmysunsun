'use strict';

const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

const KEYS = {
    phone: '14de089a3b224f2fa1ea2b55f28ff5af',
    email: 'bc27e9adc50b40c3b2646105ced067f7',
    ip: '73de47605b9c4e87901491fc8623fcc1',
    other: '2a961bd9faa64eec89e3c6978e0ea047'
};

/**
 * Generic Fetch helper for Abstract API
 */
async function fetchAbstract(urlBase, key, params = {}) {
    const url = new URL(urlBase);
    url.searchParams.set('api_key', key);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    try {
        const res = await fetch(url.toString());
        const json = await res.json();

        if (!res.ok) {
            logger.error(`[ABSTRACT] Error Response: ${JSON.stringify(json)}`);
            throw new Error(json.error?.message || `HTTP Error ${res.status}`);
        }

        return json;
    } catch (e) {
        logger.error(`[ABSTRACT] Request failed: ${e.message}`);
        throw e;
    }
}

/**
 * IP Geolocation
 */
async function ipGeolocation(ip) {
    return await fetchAbstract('https://ipgeolocation.abstractapi.com/v1/', KEYS.ip, { ip_address: ip });
}

/**
 * Email Verification
 */
async function emailVerification(email) {
    return await fetchAbstract('https://emailvalidation.abstractapi.com/v1/', KEYS.email, { email });
}

/**
 * Phone Number Validation
 */
async function phoneValidation(phone) {
    return await fetchAbstract('https://phonevalidation.abstractapi.com/v1/', KEYS.phone, { phone });
}

/**
 * Exchange Rates
 */
async function exchangeRates(base, target) {
    return await fetchAbstract('https://exchange-rates.abstractapi.com/v1/live/', KEYS.other, { base, target });
}

/**
 * Holidays
 */
async function getHolidays(country, year, month, day) {
    const params = { country, year };
    if (month) params.month = month;
    if (day) params.day = day;
    return await fetchAbstract('https://holidays.abstractapi.com/v1/', KEYS.other, params);
}

/**
 * Timezone
 */
async function timezone(location) {
    return await fetchAbstract('https://timezone.abstractapi.com/v1/', KEYS.other, { location });
}

/**
 * VAT Validation
 */
async function vatValidation(vat_number) {
    return await fetchAbstract('https://vatvalidation.abstractapi.com/v1/', KEYS.other, { vat_number });
}

/**
 * Company Enrichment
 */
async function companyEnrichment(domain) {
    return await fetchAbstract('https://companyenrichment.abstractapi.com/v1/', KEYS.other, { domain });
}

/**
 * Website Screenshot
 */
async function websiteScreenshot(url) {
    return await fetchAbstract('https://screenshots.abstractapi.com/v1/', KEYS.other, { url });
}

/**
 * User Agent
 */
async function userAgent(ua_string) {
    return await fetchAbstract('https://useragent.abstractapi.com/v1/', KEYS.other, { ua_string });
}

function getApiKey(service = 'other') {
    return KEYS[service] || KEYS.other;
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
