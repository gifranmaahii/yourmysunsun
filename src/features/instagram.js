const fetch = require('node-fetch');

/**
 * Mengambil link media Instagram (Video/Foto/Reels) menggunakan API
 * Direkomendasikan menggunakan layanan API REST karena Instagram memblokir metode gratis biasa.
 * Contoh menggunakan API betabotz (gratis daftar)
 */
async function getInstagramMedia(url) {
    // Anda dapat mengganti ini dengan API andalan Anda
    const apiKey = process.env.BETABOTZ_API_KEY; 

    if (!apiKey) {
        throw new Error(
            '⚠️ Fitur Instagram dimatikan karena ketatnya sistem keamanan (Anti-Bot) dari Instagram.\n\n' +
            '💡 *SOLUSI:* Anda bisa mendapatkan API Key gratis dengan:\n' +
            '1. Daftar di web: https://api.betabotz.eu.org\n' +
            '2. Copy API Key Anda.\n' +
            '3. Buka file `.env` dan tambahkan baris:\n\n' +
            '`BETABOTZ_API_KEY=kunci_api_anda_di_sini`\n\n' +
            'Setelah dimasukkan, restart bot dan fitur Instagram akan berjalan lancar!'
        );
    }

    try {
        const apiUrl = `https://api.betabotz.eu.org/api/download/igdowloader?url=${encodeURIComponent(url)}&apikey=${apiKey}`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.status === false || !data.result) {
            throw new Error(data.message || 'Gagal memproses data dari API');
        }

        // data.result isinya biasanya array of objects (karena carousel IG bisa > 1 media)
        // Kita tangkap semuanya
        return data.result; 

    } catch (error) {
        throw new Error(`🚫 Gagal mengambil Instagram: ${error.message}`);
    }
}

module.exports = {
    getInstagramMedia
};
