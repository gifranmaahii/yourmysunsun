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
        NODE_ENV: "production"
      }
    }
  ]
};
