/**
 * Hermes Agent - AI Assistant Agent
 * Runs alongside WhatsApp Bot
 */

const logger = {
    info: (msg) => console.log(`[HERMES] ℹ️ ${msg}`),
    warn: (msg) => console.log(`[HERMES] ⚠️ ${msg}`),
    error: (msg) => console.log(`[HERMES] ❌ ${msg}`),
    success: (msg) => console.log(`[HERMES] ✅ ${msg}`)
};

class HermesAgent {
    constructor() {
        this.name = 'Hermes';
        this.version = '1.0.0';
        this.isRunning = false;
        this.tasks = [];
    }

    async start() {
        logger.info(`Starting ${this.name} Agent v${this.version}...`);
        this.isRunning = true;
        
        // Main loop
        this.mainLoop();
        
        logger.success(`${this.name} Agent is running!`);
    }

    async mainLoop() {
        while (this.isRunning) {
            try {
                // Check for pending tasks
                await this.processTasks();
                
                // Heartbeat
                logger.info('Agent heartbeat - alive');
                
                // Wait 30 seconds
                await this.sleep(30000);
            } catch (e) {
                logger.error(`Main loop error: ${e.message}`);
                await this.sleep(5000);
            }
        }
    }

    async processTasks() {
        if (this.tasks.length === 0) return;
        
        const task = this.tasks.shift();
        logger.info(`Processing task: ${task.type}`);
        
        try {
            await this.executeTask(task);
        } catch (e) {
            logger.error(`Task failed: ${e.message}`);
        }
    }

    async executeTask(task) {
        switch (task.type) {
            case 'reminder':
                logger.info(`Reminder: ${task.data.message}`);
                break;
            case 'ai_query':
                logger.info(`AI Query: ${task.data.query}`);
                // Integrate with AI API here
                break;
            case 'schedule':
                logger.info(`Scheduled task: ${task.data.action}`);
                break;
            default:
                logger.warn(`Unknown task type: ${task.type}`);
        }
    }

    addTask(type, data) {
        this.tasks.push({ type, data, timestamp: Date.now() });
        logger.info(`Task added: ${type}`);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        logger.info('Stopping Hermes Agent...');
        this.isRunning = false;
    }
}

// Start agent
const agent = new HermesAgent();

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    agent.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    agent.stop();
    process.exit(0);
});

// Start
agent.start().catch(e => {
    logger.error(`Failed to start agent: ${e.message}`);
    process.exit(1);
});

module.exports = { HermesAgent };
