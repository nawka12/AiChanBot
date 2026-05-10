/**
 * Scheduler module for AiChanBot
 * Handles timers (one-shot delayed tasks) and cron jobs (recurring scheduled tasks)
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Directory structure for storing schedules
const CRONJOBS_DIR = path.join(__dirname, 'cronjobs');
const USERS_DIR = path.join(CRONJOBS_DIR, 'users');
const GUILDS_DIR = path.join(CRONJOBS_DIR, 'guilds');

// Limits
const LIMITS = {
    USER_MAX_CRON: 5,
    USER_MAX_TIMERS: 10,
    GUILD_MAX_CRON: 10,
    GUILD_MAX_TIMERS: 20
};

// In-memory registry for active schedules
// taskId -> { type: 'cron' | 'timer', handler: CronJob | TimeoutId, scope: 'user' | 'guild', scopeId: string }
const activeSchedules = new Map();

// Reference to the Discord client (set during initialization)
let discordClient = null;

// Reference to AI response generator (set during initialization)
let aiResponseGenerator = null;

/**
 * Ensure scheduler directories exist
 */
function ensureSchedulerDirectories() {
    try {
        if (!fs.existsSync(CRONJOBS_DIR)) {
            fs.mkdirSync(CRONJOBS_DIR, { recursive: true });
        }
        if (!fs.existsSync(USERS_DIR)) {
            fs.mkdirSync(USERS_DIR, { recursive: true });
        }
        if (!fs.existsSync(GUILDS_DIR)) {
            fs.mkdirSync(GUILDS_DIR, { recursive: true });
        }
    } catch (error) {
        console.error('Error creating scheduler directories:', error);
    }
}

/**
 * Get file path for schedules
 * @param {string} scope - 'user' or 'guild'
 * @param {string} id - User ID or Guild ID
 * @returns {string} File path
 */
function getScheduleFilePath(scope, id) {
    if (scope === 'guild') {
        return path.join(GUILDS_DIR, `${id}.json`);
    }
    return path.join(USERS_DIR, `${id}.json`);
}

/**
 * Load schedules from file
 * @param {string} scope - 'user' or 'guild'
 * @param {string} id - User ID or Guild ID
 * @returns {Array} Array of schedule objects
 */
function loadSchedules(scope, id) {
    try {
        const filePath = getScheduleFilePath(scope, id);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error loading schedules for ${scope}/${id}:`, error);
    }
    return [];
}

/**
 * Save schedules to file
 * @param {string} scope - 'user' or 'guild'
 * @param {string} id - User ID or Guild ID
 * @param {Array} schedules - Array of schedule objects
 */
function saveSchedules(scope, id, schedules) {
    try {
        ensureSchedulerDirectories();
        const filePath = getScheduleFilePath(scope, id);
        fs.writeFileSync(filePath, JSON.stringify(schedules, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error saving schedules for ${scope}/${id}:`, error);
        throw error;
    }
}

/**
 * Get all schedules for a scope/id
 * @param {string} scope - 'user' or 'guild'
 * @param {string} id - User ID or Guild ID
 * @returns {Array} Array of schedule objects
 */
function getSchedules(scope, id) {
    return loadSchedules(scope, id);
}

/**
 * Check if can create more tasks
 * @param {string} scope - 'user' or 'guild'
 * @param {string} id - User ID or Guild ID
 * @param {string} taskType - 'cron' or 'timer'
 * @returns {Object} { allowed: boolean, current: number, max: number }
 */
function canCreateTask(scope, id, taskType) {
    const schedules = loadSchedules(scope, id);
    const existing = schedules.filter(t => t.taskType === taskType);
    const limits = scope === 'user'
        ? { cron: LIMITS.USER_MAX_CRON, timer: LIMITS.USER_MAX_TIMERS }
        : { cron: LIMITS.GUILD_MAX_CRON, timer: LIMITS.GUILD_MAX_TIMERS };
    const max = limits[taskType];
    return {
        allowed: existing.length < max,
        current: existing.length,
        max
    };
}

/**
 * Validate cron expression
 * @param {string} expression - Cron expression
 * @returns {boolean} True if valid
 */
function isValidCron(expression) {
    return cron.validate(expression);
}

/**
 * Parse duration string to milliseconds
 * @param {string} input - Duration string like "1 minute", "30 minutes", "2 hours"
 * @returns {number|null} Milliseconds or null if invalid
 */
function parseDuration(input) {
    const patterns = [
        { regex: /(\d+)\s*(?:sec|second|seconds)/i, unit: 'seconds' },
        { regex: /(\d+)\s*(?:min|minute|minutes)/i, unit: 'minutes' },
        { regex: /(\d+)\s*(?:hr|hour|hours)/i, unit: 'hours' },
        { regex: /(\d+)\s*(?:day|days)/i, unit: 'days' }
    ];

    for (const { regex, unit } of patterns) {
        const match = input.match(regex);
        if (match) {
            const value = parseInt(match[1], 10);
            switch (unit) {
                case 'seconds':
                    return value * 1000;
                case 'minutes':
                    return value * 60 * 1000;
                case 'hours':
                    return value * 60 * 60 * 1000;
                case 'days':
                    return value * 24 * 60 * 60 * 1000;
            }
        }
    }
    return null;
}

/**
 * Describe a cron expression in human-readable form
 * @param {string} expression - Cron expression
 * @returns {string} Human-readable description
 */
function describeCron(expression) {
    const parts = expression.split(' ');
    if (parts.length !== 5) return expression;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Common patterns
    if (expression === '* * * * *') return 'Every minute';
    if (expression === '0 * * * *') return 'Every hour';
    if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*') {
        const hourInt = parseInt(hour, 10);
        const minuteInt = parseInt(minute, 10);
        const timeStr = `${hourInt.toString().padStart(2, '0')}:${minuteInt.toString().padStart(2, '0')}`;

        if (dayOfWeek === '*') {
            return `Every day at ${timeStr}`;
        } else if (dayOfWeek === '1-5') {
            return `Every weekday at ${timeStr}`;
        } else if (dayOfWeek === '0,6') {
            return `Every weekend at ${timeStr}`;
        } else if (dayOfWeek === '1') {
            return `Every Monday at ${timeStr}`;
        } else if (dayOfWeek === '2') {
            return `Every Tuesday at ${timeStr}`;
        } else if (dayOfWeek === '3') {
            return `Every Wednesday at ${timeStr}`;
        } else if (dayOfWeek === '4') {
            return `Every Thursday at ${timeStr}`;
        } else if (dayOfWeek === '5') {
            return `Every Friday at ${timeStr}`;
        } else if (dayOfWeek === '6') {
            return `Every Saturday at ${timeStr}`;
        } else if (dayOfWeek === '0') {
            return `Every Sunday at ${timeStr}`;
        }
    }

    return `Cron: ${expression}`;
}

/**
 * Generate UUID for task
 * @returns {string} UUID string
 */
function generateTaskId() {
    // Simple UUID-like generator without external dependency
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Create a new scheduled task
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 * @param {Object} taskData - Task configuration
 * @returns {Object} Created task or error
 */
function createSchedule(scope, scopeId, taskData) {
    const { taskType, name, schedule, actionType, content, prompt, channelId, createdBy, duration } = taskData;

    // Validate task type
    if (!['cron', 'timer'].includes(taskType)) {
        return { error: 'Invalid task type. Must be "cron" or "timer".' };
    }

    // Check limits
    const limitCheck = canCreateTask(scope, scopeId, taskType);
    if (!limitCheck.allowed) {
        return {
            error: `Limit reached. You have ${limitCheck.current}/${limitCheck.max} ${taskType} tasks.`,
            current: limitCheck.current,
            max: limitCheck.max
        };
    }

    // Validate action type
    if (!['preset', 'ai'].includes(actionType)) {
        return { error: 'Invalid action type. Must be "preset" or "ai".' };
    }

    // Validate content/prompt based on action type
    if (actionType === 'preset' && (!content || content.trim() === '')) {
        return { error: 'Content is required for preset action type.' };
    }
    if (actionType === 'ai' && (!prompt || prompt.trim() === '')) {
        return { error: 'Prompt is required for AI action type.' };
    }

    let executeAt = null;
    let cronExpression = null;
    let scheduleDescription = '';

    if (taskType === 'timer') {
        // Parse duration for timer
        let durationMs = null;
        if (duration) {
            durationMs = parseDuration(duration);
        } else if (schedule) {
            durationMs = parseDuration(schedule);
        }

        if (!durationMs || durationMs <= 0) {
            return { error: 'Invalid duration. Examples: "1 minute", "30 minutes", "2 hours".' };
        }

        // Minimum 10 seconds for timers
        if (durationMs < 10000) {
            return { error: 'Timer duration must be at least 10 seconds.' };
        }

        executeAt = new Date(Date.now() + durationMs).toISOString();
        scheduleDescription = `In ${formatDuration(durationMs)}`;
    } else {
        // Validate cron expression
        if (!schedule || !isValidCron(schedule)) {
            return { error: `Invalid cron expression: "${schedule}". Use format: "minute hour day-of-month month day-of-week".` };
        }
        cronExpression = schedule;
        scheduleDescription = describeCron(schedule);
    }

    // Create the task object
    const task = {
        id: generateTaskId(),
        name: name || (taskType === 'timer' ? 'Timer' : 'Scheduled Task'),
        taskType,
        schedule: cronExpression,
        executeAt,
        scheduleDescription,
        actionType,
        content: actionType === 'preset' ? content : null,
        prompt: actionType === 'ai' ? prompt : null,
        channelId,
        createdBy,
        createdAt: new Date().toISOString(),
        enabled: true,
        lastRun: null,
        runCount: 0
    };

    // Load existing schedules and add new task
    const schedules = loadSchedules(scope, scopeId);
    schedules.push(task);
    saveSchedules(scope, scopeId, schedules);

    // Schedule the task
    scheduleTask(task, scope, scopeId);

    return { success: true, task };
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration
 */
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

/**
 * Delete a scheduled task
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 * @param {string} taskId - Task ID to delete
 * @returns {Object} Result
 */
function deleteSchedule(scope, scopeId, taskId) {
    const schedules = loadSchedules(scope, scopeId);
    const index = schedules.findIndex(t => t.id === taskId);

    if (index === -1) {
        return { error: 'Task not found.' };
    }

    const task = schedules[index];

    // Unschedule the task
    unscheduleTask(taskId);

    // Remove from array and save
    schedules.splice(index, 1);
    saveSchedules(scope, scopeId, schedules);

    return { success: true, deletedTask: task };
}

/**
 * Toggle a scheduled task's enabled state
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 * @param {string} taskId - Task ID to toggle
 * @returns {Object} Result
 */
function toggleSchedule(scope, scopeId, taskId) {
    const schedules = loadSchedules(scope, scopeId);
    const task = schedules.find(t => t.id === taskId);

    if (!task) {
        return { error: 'Task not found.' };
    }

    // Toggle the enabled state
    task.enabled = !task.enabled;
    saveSchedules(scope, scopeId, schedules);

    if (task.enabled) {
        // Re-schedule the task
        scheduleTask(task, scope, scopeId);
    } else {
        // Unschedule the task
        unscheduleTask(taskId);
    }

    return { success: true, task, enabled: task.enabled };
}

/**
 * Schedule a task (register with cron or setTimeout)
 * @param {Object} task - Task object
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 */
function scheduleTask(task, scope, scopeId) {
    if (!task.enabled) return;

    // Unschedule if already scheduled
    if (activeSchedules.has(task.id)) {
        unscheduleTask(task.id);
    }

    if (task.taskType === 'timer') {
        scheduleTimer(task, scope, scopeId);
    } else {
        scheduleCron(task, scope, scopeId);
    }
}

/**
 * Schedule a timer (one-shot)
 * @param {Object} task - Task object
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 */
function scheduleTimer(task, scope, scopeId) {
    const executeAt = new Date(task.executeAt);
    const delay = executeAt.getTime() - Date.now();

    if (delay <= 0) {
        // Already past, execute immediately
        console.log(`Timer ${task.id} already expired, executing immediately`);
        executeTask(task, scope, scopeId);
        return;
    }

    console.log(`Scheduling timer ${task.id} "${task.name}" to execute in ${formatDuration(delay)}`);

    const handler = setTimeout(() => {
        executeTask(task, scope, scopeId);
    }, delay);

    activeSchedules.set(task.id, { type: 'timer', handler, scope, scopeId });
}

/**
 * Schedule a cron job (recurring)
 * @param {Object} task - Task object
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 */
function scheduleCron(task, scope, scopeId) {
    if (!task.schedule || !isValidCron(task.schedule)) {
        console.error(`Invalid cron expression for task ${task.id}: ${task.schedule}`);
        return;
    }

    console.log(`Scheduling cron job ${task.id} "${task.name}" with expression: ${task.schedule}`);

    const handler = cron.schedule(task.schedule, () => {
        executeTask(task, scope, scopeId);
    }, {
        timezone: 'Asia/Jakarta' // GMT+7
    });

    activeSchedules.set(task.id, { type: 'cron', handler, scope, scopeId });
}

/**
 * Unschedule a task
 * @param {string} taskId - Task ID
 */
function unscheduleTask(taskId) {
    const entry = activeSchedules.get(taskId);
    if (!entry) return;

    if (entry.type === 'timer') {
        clearTimeout(entry.handler);
    } else if (entry.type === 'cron') {
        entry.handler.stop();
    }

    activeSchedules.delete(taskId);
    console.log(`Unscheduled task ${taskId}`);
}

/**
 * Execute a scheduled task
 * @param {Object} task - Task object
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 */
async function executeTask(task, scope, scopeId) {
    console.log(`Executing task ${task.id} "${task.name}" (${task.taskType})`);

    try {
        if (!discordClient) {
            console.error('Discord client not initialized');
            return;
        }

        const channel = await discordClient.channels.fetch(task.channelId).catch(() => null);
        if (!channel) {
            console.error(`Channel ${task.channelId} not found for task ${task.id}`);
            // For timers, still delete the task even if channel is gone
            if (task.taskType === 'timer') {
                deleteSchedule(scope, scopeId, task.id);
            }
            return;
        }

        let messageContent = '';

        if (task.actionType === 'preset') {
            messageContent = task.content;
        } else if (task.actionType === 'ai') {
            // Use AI to generate response
            if (aiResponseGenerator) {
                try {
                    messageContent = await aiResponseGenerator(task.prompt, scope, scopeId, task.channelId);
                } catch (aiError) {
                    console.error(`AI generation error for task ${task.id}:`, aiError);
                    messageContent = `[Scheduled reminder] ${task.prompt}`;
                }
            } else {
                // Fallback if AI generator not set
                messageContent = `[Scheduled reminder] ${task.prompt}`;
            }
        }

        // Send the message
        await channel.send(messageContent);
        console.log(`Task ${task.id} executed successfully`);

        // Update task tracking
        const schedules = loadSchedules(scope, scopeId);
        const taskIndex = schedules.findIndex(t => t.id === task.id);

        if (taskIndex !== -1) {
            schedules[taskIndex].lastRun = new Date().toISOString();
            schedules[taskIndex].runCount++;

            if (task.taskType === 'timer') {
                // Timer: delete after execution
                schedules.splice(taskIndex, 1);
                activeSchedules.delete(task.id);
                console.log(`Timer ${task.id} completed and deleted`);
            }

            saveSchedules(scope, scopeId, schedules);
        }

    } catch (error) {
        console.error(`Error executing task ${task.id}:`, error);
    }
}

/**
 * Load and schedule all tasks on startup
 * @param {Object} client - Discord client
 * @param {Function} aiGenerator - Function to generate AI responses
 */
async function loadAndScheduleAllTasks(client, aiGenerator) {
    discordClient = client;
    aiResponseGenerator = aiGenerator;

    ensureSchedulerDirectories();

    // Load user schedules
    if (fs.existsSync(USERS_DIR)) {
        const userFiles = fs.readdirSync(USERS_DIR);
        for (const file of userFiles) {
            if (file.endsWith('.json')) {
                const userId = file.replace('.json', '');
                const schedules = loadSchedules('user', userId);
                console.log(`Loading ${schedules.length} schedules for user ${userId}`);
                for (const task of schedules) {
                    if (task.enabled) {
                        scheduleTask(task, 'user', userId);
                    }
                }
            }
        }
    }

    // Load guild schedules
    if (fs.existsSync(GUILDS_DIR)) {
        const guildFiles = fs.readdirSync(GUILDS_DIR);
        for (const file of guildFiles) {
            if (file.endsWith('.json')) {
                const guildId = file.replace('.json', '');
                const schedules = loadSchedules('guild', guildId);
                console.log(`Loading ${schedules.length} schedules for guild ${guildId}`);
                for (const task of schedules) {
                    if (task.enabled) {
                        scheduleTask(task, 'guild', guildId);
                    }
                }
            }
        }
    }

    console.log(`Scheduler initialized. ${activeSchedules.size} tasks active.`);
}

/**
 * Clean up guild schedules when bot is removed from guild
 * @param {string} guildId - Guild ID
 */
function cleanupGuildSchedules(guildId) {
    const schedules = loadSchedules('guild', guildId);

    // Unschedule all tasks for this guild
    for (const task of schedules) {
        unscheduleTask(task.id);
    }

    // Delete the file
    const filePath = getScheduleFilePath('guild', guildId);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up schedules for guild ${guildId}`);
    }
}

module.exports = {
    ensureSchedulerDirectories,
    loadSchedules,
    saveSchedules,
    getSchedules,
    createSchedule,
    deleteSchedule,
    toggleSchedule,
    scheduleTask,
    unscheduleTask,
    executeTask,
    loadAndScheduleAllTasks,
    cleanupGuildSchedules,
    canCreateTask,
    isValidCron,
    parseDuration,
    describeCron,
    formatDuration,
};
