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
      name: 'hermes-agent',
      script: './src/agent/hermes.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "8783439213:AAEVFKHkKI4yfx3FesaNj4x_lh-IfeWNfco",
        TELEGRAM_ADMIN_ID: "978960819",
        AI_PROVIDER: "devin",
        AI_API_KEY: "cog_egwg5e6qidcbbnpfbgnc34hldz2hijv26hxijdifshuubjl6wcha",
        PANEL_URL: "https://public-server.verlang.id",
        PANEL_API_KEY: "ptlc_5GhxULOUtm0kk9l7u9l16WKHMFUW1uN7WczzLe2Ba44",
        SERVER_ID: "ccbb66cb"
      }
    }
  ]
};
