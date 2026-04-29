// Konfigurasi PM2 untuk Bot WhatsApp - Multi Instance
module.exports = {
  apps: [
    {
      name: 'bot-robby',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "6282312867226"
      }
    }
  ]
};
