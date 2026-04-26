const { generateBratImage } = require('./src/features/textImage');
const fs = require('fs');

// Test brat image dengan emoji
const testTexts = [
    'hello 😭❤️🔥',
    'lu kira gue peduli? 💀',
    'sibuk itu cuma alasan aja dek 😘✨',
    'test emoji 🎉🥰😂👀💯'
];

testTexts.forEach((text, i) => {
    const buf = generateBratImage(text);
    const filename = `test_emoji_${i + 1}.png`;
    fs.writeFileSync(filename, buf);
    console.log(`✅ ${filename} created — "${text}"`);
});

console.log('\nDone! Check the PNG files to see if emojis render correctly.');
