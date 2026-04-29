// Konfigurasi PM2 untuk Bot WhatsApp - Multi Instance
module.exports = {
  apps: [
    {
      name: 'bot-robby',
      script: 'index.js',
      args: '--session=robby_v2',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "6282312867226"
      }
    },
    {
      name: 'bot-member-6289672768769',
      script: 'index.js',
      args: '--session=bot_6289672768769',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "6289672768769"
      }
    },
    {
      name: 'bot-member-6285245616551',
      script: 'index.js',
      args: '--session=bot_6285245616551',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "6285245616551"
      }
    },
    {
      name: 'bot-jastip-683185558842',
      script: 'index.js',
      args: '--session=bot_jastip',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        PAIRING_NUMBER: "683185558842",
        OWNER_NUMBER: "107842904301576,152188357705821"
      }
    }
  ]
};
