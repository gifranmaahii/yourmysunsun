# Bot Sound Saluran Robby 🤖🎵

WhatsApp Bot berbasis **Node.js + Baileys** untuk mengekstrak audio dari TikTok dan mengirimkannya ke saluran WhatsApp secara otomatis.

## ✨ Fitur
- 🎵 **Ekstrak audio TikTok** — `.ttaudio <link_tiktok>`
- 📡 **Kirim audio ke saluran** — reply audio + `.kirim`
- 🎨 **Buat sticker** — `.sticker` (bisa dengan teks)
- 📋 **Cek JID saluran** — `.cekjid`
- 🔒 **Anti-ban** — delay acak, rate limiter, simulasi typing
- 💾 **Session persistent** — scan QR cukup 1x

## 📋 Persyaratan
- **Node.js** v18 atau lebih baru
- **FFmpeg** — wajib untuk konversi audio
- Akun WhatsApp aktif

## 🚀 Instalasi

### 1. Clone repo
```bash
git clone https://github.com/NAMA_KAMU/bot-sound-saluran-robby.git
cd bot-sound-saluran-robby
```

### 2. Install dependencies
```bash
npm install
```

### 3. Install FFmpeg
**Windows:**
Download di https://ffmpeg.org/download.html → tambahkan ke PATH

**Linux (Ubuntu/Debian):**
```bash
sudo apt update && sudo apt install ffmpeg -y
```

### 4. Buat file `.env`
```bash
# Windows
copy .env.example .env

# Linux/Mac
cp .env.example .env
```
Edit `.env` dan isi konfigurasinya.

### 5. Jalankan bot
```bash
npm start
```
Scan QR code yang muncul di terminal dengan WhatsApp.

## 📖 Perintah

| Perintah | Keterangan |
|---|---|
| `.ttaudio <link>` | Ekstrak audio dari video TikTok |
| `.kirim` | Reply audio + kirim ke saluran default |
| `.kirim <JID>` | Kirim ke saluran tertentu |
| `.sticker` | Ubah gambar jadi sticker |
| `.sticker <teks>` | Sticker dengan teks di atas |
| `.cekjid` | Cek JID saluran WhatsApp |
| `.help` | Tampilkan daftar perintah |

## ⚙️ Cara Dapat JID Saluran
1. Forward postingan dari saluran ke chat bot
2. Ketik `.cekjid`
3. Salin JID yang muncul ke `.env` → `CHANNEL_JID=...`

## 📁 Struktur Folder
```
├── index.js                  # File utama bot
├── src/
│   ├── features/
│   │   ├── tiktok.js         # Ekstrak audio TikTok
│   │   ├── audioForward.js   # Forward audio ke channel
│   │   └── sticker.js        # Konversi gambar ke sticker
│   └── utils/
│       ├── audioConverter.js # Konversi audio (FFmpeg)
│       ├── antiBan.js        # Fitur anti-ban
│       └── logger.js         # Logger
├── detect-audio-format.js    # Tool cek format audio
├── .env.example              # Template konfigurasi
└── package.json
```

## ⚠️ Disclaimer
Bot ini dibuat untuk keperluan pribadi. Gunakan dengan bijak dan bertanggung jawab sesuai Terms of Service WhatsApp.
