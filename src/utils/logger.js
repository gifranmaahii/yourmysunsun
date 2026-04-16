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

// Child logger untuk Baileys (silent supaya tidak spam)
const baileyLogger = pino({ level: 'silent' });

module.exports = { logger, baileyLogger };
