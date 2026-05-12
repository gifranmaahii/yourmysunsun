const { execSync, spawn } = require('child_process');
const path = require('path');

try {
    console.log('📦 [Boot] Memulai proses instalasi PM2 secara lokal...');
    execSync('npm install pm2', { stdio: 'inherit' });
    
    // Start Hermes Agent di background
    console.log('🤖 [Boot] Menjalankan Hermes Agent...');
    const hermesPath = path.join(__dirname, 'src', 'agent', 'hermes.js');
    const hermes = spawn('node', [hermesPath], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            TELEGRAM_BOT_TOKEN: '8783439213:AAEVFKHkKI4yfx3FesaNj4x_lh-IfeWNfco',
            TELEGRAM_ADMIN_ID: '978960819',
            AI_PROVIDER: 'devin',
            AI_API_KEY: 'cog_egwg5e6qidcbbnpfbgnc34hldz2hijv26hxijdifshuubjl6wcha',
            PANEL_URL: 'https://public-server.verlang.id',
            PANEL_API_KEY: 'ptlc_5GhxULOUtm0kk9l7u9l16WKHMFUW1uN7WczzLe2Ba44',
            SERVER_ID: 'ccbb66cb'
        }
    });
    hermes.unref();
    console.log('✅ [Boot] Hermes Agent dijalankan (PID:', hermes.pid + ')');
    
    console.log('🚀 [Boot] Menjalankan bot utama dengan PM2 Runtime...');
    // Menggunakan pm2-runtime lokal agar pasti bisa dipanggil
    execSync('./node_modules/.bin/pm2-runtime start index.js --name "bot-utama"', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ [Boot] Terjadi kesalahan saat memulai bot:', error.message);
    process.exit(1);
}
