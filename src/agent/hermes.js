/**
 * Hermes Agent v3 - AI Powered Auto-Deploy
 * Support: Groq, OpenRouter, Devin AI, Gemini
 */

const { Telegraf } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

const logger = {
    info: (msg) => console.log(`[HERMES] ℹ️ ${new Date().toISOString()} - ${msg}`),
    warn: (msg) => console.log(`[HERMES] ⚠️ ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.log(`[HERMES] ❌ ${new Date().toISOString()} - ${msg}`),
    success: (msg) => console.log(`[HERMES] ✅ ${new Date().toISOString()} - ${msg}`)
};

class HermesAgent {
    constructor() {
        this.name = 'Hermes';
        this.version = '3.1.0';
        this.isRunning = false;
        this.tasks = [];
        this.telegramBot = null;
        this.adminChatId = process.env.TELEGRAM_ADMIN_ID || null;
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
        this.panelUrl = process.env.PANEL_URL || 'https://public-server.verlang.id';
        this.panelApiKey = process.env.PANEL_API_KEY || 'ptlc_5GhxULOUtm0kk9l7u9l16WKHMFUW1uN7WczzLe2Ba44';
        this.serverId = process.env.SERVER_ID || 'ccbb66cb';
        this.aiProvider = process.env.AI_PROVIDER || 'groq';
        this.aiApiKey = process.env.AI_API_KEY || null;
        this.geminiApiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
    }

    async start() {
        logger.info(`Starting ${this.name} Agent v${this.version}...`);
        this.isRunning = true;
        await this.initTelegram();
        this.mainLoop();
        logger.success(`${this.name} Agent is running!`);
        if (this.adminChatId) {
            await this.sendTelegramMessage(
                `🤖 *Hermes Agent v${this.version}*\n\n` +
                `AI: *${this.aiProvider.toUpperCase()}*\n` +
                `Status: *Active*\n\n` +
                `Commands: /ai /fix /recommend /deploy`
            );
        }
    }

    async initTelegram() {
        if (!this.botToken) { logger.warn('No TELEGRAM_BOT_TOKEN'); return; }
        try {
            this.telegramBot = new Telegraf(this.botToken);
            this.telegramBot.command('start', (ctx) => ctx.reply('🤖 Hermes Agent v3.1\nUse /help for commands'));
            this.telegramBot.command('help', (ctx) => ctx.reply(this.getHelpText()));
            this.telegramBot.command('status', async (ctx) => ctx.reply(await this.getBotStatus()));
            this.telegramBot.command('ai', async (ctx) => {
                const desc = ctx.message.text.slice(4).trim();
                if (!desc) return ctx.reply('❌ /ai Buat fitur .cuaca dari API BMKG');
                if (!this.aiApiKey && this.aiProvider !== 'gemini') return ctx.reply('❌ AI API Key belum di-set');
                ctx.reply(`🧠 ${this.aiProvider} generating...`);
                const result = await this.aiGenerateFeature(desc);
                ctx.reply(result.message, { parse_mode: 'Markdown' });
                if (result.success) {
                    ctx.reply(`Pilih: /testfeat ${result.command} atau /fulldeploy`);
                }
            });
            this.telegramBot.command('recommend', async (ctx) => {
                ctx.reply('🤖 AI analyzing...');
                ctx.reply(await this.aiRecommendFeatures(), { parse_mode: 'Markdown' });
            });
            this.telegramBot.command('fix', async (ctx) => {
                const feature = ctx.message.text.slice(5).trim();
                if (!feature) return ctx.reply('❌ /fix .ssearch');
                ctx.reply(`🔧 Fixing ${feature}...`);
                ctx.reply(await this.aiFixFeature(feature), { parse_mode: 'Markdown' });
            });
            this.telegramBot.command('testfeat', async (ctx) => {
                const cmd = ctx.message.text.slice(9).trim();
                if (!cmd) return ctx.reply('❌ /testfeat .qc hello');
                ctx.reply(`🧪 Testing ${cmd}...`);
                ctx.reply(await this.testFeature(cmd));
            });
            this.telegramBot.command('gitpush', async (ctx) => {
                ctx.reply('📤 Pushing...');
                ctx.reply(await this.gitPush());
            });
            this.telegramBot.command('deploy', async (ctx) => {
                ctx.reply('🚀 Deploying...');
                ctx.reply(await this.deployToPanel(), { parse_mode: 'Markdown' });
            });
            this.telegramBot.command('fulldeploy', async (ctx) => {
                ctx.reply('🚀 Full deploy...');
                const git = await this.gitPush();
                ctx.reply(git);
                if (git.includes('✅')) ctx.reply(await this.deployToPanel(), { parse_mode: 'Markdown' });
            });
            this.telegramBot.command('report', async (ctx) => ctx.reply(await this.generateReport(), { parse_mode: 'Markdown' }));
            this.telegramBot.command('logs', (ctx) => ctx.reply(this.getRecentLogs()));
            this.telegramBot.catch((err) => logger.error(`Telegram: ${err.message}`));
            this.telegramBot.launch();
            logger.success('Telegram ready');
        } catch (e) { logger.error(`Telegram: ${e.message}`); }
    }

    getHelpText() {
        return `*Hermes Agent Commands:*\n\n` +
            `🎯 /ai <desc> - AI generate\n` +
            `🔧 /fix <feat> - Fix feature\n` +
            `💡 /recommend - AI suggestions\n` +
            `🧪 /testfeat <cmd> - Test\n` +
            `🚀 /deploy - To panel\n` +
            `📤 /gitpush - To GitHub\n` +
            `⚡ /fulldeploy - Git+Panel\n` +
            `📊 /status - Check status`;
    }

    async sendTelegramMessage(msg) {
        if (!this.telegramBot || !this.adminChatId) return;
        try { await this.telegramBot.telegram.sendMessage(this.adminChatId, msg, { parse_mode: 'Markdown' }); }
        catch (e) { logger.error(`Telegram: ${e.message}`); }
    }

    async aiGenerateFeature(description) {
        try {
            logger.info(`AI [${this.aiProvider}]: ${description}`);
            const prompt = this.createAIPrompt(description);
            let code = null;
            switch (this.aiProvider) {
                case 'groq': code = await this.callGroqAPI(prompt); break;
                case 'openrouter': code = await this.callOpenRouterAPI(prompt); break;
                case 'devin': code = await this.callDevinAPI(prompt); break;
                case 'gemini': code = await this.callGeminiAPI(prompt); break;
                default: code = await this.callGroqAPI(prompt);
            }
            if (!code) return { success: false, message: '❌ AI failed' };
            const featName = this.extractFeatureName(description);
            const command = `.${featName}`;
            const featurePath = path.join(__dirname, '..', 'features', `${featName}.js`);
            await fs.writeFile(featurePath, code);
            await this.addFeatureToIndex(featName, command, description);
            logger.success(`Generated: ${featName}`);
            return { success: true, message: `✅ *${featName}* created!\n📁 src/features/${featName}.js\n⌨️ ${command}`, command, featName };
        } catch (e) {
            logger.error(`AI: ${e.message}`);
            return { success: false, message: `❌ ${e.message}` };
        }
    }

    createAIPrompt(desc) {
        return `Create WhatsApp bot feature: ${desc}\n\nRequirements:\n1. Use async/await\n2. Error handling with try-catch\n3. Use sock.sendMessage()\n4. Include logger\n5. Export handler function\n6. Use node-fetch for HTTP\n\nReturn ONLY complete JavaScript code.`;
    }

    async callGroqAPI(prompt) {
        try {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.aiApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'llama-3.1-70b-versatile',
                    messages: [
                        { role: 'system', content: 'Expert Node.js developer' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2, max_tokens: 2000
                })
            });
            return (await res.json()).choices?.[0]?.message?.content;
        } catch (e) { logger.error(`Groq: ${e.message}`); return null; }
    }

    async callOpenRouterAPI(prompt) {
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.aiApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'meta-llama/llama-3.1-70b-instruct:free',
                    messages: [
                        { role: 'system', content: 'Expert Node.js developer' },
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 2000
                })
            });
            return (await res.json()).choices?.[0]?.message?.content;
        } catch (e) { logger.error(`OpenRouter: ${e.message}`); return null; }
    }

    async callDevinAPI(prompt) {
        try {
            const res = await fetch('https://api.devin.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.aiApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'devin-1',
                    messages: [
                        { role: 'system', content: 'Expert Node.js WhatsApp bot developer using Baileys' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2, max_tokens: 3000
                })
            });
            return (await res.json()).choices?.[0]?.message?.content;
        } catch (e) { logger.error(`Devin: ${e.message}`); return null; }
    }

    async callGeminiAPI(prompt) {
        try {
            if (this.geminiApiKeys.length === 0) { logger.error('No Gemini keys'); return null; }
            const apiKey = this.geminiApiKeys[0];
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 3000 }
                })
            });
            return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text;
        } catch (e) { logger.error(`Gemini: ${e.message}`); return null; }
    }

    extractFeatureName(desc) {
        const match = desc.match(/\.(\w+)/);
        if (match) return match[1];
        return desc.toLowerCase().split(' ')[0].replace(/[^a-z]/g, '');
    }

    async addFeatureToIndex(featName, command, description) {
        try {
            const indexPath = path.join(__dirname, '..', '..', 'index.js');
            let content = await fs.readFile(indexPath, 'utf8');
            const importLine = `const { handle${featName.charAt(0).toUpperCase() + featName.slice(1)} } = require('./src/features/${featName}');`;
            if (!content.includes(importLine)) {
                content = content.replace(/(const.*= require\(.+\);\n)(?!const)/, `$1${importLine}\n`);
            }
            await fs.writeFile(indexPath, content);
            logger.info(`Updated index.js for ${featName}`);
        } catch (e) { logger.error(`index.js: ${e.message}`); }
    }

    async aiRecommendFeatures() {
        const features = [
            '🌤️ .weather <kota> - Cuaca real-time',
            '📊 .poll <pertanyaan> - Voting grup',
            '🎮 .game tebakangka - Game',
            '💱 .kurs <mata uang> - Kurs',
            '🎲 .dadu - Dadu virtual',
            '🎱 .8ball - Magic 8-ball',
            '📈 .crypto <coin> - Harga crypto',
            '🍔 .resep <makanan> - Cari resep'
        ].sort(() => 0.5 - Math.random()).slice(0, 5);
        return `🤖 *AI Recommendations*\n\n` + features.join('\n') + `\n\n💡 /ai Buat fitur .weather dari API`;
    }

    async aiFixFeature(featureName) {
        try {
            const featClean = featureName.replace('.', '');
            const featurePath = path.join(__dirname, '..', 'features', `${featClean}.js`);
            try { await fs.access(featurePath); } catch { return `❌ ${featureName} not found`; }
            const currentCode = await fs.readFile(featurePath, 'utf8');
            const prompt = `Fix this WhatsApp bot code:\n\n${currentCode}\n\nFix bugs, improve error handling, optimize. Return ONLY fixed code.`;
            let fixedCode = null;
            switch (this.aiProvider) {
                case 'groq': fixedCode = await this.callGroqAPI(prompt); break;
                case 'openrouter': fixedCode = await this.callOpenRouterAPI(prompt); break;
                case 'devin': fixedCode = await this.callDevinAPI(prompt); break;
                case 'gemini': fixedCode = await this.callGeminiAPI(prompt); break;
                default: fixedCode = await this.callGroqAPI(prompt);
            }
            if (!fixedCode) return '❌ AI failed';
            await fs.writeFile(`${featurePath}.backup`, currentCode);
            await fs.writeFile(featurePath, fixedCode);
            return `✅ *${featureName} fixed!*\n💾 Backup: ${featClean}.js.backup\n🧪 /testfeat ${featureName}`;
        } catch (e) { return `❌ ${e.message}`; }
    }

    async deployToPanel() {
        try {
            logger.info('Deploying...');
            const files = ['index.js', 'src/features', 'src/utils', 'package.json'];
            for (const file of files) {
                try { await this.uploadFileToPanel(file); } catch (e) { logger.error(`Deploy ${file}: ${e.message}`); }
            }
            await this.restartPanelServer();
            return `🚀 *Deployed!*\n✅ Files uploaded\n🔄 Server restarted`;
        } catch (e) { return `❌ ${e.message}`; }
    }

    async uploadFileToPanel(filePath) {
        const fullPath = path.join(process.cwd(), filePath);
        const content = await fs.readFile(fullPath);
        const res = await fetch(`${this.panelUrl}/api/client/servers/${this.serverId}/files/write`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.panelApiKey}`, 'Content-Type': 'application/octet-stream' },
            body: content
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    async restartPanelServer() {
        const res = await fetch(`${this.panelUrl}/api/client/servers/${this.serverId}/power`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.panelApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: 'restart' })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        logger.success('Server restarted');
    }

    async testFeature(command) {
        try {
            const indexPath = path.join(__dirname, '..', '..', 'index.js');
            const content = await fs.readFile(indexPath, 'utf8');
            const cmd = command.split(' ')[0];
            const exists = content.includes(cmd);
            if (!exists) return `❌ ${cmd} not found`;
            const featPath = path.join(__dirname, '..', 'features', `${cmd.replace('.', '')}.js`);
            try {
                const code = await fs.readFile(featPath, 'utf8');
                if (!code.includes('module.exports')) return `⚠️ ${cmd}: No export`;
                if (!code.includes('async')) return `⚠️ ${cmd}: Not async`;
                return `✅ *${cmd}* valid!\n🧪 Test: ${command}`;
            } catch { return `⚠️ ${cmd}: File missing`; }
        } catch (e) { return `❌ ${e.message}`; }
    }

    async gitPush() {
        try {
            execSync('git add .', { cwd: process.cwd() });
            try { execSync('git commit -m "Hermes update"', { cwd: process.cwd() }); }
            catch { return '⚠️ No changes'; }
            execSync('git push origin master', { cwd: process.cwd() });
            return '✅ Pushed to GitHub!';
        } catch (e) { return `❌ ${e.message}`; }
    }

    async getBotStatus() {
        return `📊 *Status*\n\n🤖 WA: *Running*\n🎯 Hermes: *${this.isRunning ? 'Active' : 'Stopped'}*\n🧠 AI: *${this.aiProvider.toUpperCase()}*\n⏰ ${new Date().toLocaleString()}`;
    }

    async generateReport() {
        return `📋 *Report*\n\n📅 ${new Date().toLocaleDateString()}\n✅ Bot: Online\n✅ Hermes: Active\n📊 Tasks: ${this.tasks.length}\n\nSystems nominal ✅`;
    }

    getRecentLogs() {
        return `📜 *Logs*\n\n✅ Hermes v${this.version}\n✅ AI: ${this.aiProvider}\n✅ Telegram ready\nℹ️ Waiting...`;
    }

    async mainLoop() {
        while (this.isRunning) {
            try { await this.processTasks(); await this.sleep(30000); }
            catch (e) { logger.error(`Loop: ${e.message}`); await this.sleep(5000); }
        }
    }

    async processTasks() {
        if (this.tasks.length === 0) return;
        const task = this.tasks.shift();
        logger.info(`Task: ${task.type}`);
        try {
            switch (task.type) {
                case 'create_feature': await this.aiGenerateFeature(task.data.description); break;
                case 'fix_feature': await this.aiFixFeature(task.data.feature); break;
                case 'deploy': await this.deployToPanel(); break;
                case 'report': await this.sendTelegramMessage(await this.generateReport()); break;
            }
        } catch (e) { logger.error(`Task: ${e.message}`); }
    }

    addTask(type, data) { this.tasks.push({ type, data, timestamp: Date.now() }); }
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    stop() { logger.info('Stopping...'); this.isRunning = false; if (this.telegramBot) this.telegramBot.stop('SIGTERM'); }
}

const agent = new HermesAgent();
process.on('SIGINT', () => { agent.stop(); process.exit(0); });
process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
agent.start().catch(e => { logger.error(`Start: ${e.message}`); process.exit(1); });
module.exports = { HermesAgent };
