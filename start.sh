#!/bin/bash
# Script untuk menjalankan bot dengan PM2 di Pterodactyl

echo "📦 Memastikan PM2 terinstall..."
npm install pm2 -g

echo "🚀 Menjalankan Bot Utama dengan PM2..."
pm2-runtime start index.js --name "bot-utama"
