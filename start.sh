#!/bin/bash
# Script untuk menjalankan bot dengan PM2 di Pterodactyl

echo "� Mengambil update terbaru dari GitHub..."
git fetch origin && git reset --hard origin/master && echo "✅ Update berhasil" || echo "⚠️ Git update gagal, lanjut dengan kode lama"

echo "�📦 Memastikan PM2 terinstall..."
npm install pm2 -g

echo "🚀 Menjalankan Bot Utama & Telegram Panel dengan PM2..."
pm2-runtime start ecosystem.config.js
