const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { logger } = require('../utils/logger');

/**
 * Mengubah efek suara pada audio/VN
 * @param {Buffer} audioBuffer - Buffer audio asli
 * @param {string} filterType - Jenis filter (robot, tupai, raksasa, dll)
 * @returns {Promise<Buffer>} - Buffer audio hasil olahan (Ogg Opis)
 */
async function applyVoiceFilter(audioBuffer, filterType) {
    return new Promise((resolve, reject) => {
        const tempId = randomBytes(6).toString('hex');
        const tempDir = path.join(__dirname, '../../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const inputPath = path.join(tempDir, `vcin_${tempId}.mp3`);
        const outputPath = path.join(tempDir, `vcout_${tempId}.opus`);

        fs.writeFileSync(inputPath, audioBuffer);

        let command = ffmpeg(inputPath);

        // Daftar Filter Audio
        switch (filterType.toLowerCase()) {
            case 'bass':
                command.audioFilters('bass=g=20,dynaudnorm=f=200');
                break;
            case 'blown':
                command.audioFilters('acrusher=level_in=8:level_out=18:bits=8:mode=log:aa=1');
                break;
            case 'deep':
            case 'raksasa':
                command.audioFilters('asetrate=44100*0.8,atempo=1/0.8');
                break;
            case 'earrape':
                command.audioFilters('volume=20,acrusher=level_in=1:level_out=1:bits=1:mode=log:aa=1');
                break;
            case 'fast':
                command.audioFilters('atempo=1.8');
                break;
            case 'fat':
                command.audioFilters('asetrate=44100*0.6,atempo=1/0.6');
                break;
            case 'nightcore':
                command.audioFilters('asetrate=44100*1.25,atempo=1/1.25');
                break;
            case 'reverse':
                command.audioFilters('areverse');
                break;
            case 'robot':
                command.audioFilters('aecho=0.8:0.88:6:0.4,earwax');
                break;
            case 'slow':
                command.audioFilters('atempo=0.5');
                break;
            case 'smooth':
                command.audioFilters('vibrato=f=4.0:d=0.1');
                break;
            case 'squirrel':
            case 'tupai':
                command.audioFilters('asetrate=44100*1.5,atempo=1/1.5');
                break;
            case 'vibrato':
                command.audioFilters('vibrato=f=15');
                break;
            default:
                // Jika tidak ada filter yang cocok, kembalikan audio asli (atau error)
                break;
        }

        command
            .outputOptions([
                '-c:a libopus',
                '-b:a 128k',
                '-vbr on',
                '-compression_level 10'
            ])
            .toFormat('opus')
            .on('end', () => {
                try {
                    const buffer = fs.readFileSync(outputPath);
                    cleanup();
                    resolve(buffer);
                } catch (e) {
                    reject(e);
                }
            })
            .on('error', (err) => {
                cleanup();
                logger.error(`❌ Voice Changer Error: ${err.message}`);
                reject(err);
            })
            .save(outputPath);

        function cleanup() {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    });
}

module.exports = {
    applyVoiceFilter
};
