const fs = require('fs');
const path = require('path');
// Path disesuaikan karena script berada di dalam folder scratch/
const sessionDir = path.join(__dirname, '..', 'sessions', 'bot_6289672768769');

console.log('Target deletion path:', sessionDir);

try {
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('✅ Session directory deleted successfully.');
    } else {
        console.log('ℹ️ Session directory does not exist.');
    }
} catch (err) {
    console.error('❌ Error deleting session directory:', err);
}
