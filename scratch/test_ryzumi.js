const fetch = require('node-fetch');

async function testRyzumi() {
    console.log('🚀 Memulai test API Ryzumi...');
    const url = 'https://api.ryzumi.net/api/ai/chatgpt?prompt=halo';
    
    try {
        const res = await fetch(url);
        console.log(`📡 Status Code: ${res.status} ${res.statusText}`);
        console.log(`📝 Content-Type: ${res.headers.get('content-type')}`);
        
        const text = await res.text();
        console.log('📄 Raw Response:');
        console.log(text);
        
        try {
            const json = JSON.parse(text);
            console.log('✅ Berhasil parse JSON!');
            console.log('Hasil:', json);
        } catch (e) {
            console.log('❌ Gagal parse JSON. Mungkin diblokir atau error 404.');
        }
    } catch (err) {
        console.error('💥 Connection Error:', err.message);
    }
}

testRyzumi();
