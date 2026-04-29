const pino = require('pino');

const logger = pino({
    level: 'info',
    transport: {
        target: 'pino/file',
        options: { destination: 1 } // stdout
    },
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

// Child logger untuk Baileys (level debug untuk melihat trafik protokol)
const baileyLogger = pino({ level: 'debug' });

module.exports = { logger, baileyLogger };
