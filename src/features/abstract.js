'use strict';

const fetch = require('node-fetch');
const { logger } = require('../utils/logger');

/**
 * Abstract API Configuration
 * Setiap layanan di Abstract API membutuhkan API Key yang berbeda.
 * Masukkan key sesuai layanannya di bawah ini.
 */
const KEYS = {
    phone: [
        '14de089a3b224f2fa1ea2b55f28ff5af',
        '7c87f95b19324ddc925a58587567da0e'
    ],
    email: [
        'bc27e9adc50b40c3b2646105ced067f7'
    ],
    ip: [
        '73de47605b9c4e87901491fc8623fcc1' // Contoh, ganti jika punya key khusus IP
    ],
    exchange: [
        '2a961bd9faa64eec89e3c6978e0ea047' // Contoh, ganti jika punya key khusus Kurs
    ],
    holidays: [],
    timezone: [],
    vat: [],
    company: [],
    screenshot: []
};

// Fallback jika key di atas kosong, gunakan semua key yang ada (mungkin ada yang premium/multi-service)
const ALL_KEYS = [
    '14de089a3b224f2fa1ea2b55f28ff5af',
    'bc27e9adc50b40c3b2646105ced067f7',
    '73de47605b9c4e87901491fc8623fcc1',
    '2a961bd9faa64eec89e3c6978e0ea047',
    '7c87f95b19324ddc925a58587567da0e'
];

/**
 * Generic Fetch helper with service-specific key rotation
 */
async function fetchAbstract(serviceName, urlBase, params = {}) {
    let lastError = null;
    
    // Gunakan key khusus service jika ada, jika tidak gunakan ALL_KEYS
    const serviceKeys = (KEYS[serviceName] && KEYS[serviceName].length > 0) 
        ? KEYS[serviceName] 
        : ALL_KEYS;

    // Coba semua key sampai ada yang berhasil
    for (const key of serviceKeys) {
        const url = new URL(urlBase);
        url.searchParams.set('api_key', key);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }

        try {
            console.log(`[ABSTRACT] 📡 Requesting ${serviceName} with key ${key.substring(0, 5)}...`);
            const res = await fetch(url.toString());
            
            // Website Screenshot mengembalikan image/buffer, bukan JSON jika sukses
            if (serviceName === 'screenshot' && res.ok && res.headers.get('content-type').includes('image')) {
                return await res.buffer();
            }

            const json = await res.json();

            // 429: Limit, 401: Invalid Key untuk endpoint ini
            if (res.status === 429 || (json.error && json.error.code === 'quota_reached')) {
                console.log(`[ABSTRACT] ⚠️ Key ${key.substring(0, 5)} limit/quota reached.`);
                continue;
            }
            if (res.status === 401 || (json.error && (json.error.code === 'unauthorized' || json.error.message.includes('API key')))) {
                console.log(`[ABSTRACT] ❌ Key ${key.substring(0, 5)} unauthorized for ${serviceName}.`);
                continue;
            }

            if (!res.ok) {
                throw new Error(json.error?.message || `HTTP Error ${res.status}`);
            }

            return json;
        } catch (e) {
            console.log(`[ABSTRACT] ❌ Error with key ${key.substring(0, 5)}: ${e.message}`);
            lastError = e;
        }
    }
    throw lastError || new Error(`Semua API Key Abstract gagal atau tidak valid untuk fitur ${serviceName}.`);
}

/**
 * IP Geolocation
 */
async function ipGeolocation(ip) {
    return await fetchAbstract('ip', 'https://ipgeolocation.abstractapi.com/v1/', { ip_address: ip });
}

/**
 * Email Verification (Using Email Reputation API as it matches the provided key)
 */
async function emailVerification(email) {
    const data = await fetchAbstract('email', 'https://emailreputation.abstractapi.com/v1/', { email });
    // Map Reputation response to look like Validation response for compatibility with existing code
    if (data.email_address && !data.email) {
        return {
            email: data.email_address,
            is_valid_format: { value: data.email_deliverability?.is_format_valid, text: data.email_deliverability?.is_format_valid ? 'TRUE' : 'FALSE' },
            is_smtp_valid: { value: data.email_deliverability?.is_smtp_valid, text: data.email_deliverability?.is_smtp_valid ? 'TRUE' : 'FALSE' },
            is_disposable_email: { value: data.email_quality?.is_disposable, text: data.email_quality?.is_disposable ? 'TRUE' : 'FALSE' },
            deliverability: data.email_deliverability?.status,
            quality_score: data.email_quality?.score / 100
        };
    }
    return data;
}

/**
 * Phone Number Validation (Phone Intelligence)
 */
async function phoneValidation(phone) {
    return await fetchAbstract('phone', 'https://phoneintelligence.abstractapi.com/v1/', { phone });
}

/**
 * Exchange Rates (Kurs)
 */
async function exchangeRates(base = 'USD', target = 'IDR') {
    return await fetchAbstract('exchange', 'https://exchange-rates.abstractapi.com/v1/live/', { base, target });
}

/**
 * Holidays
 */
async function getHolidays(country, year) {
    return await fetchAbstract('holidays', 'https://holidays.abstractapi.com/v1/', { country, year });
}

/**
 * Timezone
 */
async function timezone(location) {
    return await fetchAbstract('timezone', 'https://timezone.abstractapi.com/v1/current_time/', { location });
}

/**
 * VAT Validation
 */
async function vatValidation(vat_number) {
    return await fetchAbstract('vat', 'https://vat.abstractapi.com/v1/validate/', { vat_number });
}

/**
 * Company Enrichment
 */
async function companyEnrichment(domain) {
    return await fetchAbstract('company', 'https://companyenrichment.abstractapi.com/v1/', { domain });
}

/**
 * Website Screenshot
 */
async function websiteScreenshot(url) {
    try {
        return await fetchAbstract('screenshot', 'https://screenshot.abstractapi.com/v1/', { url });
    } catch (e) {
        console.log(`[ABSTRACT] ⚠️ Screenshot failed, trying fallback...`);
        // Fallback ke Siputzx
        const fallbackUrl = `https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(url)}&theme=dark&device=desktop`;
        const res = await fetch(fallbackUrl);
        if (res.ok) {
            return await res.buffer();
        }
        throw e;
    }
}

/**
 * User Agent Parser (Abstract API)
 */
async function userAgent(ua_string) {
    return await fetchAbstract('ua', 'https://useragent.abstractapi.com/v1/', { ua_string });
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
    userAgent
};
