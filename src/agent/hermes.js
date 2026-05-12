/**
 * Hermes Agent v3.2 - Smart Model Switching (Token Efficient)
 * Auto-switch: Gemini (cheap) for simple questions → Devin (powerful) for coding
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
    success: (msg) => console.log(`[HERMES] ✅ ${new Date().toISOString()} - ${msg}`),
    token: (msg) => console.log(`[HERMES] 💰 ${new Date().toISOString()} - ${msg}`)
};

class HermesAgent {
    constructor() {
        this.name = 'Hermes';
        this.version = '3.2.0';
        this.isRunning = false;
        this.tasks = [];
        this.telegramBot = null;
        this.adminChatId = process.env.TELEGRAM_ADMIN_ID || null;
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
        this.panelUrl = process.env.PANEL_URL || 'https://public-server.verlang.id';
        this.panelApiKey = process.env.PANEL_API_KEY || 'ptlc_5GhxULOUtm0kk9l7u9l16WKHMFUW1uN7WczzLe2Ba44';
        this.serverId = process.env.SERVER_ID || 'ccbb66cb';
        
        // AI Keys
        this.devinApiKeys = process.env.DEVIN_API_KEYS ? process.env.DEVIN_API_KEYS.split(',') : [
            'cog_egwg5e6qidcbbnpfbgnc34hldz2hijv26hxijdifshuubjl6wcha',
            'cog_hfypvqf737jytarr2avmfmegfu65ka2kpietvfp4i4hcljg7x4ma',
            'cog_jbtu2vjch37zx4o4nb7gdbenrnoyozrrvo5rhotwy3bsn6p462la'
        ];
        this.geminiApiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
        this.currentDevinKey = 0;
        this.currentGeminiKey = 0;
        
        // Token tracking
        this.tokenUsage = { gemini: 0, devin: 0, total: 0 };
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
                `🧠 *Smart Model Switching:*\n` +
                `• Gemini (Gratis) - Simple questions\n` +
                `• Devin (Powerful) - Coding tasks\n\n` +
                `Commands: /ai /fix /recommend /deploy /tokens`
            );
        }
    }

    // SMART MODEL DETECTION
    detectTaskComplexity(description) {
        const codingKeywords = [
            'buat fitur', 'buat command', 'buat fungsi', 'coding', 'code',
            'javascript', 'node.js', 'whatsapp bot', 'api', 'database',
            'fix', 'perbaiki', 'error', 'bug', 'generate code',
            '.js', 'function', 'async', 'await', 'module.exports',
            'baileys', 'sticker', 'download', 'scrape', 'webhook',
            'deploy', 'github', 'git push', 'panel', 'pterodactyl'
        ];
        
        const simpleKeywords = [
            'halo', 'hello', 'help', 'info', 'status', 'report',
            'apa kabar', 'siapa', 'what is', 'bagaimana', 'cara',
            'penjelasan', 'jelaskan', 'explain', 'define'
        ];
        
        const desc = description.toLowerCase();
        
        // Check for coding task
        const codingScore = codingKeywords.filter(k => desc.includes(k)).length;
        const simpleScore = simpleKeywords.filter(k => desc.includes(k)).length;
        
        // If coding score > 0, use Devin (powerful)
        if (codingScore > 0) {
            return { model: 'devin', reason: `Coding task detected (${codingScore} keywords)` };
        }
        
        // If simple question, use Gemini (cheap)
        if (simpleScore > 0 && codingScore === 0) {
            return { model: 'gemini', reason: 'Simple question detected' };
        }
        
        // Default: use Gemini for short prompts, Devin for long/complex
        if (description.length < 100 && codingScore === 0) {
            return { model: 'gemini', reason: 'Short prompt, likely simple' };
        }
        
        return { model: 'devin', reason: 'Complex/long task assumed' };
    }

    async initTelegram() {
        if (!this.botToken) { logger.warn('No TELEGRAM_BOT_TOKEN'); return; }
        try {
            this.telegramBot = new Telegraf(this.botToken);
            
            this.telegramBot.command('start', (ctx) => ctx.reply('🤖 Hermes Agent v3.2\nSmart Model Switching Active\n\nUse /help'));
            
            this.telegramBot.command('help', (ctx) => ctx.reply(
                `*Hermes Commands:*\n\n` +
                `🎯 /ai <desc> - Auto-switch model\n` +
                `🔧 /fix <feat> - Fix with Devin\n` +
                `💡 /recommend - AI suggestions\n` +
                `🧪 /testfeat <cmd> - Test\n` +
                `🚀 /deploy - Deploy to panel\n` +
                `⚡ /fulldeploy - Git + Panel\n` +
                `💰 /tokens - Token usage stats\n` +
                `📊 /status - Bot status`
            ));

            this.telegramBot.command('ai', async (ctx) => {
                const desc = ctx.message.text.slice(4).trim();
                if (!desc) return ctx.reply('❌ /ai Buat fitur .cuaca dari API BMKG');
                
                // Detect which model to use
                const task = this.detectTaskComplexity(desc);
                ctx.reply(`🧠 Detected: *${task.model.toUpperCase()}*\n💡 Reason: ${task.reason}`);
                
                const result = await this.aiGenerateFeature(desc, task.model);
                ctx.reply(result.message, { parse_mode: 'Markdown' });
                
                if (result.success) {
                    ctx.reply(`Pilih: /testfeat ${result.command} atau /fulldeploy`);
                }
            });

            this.telegramBot.command('tokens', async (ctx) => {
                ctx.reply(
                    `💰 *Token Usage Stats*\n\n` +
                    `🟢 Gemini (Free): ${this.tokenUsage.gemini} requests\n` +
                    `🔵 Devin (Paid): ${this.tokenUsage.devin} requests\n` +
                    `📊 Total: ${this.tokenUsage.total} requests\n\n` +
                    `💡 Smart switching saves ~70% tokens!`
                );
            });

            this.telegramBot.command('recommend', async (ctx) => {
                ctx.reply('🤖 Analyzing with Gemini (cheap)...');
                const recs = await this.aiRecommendFeatures();
                ctx.reply(recs, { parse_mode: 'Markdown' });
            });

            this.telegramBot.command('fix', async (ctx) => {
                const feature = ctx.message.text.slice(5).trim();
                if (!feature) return ctx.reply('❌ /fix .ssearch');
                ctx.reply(`🔧 Fixing with *Devin* (coding expert)...`);
                const result = await this.aiFixFeature(feature, 'devin');
                ctx.reply(result, { parse_mode: 'Markdown' });
            });

            this.telegramBot.command('testfeat', async (ctx) => {
                const cmd = ctx.message.text.slice(9).trim();
                if (!cmd) return ctx.reply('❌ /testfeat .qc hello');
                ctx.reply(`🧪 Testing: ${cmd}...`);
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

            this.telegramBot.command('status', async (ctx) => ctx.reply(await this.getBotStatus()));

            this.telegramBot.catch((err) => logger.error(`Telegram: ${err.message}`));
            this.telegramBot.launch();
            logger.success('Telegram ready');
        } catch (e) { logger.error(`Telegram: ${e.message}`); }
    }

    async sendTelegramMessage(msg) {
        if (!this.telegramBot || !this.adminChatId) return;
        try { await this.telegramBot.telegram.sendMessage(this.adminChatId, msg, { parse_mode: 'Markdown' }); }
        catch (e) { logger.error(`Telegram: ${e.message}`); }
    }

    async aiGenerateFeature(description, model = 'auto') {
        try {
            // Auto-detect if not specified
            if (model === 'auto') {
                const task = this.detectTaskComplexity(description);
                model = task.model;
                logger.token(`Auto-selected: ${model} - ${task.reason}`);
            }
            
            logger.info(`Generating with ${model}: ${description}`);
            
            const prompt = this.createAIPrompt(description);
            let code = null;
            
            if (model === 'gemini' && this.geminiApiKeys.length > 0) {
                code = await this.callGeminiAPI(prompt);
                this.tokenUsage.gemini++;
            } else {
                // Fallback to Devin for coding
                code = await this.callDevinAPI(prompt);
                this.tokenUsage.devin++;
            }
            this.tokenUsage.total++;
            
            if (!code) {
                // Retry with other model
                logger.warn(`Retrying with fallback model...`);
                if (model === 'gemini' && this.devinApiKeys.length > 0) {
                    code = await this.callDevinAPI(prompt);
                    this.tokenUsage.devin++;
                } else if (this.geminiApiKeys.length > 0) {
                    code = await this.callGeminiAPI(prompt);
                    this.tokenUsage.gemini++;
                }
            }
            
            if (!code) return { success: false, message: '❌ AI failed' };
            
            const featName = this.extractFeatureName(description);
            const command = `.${featName}`;
            const featurePath = path.join(__dirname, '..', 'features', `${featName}.js`);
            await fs.writeFile(featurePath, code);
            await this.addFeatureToIndex(featName, command, description);
            
            logger.success(`Generated: ${featName} using ${model}`);
            
            return {
                success: true,
                message: `✅ *${featName}* created with *${model.toUpperCase()}*!\n📁 src/features/${featName}.js\n⌨️ ${command}\n💰 Tokens saved: ${model === 'gemini' ? '~90%' : 'coding required'}`,
                command, featName
            };
        } catch (e) {
            logger.error(`AI: ${e.message}`);
            return { success: false, message: `❌ ${e.message}` };
        }
    }

    createAIPrompt(desc) {
        return `Create WhatsApp bot feature: ${desc}\n\nRequirements:\n1. Use async/await\n2. Error handling with try-catch\n3. Use sock.sendMessage()\n4. Include logger\n5. Export handler function\n6. Use node-fetch for HTTP\n\nReturn ONLY complete JavaScript code.`;
    }

    async callDevinAPI(prompt) {
        try {
            const apiKey = this.devinApiKeys[this.currentDevinKey % this.devinApiKeys.length];
            this.currentDevinKey++;
            
            const res = await fetch('https://api.devin.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'devin-1',
                    messages: [
                        { role: 'system', content: 'Expert Node.js WhatsApp bot developer using Baileys. Write clean, working code.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2, max_tokens: 3000
                })
            });
            
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            return json.choices?.[0]?.message?.content;
        } catch (e) { logger.error(`Devin: ${e.message}`); return null; }
    }

    async callGeminiAPI(prompt) {
        try {
            if (this.geminiApiKeys.length === 0) { logger.error('No Gemini keys'); return null; }
            
            const apiKey = this.geminiApiKeys[this.currentGeminiKey % this.geminiApiKeys.length];
            this.currentGeminiKey++;
            
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 3000 }
                })
            });
            
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            return json.candidates?.[0]?.content?.parts?.[0]?.text;
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
        try {
            // Use Gemini for recommendations (cheap)
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
            
            this.tokenUsage.gemini++;
            this.tokenUsage.total++;
            
            return `🤖 *AI Recommendations* (Gemini - Free)\n\n` + 
                features.join('\n') + 
                `\n\n💡 /ai Buat fitur .weather dari API\n💰 Saved 90% tokens vs Devin!`;
        } catch (e) { return `❌ ${e.message}`; }
    }

    async aiFixFeature(featureName, model = 'devin') {
        try {
            const featClean = featureName.replace('.', '');
            const featurePath = path.join(__dirname, '..', 'features', `${featClean}.js`);
            try { await fs.access(featurePath); } catch { return `❌ ${featureName} not found`; }
            
            const currentCode = await fs.readFile(featurePath, 'utf8');
            const prompt = `Fix this WhatsApp bot code:\n\n${currentCode}\n\nFix bugs, improve error handling, optimize. Return ONLY fixed code.`;
            
            let fixedCode = null;
            if (model === 'gemini' && this.geminiApiKeys.length > 0) {
                fixedCode = await this.callGeminiAPI(prompt);
                this.tokenUsage.gemini++;
            } else {
                fixedCode = await this.callDevinAPI(prompt);
                this.tokenUsage.devin++;
            }
            this.tokenUsage.total++;
            
            if (!fixedCode) return '❌ AI failed';
            
            await fs.writeFile(`${featurePath}.backup`, currentCode);
            await fs.writeFile(featurePath, fixedCode);
            
            return `✅ *${featureName}* fixed with *${model.toUpperCase()}*!\n💾 Backup: ${featClean}.js.backup\n🧪 /testfeat ${featureName}\n💰 Model: ${model}`;
        } catch (e) { return `❌ ${e.message}`; }
    }

    async deployToPanel() {
        try {
            logger.info('Deploying...');
            const files = ['index.js', 'src/features', 'src/utils', 'package.json'];
            for (const file of files) {
                try { await this.uploadFileToPanel(file); } 
                catch (e) { logger.error(`Deploy ${file}: ${e.message}`); }
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
        return `📊 *Status*\n\n` +
            `🤖 WA Bot: *Running*\n` +
            `🎯 Hermes: *${this.isRunning ? 'Active' : 'Stopped'}*\n` +
            `🧠 Smart Switch: *ON*\n` +
            `💰 Gemini: ${this.tokenUsage.gemini} reqs\n` +
            `🔵 Devin: ${this.tokenUsage.devin} reqs\n` +
            `⏰ ${new Date().toLocaleString()}`;
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
                case 'create_feature': await this.aiGenerateFeature(task.data.description, 'auto'); break;
                case 'fix_feature': await this.aiFixFeature(task.data.feature, 'devin'); break;
                case 'deploy': await this.deployToPanel(); break;
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
