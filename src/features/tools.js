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
        // Cari ID Kota dulu
        const resSearch = await fetch(`https://api.myquran.com/v2/sholat/kota/cari/${encodeURIComponent(kota)}`);
        const jsonSearch = await resSearch.json();
        if (!jsonSearch.status || jsonSearch.data.length === 0) return null;
        
        const idKota = jsonSearch.data[0].id;
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        
        const resJadwal = await fetch(`https://api.myquran.com/v2/sholat/jadwal/${idKota}/${y}/${m}/${d}`);
        const jsonJadwal = await resJadwal.json();
        if (jsonJadwal.status && jsonJadwal.data && jsonJadwal.data.jadwal) {
            return jsonJadwal.data.jadwal;
        }
    } catch (e) {
        logger.error('[TOOLS] Jadwal Sholat failed: ' + e.message);
    }
    return null;
}

/**
 * Info Gempa BMKG
 */
async function infoGempa() {
    try {
        const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json');
        const json = await res.json();
        if (json.Infogempa && json.Infogempa.gempa) {
            return json.Infogempa.gempa;
        }
    } catch (e) {
        logger.error('[TOOLS] Info Gempa failed: ' + e.message);
    }
    return null;
}

/**
 * Berita Indonesia (CNN, Detik, etc)
 */
async function getNews() {
    try {
        const res = await fetch('https://api-berita-indonesia.vercel.app/cnn/terbaru/');
        const json = await res.json();
        if (json.success && json.data && json.data.posts) {
            return json.data.posts.slice(0, 5); // Ambil 5 berita terbaru
        }
    } catch (e) {
        logger.error('[TOOLS] Get News failed: ' + e.message);
    }
    return null;
}

/**
 * Shortlink TinyURL
 */
async function shortlink(url) {
    try {
        const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
        if (res.ok) {
            return await res.text();
        }
    } catch (e) {
        logger.error('[TOOLS] Shortlink failed: ' + e.message);
    }
    return null;
}

/**
 * Candaan / Jokes Bapak-bapak
 */
async function getJoke() {
    try {
        const res = await fetch('https://candaan-api.vercel.app/api/text/random');
        const json = await res.json();
        if (json.status === 200 && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] Get Joke failed: ' + e.message);
    }
    return null;
}

/**
 * Quotes
 */
async function getQuote() {
    try {
        const res = await fetch('https://api.popcat.xyz/quote');
        const json = await res.json();
        if (json.quote) {
            return json;
        }
    } catch (e) {
        logger.error('[TOOLS] Get Quote failed: ' + e.message);
    }
    return null;
}

/**
 * SimSimi Chat AI
 */
async function simSimi(text) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/ai/simsimi?query=${encodeURIComponent(text)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] SimSimi failed: ' + e.message);
    }
    return null;
}

/**
 * Kamus Besar Bahasa Indonesia (KBBI)
 */
async function getKBBI(kata) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/s/kbbi?q=${encodeURIComponent(kata)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] KBBI failed: ' + e.message);
    }
    return null;
}

/**
 * Wikipedia Indonesia
 */
async function getWiki(kueri) {
    try {
        const res = await fetch(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(kueri)}`);
        const json = await res.json();
        if (json.title && json.extract) {
            return json;
        }
    } catch (e) {
        logger.error('[TOOLS] Wiki failed: ' + e.message);
    }
    return null;
}

/**
 * Google Translate (Unofficial)
 */
async function translate(text, to = 'id') {
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(text)}`);
        const json = await res.json();
        if (json && json[0]) {
            return json[0].map(s => s[0]).join('');
        }
    } catch (e) {
        logger.error('[TOOLS] Translate failed: ' + e.message);
    }
    return null;
}

/**
 * Info Cuaca (Weather)
 */
async function getWeather(kota) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/info/cuaca?q=${encodeURIComponent(kota)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] Weather failed: ' + e.message);
    }
    return null;
}

/**
 * Ramalan Zodiak
 */
async function getZodiac(zodiak) {
    try {
        // Map common misspellings/Indonesian names
        const map = {
            'aries': 'aries', 'taurus': 'taurus', 'gemini': 'gemini', 'cancer': 'cancer',
            'leo': 'leo', 'virgo': 'virgo', 'firgo': 'virgo', 'birgo': 'virgo',
            'libra': 'libra', 'scorpio': 'scorpio', 'sagitarius': 'sagittarius', 'sagittarius': 'sagittarius',
            'capricorn': 'capricorn', 'aquarius': 'aquarius', 'pisces': 'pisces', 'pises': 'pisces'
        };
        const query = map[zodiak.toLowerCase()] || zodiak;
        const res = await fetch(`https://api.siputzx.my.id/api/primbon/zodiak?zodiak=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] Zodiac failed: ' + e.message);
    }
    return null;
}

/**
 * GitHub Stalk
 */
async function githubStalk(username) {
    try {
        const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`);
        const json = await res.json();
        if (json.login) {
            return json;
        }
    } catch (e) {
        logger.error('[TOOLS] GitHub Stalk failed: ' + e.message);
    }
    return null;
}

/**
 * Kumpulan Doa Harian
 */
async function getDoa(query = '') {
    try {
        // Menggunakan Islamic API yang lebih stabil
        const endpoint = query 
            ? `https://doa-doa-api-ahmadramadhan.fly.dev/api/doa/${encodeURIComponent(query)}`
            : `https://doa-doa-api-ahmadramadhan.fly.dev/api`;
        const res = await fetch(endpoint);
        const json = await res.json();
        
        // Handle response array (list) atau single object (search)
        if (Array.isArray(json)) return json;
        if (json.id || json.doa) return json;
    } catch (e) {
        logger.error('[TOOLS] Doa failed: ' + e.message);
    }
    return null;
}

/**
 * Info Anime (Jikan MyAnimeList)
 */
async function getAnime(judul) {
    try {
        const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(judul)}&limit=1`);
        const json = await res.json();
        if (json.data && json.data.length > 0) {
            return json.data[0];
        }
    } catch (e) {
        logger.error('[TOOLS] Anime failed: ' + e.message);
    }
    return null;
}

/**
 * Hilih Generator
 */
function hilih(text) {
    return text.replace(/[aeiou]/g, 'i').replace(/[AEIOU]/g, 'I');
}

/**
 * Sticker Search - menggunakan Tenor API
 */
async function searchSticker(query) {
    // Gunakan Tenor API (Google) untuk GIF/sticker
    const TENOR_KEY = process.env.TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQmlUfPN4NXxE';
    
    try {
        const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${TENOR_KEY}&client_key=whatsapp-bot&limit=20&contentfilter=low`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const json = await res.json();
        if (json.results && json.results.length > 0) {
            // Ambil random GIF dari hasil
            const random = json.results[Math.floor(Math.random() * json.results.length)];
            return random.media_formats?.tinygif?.url || random.media_formats?.gif?.url || random.url;
        }
    } catch (e) {
        logger.warn('[TOOLS] Tenor Search failed: ' + e.message);
    }
    
    // Fallback: Giphy API
    const GIPHY_KEY = process.env.GIPHY_API_KEY || 'jGvYvIvsSm9pM9fgYTrk9c7GwxB4dVJ8';
    try {
        const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(query)}&limit=20&rating=g`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const json = await res.json();
        if (json.data && json.data.length > 0) {
            const random = json.data[Math.floor(Math.random() * json.data.length)];
            return random.images?.fixed_height?.url || random.images?.original?.url;
        }
    } catch (e) {
        logger.warn('[TOOLS] Giphy Search failed: ' + e.message);
    }
    
    return null;
}

/**
 * Google TTS
 */
async function getTTS(text, lang = 'id') {
    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        logger.error('[TOOLS] TTS failed: ' + e.message);
    }
    return null;
}

/**
 * GSM Arena Search
 */
async function searchGsm(query) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/s/gsmarena?query=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] GSM Search failed: ' + e.message);
    }
    return null;
}

/**
 * GSM Arena Detail
 */
async function detailGsm(url) {
    try {
        const res = await fetch(`https://api.siputzx.my.id/api/s/gsmarena/detail?url=${encodeURIComponent(url)}`);
        const json = await res.json();
        if (json.status && json.data) {
            return json.data;
        }
    } catch (e) {
        logger.error('[TOOLS] GSM Detail failed: ' + e.message);
    }
    return null;
}

module.exports = {
    pinterestSearch,
    ssweb,
    googleSearch,
    jadwalSholat,
    infoGempa,
    getNews,
    shortlink,
    getJoke,
    getQuote,
    simSimi,
    getKBBI,
    getWiki,
    translate,
    getWeather,
    getZodiac,
    githubStalk,
    getDoa,
    getAnime,
    hilih,
    searchSticker,
    getTTS,
    searchGsm,
    detailGsm
};
