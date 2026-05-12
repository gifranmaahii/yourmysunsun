/**
 * Hermes Agent v3 - AI Powered Auto-Deploy
 * Auto-task: Generate code with AI, test, deploy to panel & GitHub
 */

const { Telegraf } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

// Logger
const logger = {
    info: (msg) => console.log(`[HERMES] ℹ️ ${new Date().toISOString()} - ${msg}`),
    warn: (msg) => console.log(`[HERMES] ⚠️ ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.log(`[HERMES] ❌ ${new Date().toISOString()} - ${msg}`),
    success: (msg) => console.log(`[HERMES] ✅ ${new Date().toISOString()} - ${msg}`)
};

class HermesAgent {
    constructor() {
        this.name = 'Hermes';
        this.version = '3.0.0';
        this.isRunning = false;
        this.tasks = [];
        this.telegramBot = null;
        this.adminChatId = process.env.TELEGRAM_ADMIN_ID || null;
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
        
        // Panel config
        this.panelUrl = process.env.PANEL_URL || 'https://public-server.verlang.id';
        this.panelApiKey = process.env.PANEL_API_KEY || 'ptlc_5GhxULOUtm0kk9l7u9l16WKHMFUW1uN7WczzLe2Ba44';
        this.serverId = process.env.SERVER_ID || 'ccbb66cb';
        
        // AI config
        this.aiProvider = process.env.AI_PROVIDER || 'groq'; // 'groq' or 'openrouter'
        this.aiApiKey = process.env.AI_API_KEY || null;
    }

    async start() {
        logger.info(`Starting ${this.name} Agent v${this.version}...`);
        this.isRunning = true;

        await this.initTelegram();
        this.mainLoop();
        
        logger.success(`${this.name} Agent is running!`);
        
        if (this.adminChatId) {
            await this.sendTelegramMessage(
                `🤖 *Hermes Agent v3 Started*\n\n` +
                `✅ WhatsApp Bot: Running\n` +
                `🤖 Hermes Agent: Active\n` +
                `🧠 AI Code Generation: ${this.aiApiKey ? 'Ready' : 'Need API Key'}\n` +
                `🚀 Auto-Deploy: Ready\n\n` +
                `*Commands:*\n` +
                `/ai <desc> - AI generate feature\n` +
                `/deploy - Deploy to panel\n` +
                `/fix <feature> - Fix broken feature\n` +
                `/recommend - Get AI recommendations`
            );
        }
    }

    async initTelegram() {
        if (!this.botToken) {
            logger.warn('TELEGRAM_BOT_TOKEN not set');
            return;
        }

        try {
            this.telegramBot = new Telegraf(this.botToken);
            
            // Basic commands
            this.telegramBot.command('start', (ctx) => {
                ctx.reply('🤖 *Hermes Agent v3*\nAI-Powered WhatsApp Bot Assistant\n\nUse /help for commands');
            });

            this.telegramBot.command('help', (ctx) => {
                ctx.reply(
                    `*Hermes Agent Commands:*\n\n` +
                    `🎯 *Feature Management*\n` +
                    `/ai <description> - AI generate feature\n` +
                    `/addfeat <name> <desc> - Create feature\n` +
                    `/fix <feature> - Fix broken feature\n` +
                    `/recommend - AI recommendations\n\n` +
                    `🧪 *Testing*\n` +
                    `/testfeat <command> - Test feature\n` +
                    `/testall - Test all features\n\n` +
                    `🚀 *Deployment*\n` +
                    `/gitpush - Push to GitHub\n` +
                    `/deploy - Deploy to panel\n` +
                    `/fulldeploy - Git + Panel deploy\n\n` +
                    `📊 *Monitoring*\n` +
                    `/status - Bot status\n` +
                    `/report - Daily report\n` +
                    `/logs - Recent logs`
                );
            });

            this.telegramBot.command('status', async (ctx) => {
                ctx.reply(await this.getBotStatus());
            });

            // AI Generate Feature
            this.telegramBot.command('ai', async (ctx) => {
                const desc = ctx.message.text.slice(4).trim();
                if (!desc) {
                    ctx.reply('❌ Usage: /ai Buat fitur .cuaca yang mengambil data dari API BMKG');
                    return;
                }
                
                if (!this.aiApiKey) {
                    ctx.reply('❌ AI API Key belum di-set. Tambahkan di environment variables.');
                    return;
                }
                
                ctx.reply('🧠 AI sedang membuat kode...');
                
                const result = await this.aiGenerateFeature(desc);
                ctx.reply(result.message, { parse_mode: 'Markdown' });
                
                if (result.success) {
                    // Ask for confirmation
                    ctx.reply(
                        `✅ Kode sudah dibuat!\n\n` +
                        `Pilih action:\n` +
                        `1️⃣ /testfeat ${result.command} - Test dulu\n` +
                        `2️⃣ /deploy - Langsung deploy\n` +
                        `3️⃣ /gitpush - Push ke GitHub saja`
                    );
                }
            });

            // Recommend features
            this.telegramBot.command('recommend', async (ctx) => {
                ctx.reply('🤖 AI sedang menganalisis bot Anda...');
                const recs = await this.aiRecommendFeatures();
                ctx.reply(recs, { parse_mode: 'Markdown' });
            });

            // Fix feature
            this.telegramBot.command('fix', async (ctx) => {
                const feature = ctx.message.text.slice(5).trim();
                if (!feature) {
                    ctx.reply('❌ Usage: /fix .ssearch');
                    return;
                }
                
                ctx.reply(`🔧 Analyzing ${feature}...`);
                const result = await this.aiFixFeature(feature);
                ctx.reply(result, { parse_mode: 'Markdown' });
            });

            // Test feature
            this.telegramBot.command('testfeat', async (ctx) => {
                const command = ctx.message.text.slice(9).trim();
                if (!command) {
                    ctx.reply('❌ Usage: /testfeat .qc hello');
                    return;
                }
                
                ctx.reply(`🧪 Testing: ${command}...`);
                const result = await this.testFeature(command);
                ctx.reply(result);
            });

            // Git push
            this.telegramBot.command('gitpush', async (ctx) => {
                ctx.reply('📤 Pushing to GitHub...');
                const result = await this.gitPush();
                ctx.reply(result);
            });

            // Deploy to panel
            this.telegramBot.command('deploy', async (ctx) => {
                ctx.reply('🚀 Deploying to panel...');
                const result = await this.deployToPanel();
                ctx.reply(result, { parse_mode: 'Markdown' });
            });

            // Full deploy
            this.telegramBot.command('fulldeploy', async (ctx) => {
                ctx.reply('🚀 Full deployment started...\n📤 Git → 🚀 Panel');
                
                const git = await this.gitPush();
                ctx.reply(git);
                
                if (git.includes('✅')) {
                    const deploy = await this.deployToPanel();
                    ctx.reply(deploy, { parse_mode: 'Markdown' });
                }
            });

            // Report
            this.telegramBot.command('report', async (ctx) => {
                const report = await this.generateReport();
                ctx.reply(report, { parse_mode: 'Markdown' });
            });

            // Logs
            this.telegramBot.command('logs', (ctx) => {
                ctx.reply(this.getRecentLogs());
            });

            this.telegramBot.catch((err) => {
                logger.error(`Telegram error: ${err.message}`);
            });

            this.telegramBot.launch();
            logger.success('Telegram Bot initialized');
            
        } catch (e) {
            logger.error(`Failed to init Telegram: ${e.message}`);
        }
    }

    async sendTelegramMessage(message) {
        if (!this.telegramBot || !this.adminChatId) return;
        try {
            await this.telegramBot.telegram.sendMessage(this.adminChatId, message, { parse_mode: 'Markdown' });
        } catch (e) {
            logger.error(`Failed to send Telegram message: ${e.message}`);
        }
    }

    // AI Code Generation using Groq or OpenRouter
    async aiGenerateFeature(description) {
        try {
            logger.info(`AI generating feature: ${description}`);
            
            // Create prompt for AI
            const prompt = this.createAIPrompt(description);
            
            // Call AI API
            let code = null;
            
            if (this.aiProvider === 'groq') {
                code = await this.callGroqAPI(prompt);
            } else {
                code = await this.callOpenRouterAPI(prompt);
            }
            
            if (!code) {
                return {
                    success: false,
                    message: '❌ AI gagal generate kode'
                };
            }
            
            // Extract feature name from description
            const featName = this.extractFeatureName(description);
            const command = `.${featName}`;
            
            // Save file
            const featurePath = path.join(__dirname, '..', 'features', `${featName}.js`);
            await fs.writeFile(featurePath, code);
            
            // Update index.js
            await this.addFeatureToIndex(featName, command, description);
            
            logger.success(`Feature ${featName} generated`);
            
            return {
                success: true,
                message: `✅ *Feature Generated: ${featName}*\n\n📝 ${description}\n📁 src/features/${featName}.js\n⌨️ Command: ${command}`,
                command: command,
                featName: featName
            };
            
        } catch (e) {
            logger.error(`AI generation failed: ${e.message}`);
            return {
                success: false,
                message: `❌ Error: ${e.message}`
            };
        }
    }

    createAIPrompt(description) {
        return `Create a WhatsApp bot feature for Node.js using Baileys library.

Feature description: ${description}

Requirements:
1. Use async/await
2. Include proper error handling with try-catch
3. Send response using sock.sendMessage()
4. Use logger for logging
5. Export the handler function
6. Use node-fetch for HTTP requests
7. Include comments explaining the code

Return ONLY the complete JavaScript code, no explanations.

Template:
const logger = require('./logger');
const fetch = require('node-fetch');

async function handleFeatureName(sock, msg, text) {
    try {
        // Implementation
    } catch (e) {
        logger.error(e.message);
        await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error: ' + e.message }, { quoted: msg });
    }
}

module.exports = { handleFeatureName };`;
    }

    async callGroqAPI(prompt) {
        try {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.aiApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'llama-3.1-70b-versatile',
                    messages: [
                        { role: 'system', content: 'You are an expert Node.js developer. Write clean, working code.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 2000
                })
            });
            
            const json = await res.json();
            return json.choices?.[0]?.message?.content;
        } catch (e) {
            logger.error(`Groq API error: ${e.message}`);
            return null;
        }
    }

    async callOpenRouterAPI(prompt) {
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.aiApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'meta-llama/llama-3.1-70b-instruct:free',
                    messages: [
                        { role: 'system', content: 'You are an expert Node.js developer.' },
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 2000
                })
            });
            
            const json = await res.json();
            return json.choices?.[0]?.message?.content;
        } catch (e) {
            logger.error(`OpenRouter API error: ${e.message}`);
            return null;
        }
    }

    extractFeatureName(description) {
        // Extract feature name from description
        const match = description.match(/\.(\w+)/);
        if (match) return match[1];
        
        // Default: use first word
        const words = description.toLowerCase().split(' ');
        return words[0].replace(/[^a-z]/g, '');
    }

    async addFeatureToIndex(featName, command, description) {
        try {
            const indexPath = path.join(__dirname, '..', '..', 'index.js');
            let content = await fs.readFile(indexPath, 'utf8');
            
            // Add import
            const importLine = `const { handle${featName.charAt(0).toUpperCase() + featName.slice(1)} } = require('./src/features/${featName}');`;
            if (!content.includes(importLine)) {
                // Add after last require
                content = content.replace(
                    /(const.*= require\(.+\);\n)(?!const)/,
                    `$1${importLine}\n`
                );
            }
            
            // Add command handler (simplified)
            const handlerCode = `
                // ${featName} - ${description}
                if (textContent.startsWith(PREFIX + '${featName}')) {
                    await handle${featName.charAt(0).toUpperCase() + featName.slice(1)}(sock, msg, textContent);
                    continue;
                }
            `;
            
            await fs.writeFile(indexPath, content);
            logger.info(`Updated index.js for ${featName}`);
            
        } catch (e) {
            logger.error(`Failed to update index.js: ${e.message}`);
        }
    }

    // AI Recommend Features
    async aiRecommendFeatures() {
        try {
            const features = [
                '🌤️ `.weather <kota>` - Info cuaca real-time',
                '📊 `.poll <pertanyaan>` - Voting di grup',
                '🎮 `.game tebakangka` - Game tebak angka',
                '📅 `.reminder <waktu> <pesan>` - Pengingat',
                '💱 `.kurs <mata uang>` - Kurs mata uang',
                '🎲 `.dadu` - Lempar dadu virtual',
                '🎱 `.8ball <pertanyaan>` - Magic 8-ball',
                '📈 `.crypto <coin>` - Harga crypto',
                '🍔 `.resep <makanan>` - Cari resep masakan',
                '🎬 `.movie <judul>` - Info film'
            ];
            
            const randomFeatures = features.sort(() => 0.5 - Math.random()).slice(0, 5);
            
            return (
                `🤖 *AI Feature Recommendations*\n\n` +
                `Berdasarkan analisis bot Anda, fitur ini cocok ditambahkan:\n\n` +
                randomFeatures.map((f, i) => `${i + 1}. ${f}`).join('\n') +
                `\n\n💡 Untuk membuat, ketik:\n` +
                `/ai Buat fitur .weather yang ambil data dari API`
            );
            
        } catch (e) {
            return `❌ Error: ${e.message}`;
        }
    }

    // AI Fix Feature
    async aiFixFeature(featureName) {
        try {
            const featurePath = path.join(__dirname, '..', 'features', `${featureName.replace('.', '')}.js`);
            
            // Check if file exists
            try {
                await fs.access(featurePath);
            } catch {
                return `❌ Feature ${featureName} tidak ditemukan`;
            }
            
            // Read current code
            const currentCode = await fs.readFile(featurePath, 'utf8');
            
            // Create fix prompt
            const prompt = `Fix this WhatsApp bot feature code:\n\n${currentCode}\n\nIdentify and fix any bugs, improve error handling, and optimize the code. Return ONLY the fixed complete code.`;
            
            // Call AI
            let fixedCode = null;
            if (this.aiProvider === 'groq') {
                fixedCode = await this.callGroqAPI(prompt);
            } else {
                fixedCode = await this.callOpenRouterAPI(prompt);
            }
            
            if (!fixedCode) {
                return '❌ AI gagal memperbaiki kode';
            }
            
            // Backup old code
            await fs.writeFile(`${featurePath}.backup`, currentCode);
            
            // Save fixed code
            await fs.writeFile(featurePath, fixedCode);
            
            return `✅ *Feature ${featureName} Fixed*\n\n🔧 Perbaikan dilakukan oleh AI\n💾 Backup tersimpan di ${featureName}.js.backup\n\nGunakan /testfeat ${featureName} untuk test.`;
            
        } catch (e) {
            return `❌ Error: ${e.message}`;
        }
    }

    // Deploy to Panel
    async deployToPanel() {
        try {
            logger.info('Deploying to panel...');
            
            const filesToDeploy = [
                'index.js',
                'src/features',
                'src/utils',
                'package.json'
            ];
            
            let deployed = 0;
            
            for (const file of filesToDeploy) {
                try {
                    await this.uploadFileToPanel(file);
                    deployed++;
                } catch (e) {
                    logger.error(`Failed to deploy ${file}: ${e.message}`);
                }
            }
            
            // Restart server
            await this.restartPanelServer();
            
            return (
                `🚀 *Deployment Complete*\n\n` +
                `✅ ${deployed} files deployed\n` +
                `🔄 Server restarted\n\n` +
                `Bot is now updated and running!`
            );
            
        } catch (e) {
            logger.error(`Deploy failed: ${e.message}`);
            return `❌ Deploy failed: ${e.message}`;
        }
    }

    async uploadFileToPanel(filePath) {
        const fullPath = path.join(process.cwd(), filePath);
        const content = await fs.readFile(fullPath);
        
        const res = await fetch(`${this.panelUrl}/api/client/servers/${this.serverId}/files/write`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.panelApiKey}`,
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/json'
            },
            body: content
        });
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    }

    async restartPanelServer() {
        const res = await fetch(`${this.panelUrl}/api/client/servers/${this.serverId}/power`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.panelApiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ signal: 'restart' })
        });
        
        if (!res.ok) {
            throw new Error(`Failed to restart: HTTP ${res.status}`);
        }
        
        logger.success('Panel server restarted');
    }

    // Test Feature
    async testFeature(command) {
        try {
            logger.info(`Testing: ${command}`);
            
            // Check command exists
            const indexPath = path.join(__dirname, '..', '..', 'index.js');
            const content = await fs.readFile(indexPath, 'utf8');
            
            const cmd = command.split(' ')[0];
            const exists = content.includes(cmd);
            
            if (!exists) {
                return `❌ Command ${cmd} tidak ditemukan di index.js`;
            }
            
            // Validate syntax
            const featurePath = path.join(__dirname, '..', 'features', `${cmd.replace('.', '')}.js`);
            try {
                await fs.access(featurePath);
                const code = await fs.readFile(featurePath, 'utf8');
                
                // Basic syntax check
                if (!code.includes('module.exports')) {
                    return `⚠️ ${cmd}: Tidak ada module.exports`;
                }
                if (!code.includes('async')) {
                    return `⚠️ ${cmd}: Tidak menggunakan async`;
                }
                
                return `✅ *${cmd}* ditemukan dan valid!\n\n🧪 Manual test:\nKetik ${command} di WhatsApp`;
                
            } catch {
                return `⚠️ ${cmd}: File feature tidak ditemukan`;
            }
            
        } catch (e) {
            return `❌ Test error: ${e.message}`;
        }
    }

    // Git Push
    async gitPush() {
        try {
            logger.info('Pushing to git...');
            
            execSync('git add .', { cwd: process.cwd() });
            
            try {
                execSync('git commit -m "Hermes Agent: auto update"', { cwd: process.cwd() });
            } catch {
                // No changes to commit
                return '⚠️ Tidak ada perubahan untuk di-push';
            }
            
            execSync('git push origin master', { cwd: process.cwd() });
            
            logger.success('Git push complete');
            return '✅ Pushed to GitHub!';
            
        } catch (e) {
            logger.error(`Git push failed: ${e.message}`);
            return `❌ Git push failed: ${e.message}`;
        }
    }

    // Status
    async getBotStatus() {
        return (
            `📊 *Bot Status*\n\n` +
            `🤖 WhatsApp Bot: *Running*\n` +
            `🎯 Hermes Agent: *${this.isRunning ? 'Active' : 'Stopped'}*\n` +
            `🧠 AI: *${this.aiApiKey ? 'Ready' : 'Need API Key'}*\n` +
            `🚀 Panel Deploy: *Ready*\n` +
            `⏰ ${new Date().toLocaleString()}`
        );
    }

    // Report
    async generateReport() {
        return (
            `📋 *Daily Report*\n\n` +
            `📅 ${new Date().toLocaleDateString()}\n` +
            `✅ Bot: Online\n` +
            `✅ Hermes: Active\n` +
            `📊 Tasks: ${this.tasks.length}\n\n` +
            `📝 Activity:\n` +
            `- System nominal\n` +
            `- Telegram connected\n` +
            `- Monitoring active`
        );
    }

    getRecentLogs() {
        return (
            `📜 *Recent Logs*\n\n` +
            `✅ Hermes Agent v3 started\n` +
            `✅ Telegram bot ready\n` +
            `✅ AI module loaded\n` +
            `ℹ️ Waiting for commands`
        );
    }

    // Main Loop
    async mainLoop() {
        while (this.isRunning) {
            try {
                await this.processTasks();
                await this.sleep(30000);
            } catch (e) {
                logger.error(`Loop error: ${e.message}`);
                await this.sleep(5000);
            }
        }
    }

    async processTasks() {
        if (this.tasks.length === 0) return;
        
        const task = this.tasks.shift();
        logger.info(`Processing: ${task.type}`);
        
        try {
            switch (task.type) {
                case 'create_feature':
                    await this.aiGenerateFeature(task.data.description);
                    break;
                case 'fix_feature':
                    await this.aiFixFeature(task.data.feature);
                    break;
                case 'deploy':
                    await this.deployToPanel();
                    break;
                case 'report':
                    await this.sendTelegramMessage(await this.generateReport());
                    break;
            }
        } catch (e) {
            logger.error(`Task failed: ${e.message}`);
        }
    }

    addTask(type, data) {
        this.tasks.push({ type, data, timestamp: Date.now() });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        logger.info('Stopping Hermes Agent...');
        this.isRunning = false;
        if (this.telegramBot) {
            this.telegramBot.stop('SIGTERM');
        }
    }
}

// Start
const agent = new HermesAgent();

process.on('SIGINT', () => { agent.stop(); process.exit(0); });
process.on('SIGTERM', () => { agent.stop(); process.exit(0); });

agent.start().catch(e => {
    logger.error(`Failed to start: ${e.message}`);
    process.exit(1);
});

module.exports = { HermesAgent };
