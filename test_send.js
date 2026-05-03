const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

async function testSend() {
    console.log('Starting...');
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    console.log('Making socket...');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'trace' })
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log('Connection update:', connection);
        
        if (connection === 'close') {
            console.log('Closed due to', lastDisconnect?.error);
            process.exit(1);
        }
        
        if(connection === 'open') {
            console.log('Connected!');
            
            try {
                // Number to send to (bot's own number or owner's number)
                const config = require('./src/utils/config').getConfig();
                const targetJid = config.ownerNumber + '@s.whatsapp.net';
                
                const wasBuffer = fs.readFileSync('dino.was');
                
                console.log('Uploading media manually...');
                
                const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');
                
                const mediaMsg = await prepareWAMessageMedia(
                    { sticker: wasBuffer },
                    { upload: sock.waUploadToServer }
                );
                
                console.log('Media uploaded. Modifying to Lottie...');
                
                mediaMsg.stickerMessage.mimetype = 'application/was';
                mediaMsg.stickerMessage.isLottie = true;
                mediaMsg.stickerMessage.isAnimated = true;

                console.log('Sending relay message...');
                await sock.relayMessage(targetJid, {
                    lottieStickerMessage: {
                        message: {
                            stickerMessage: mediaMsg.stickerMessage
                        }
                    }
                }, {});
                
                console.log('Sent successfully!');
            } catch (e) {
                console.error('Failed', e);
            }
            
            setTimeout(() => process.exit(0), 5000);
        }
    });
}

testSend();
