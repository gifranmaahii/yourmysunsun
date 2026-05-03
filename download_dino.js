const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const unzipper = require('unzipper');

async function downloadDino() {
    try {
        const payload = JSON.parse(fs.readFileSync('./debug_sticker.json', 'utf8'));
        const msg = payload.lottieStickerMessage.message.stickerMessage || payload.stickerMessage;
        
        console.log('Downloading media...');
        const stream = await downloadContentFromMessage(msg, 'sticker');
        
        let buffer = Buffer.from([]);
        for await(const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        
        console.log('Downloaded size:', buffer.length);
        fs.writeFileSync('dino.was', buffer);
        console.log('Saved to dino.was');
        
        // Extract it
        console.log('Extracting ZIP...');
        fs.createReadStream('dino.was')
          .pipe(unzipper.Extract({ path: 'dino_extracted' }))
          .on('close', () => console.log('Extracted to dino_extracted'));
          
    } catch (e) {
        console.error(e);
    }
}

downloadDino();
