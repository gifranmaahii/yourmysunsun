const { execSync } = require('child_process');

try {
    console.log('📦 [Boot] Memulai proses instalasi PM2 secara lokal...');
    execSync('npm install pm2', { stdio: 'inherit' });
    
    console.log('🚀 [Boot] Menjalankan bot utama dengan PM2 Runtime...');
    // Menggunakan pm2-runtime lokal agar pasti bisa dipanggil
    execSync('./node_modules/.bin/pm2-runtime start index.js --name "bot-utama"', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ [Boot] Terjadi kesalahan saat memulai bot:', error.message);
    process.exit(1);
}
