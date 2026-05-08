const { execSync } = require('child_process');

try {
    console.log('📦 [Boot] Memulai proses instalasi PM2...');
    execSync('npm install pm2 -g', { stdio: 'inherit' });
    
    console.log('🚀 [Boot] Menjalankan bot utama dengan PM2 Runtime...');
    // Menggunakan pm2-runtime agar proses tetap di foreground dan dideteksi oleh Panel
    execSync('pm2-runtime start index.js --name "bot-utama"', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ [Boot] Terjadi kesalahan saat memulai bot:', error.message);
    process.exit(1);
}
