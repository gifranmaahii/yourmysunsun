module.exports = {
  apps: [
    {
      name: 'bot-whatsapp',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "6282312867226"
      }
    },
    {
      name: 'bot-telegram-panel',
      script: 'telegramControl.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000
    }
  ]
};
