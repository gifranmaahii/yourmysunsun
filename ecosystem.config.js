// FIXED: Hanya jalankan bot-whatsapp.
// hermes-agent DI-DISABLE karena pakai TELEGRAM_BOT_TOKEN yang sama dengan
// telegramControl.js -> menyebabkan 409 Conflict (terminated by other getUpdates).
// mangseb-promosi DI-DISABLE karena tidak diperlukan.
// PAIRING_NUMBER DIHAPUS supaya bot tidak auto-kirim pairing code saat startup.
module.exports = {
  apps: [
    {
      name: 'bot-whatsapp',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000
    }
  ]
};
