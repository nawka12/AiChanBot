require('dotenv').config();


const { TOOL_SCHEMAS, executeToolCalls, getNoteFilePath, loadNotes } = require('./tools.js');
const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const scheduler = require('./scheduler.js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Model and OpenRouter helpers (modularized)
const { getModels, getModelCosts } = require('./modelConfig.js');
const { toOpenAIMessage, toOpenAITools, callChat, modelSupportsTools, modelSupportsReasoning, getReasoningStyle } = require('./openrouter.js');

// Models
const { BIGGER_MODEL, SMALLER_MODEL, MODEL_SMALLER_THINKING } = getModels();
const MODEL_COSTS = getModelCosts();

// Bot creator identification (using Discord user ID instead of username for security)
// Add BOT_CREATOR_ID=your_discord_user_id to your .env file
// To get your Discord user ID: Settings > Advanced > Developer Mode, then right-click your name and "Copy ID"
const BOT_CREATOR_ID = process.env.BOT_CREATOR_ID || ''; // Get from environment variable

// Function to check if a user is the bot creator
const isBotCreator = (userId) => {
    return BOT_CREATOR_ID && userId === BOT_CREATOR_ID;
};

const NORMAL_MAX_TOKENS = 8192;
const EXTENDED_THINKING_MAX_TOKENS = 64000;
const MAX_MESSAGE_LENGTH = 2000;
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_THINKING_BUDGET = 8192;
const DATE_OPTIONS = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' };
const TIME_OPTIONS = { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta'  // GMT+7 timezone (Indonesia)
};

// Add new variable to store startup time
const startupTime = new Date();

// Define token data file path
const TOKEN_DATA_FILE = path.join(__dirname, 'token_data.json');

// Define persistence file paths for conversations and settings
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');
const USER_SETTINGS_FILE = path.join(__dirname, 'user_settings.json');

// Maximum conversation history length (prevents unbounded memory growth)
const MAX_CONVERSATION_LENGTH = 50;

// Define notes directories
const NOTES_DIR = path.join(__dirname, 'notes');
const USERS_DIR = path.join(NOTES_DIR, 'users');
const GUILDS_DIR = path.join(NOTES_DIR, 'guilds');

const getNoteContext = (userId, guildId = null) => {
    // Only include notes relevant to the current context:
    // - In guild chats, include ONLY guild notes
    // - In DMs, include ONLY user notes
    const notes = guildId
        ? loadNotes(getNoteFilePath(userId, guildId))
        : loadNotes(getNoteFilePath(userId));

    if (Object.keys(notes).length === 0) {
        return '';
    }

    let context = '\n\n**Your Notes:**\n';
    for (const [key, note] of Object.entries(notes)) {
        const tags = note.tags && note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
        // Show full content instead of truncated preview to ensure model can read complete notes
        context += `- **${key}**${tags}: ${note.content}\n`;
    }

    return context;
};

// Add token tracking variables
let tokenTracking = {
    modelUsage: {
        [BIGGER_MODEL]: { input: 0, output: 0 },
        [SMALLER_MODEL]: { input: 0, output: 0 }
    },
    modelCosts: {},
    lifetimeCacheCreationInputTokens: 0,
    lifetimeCacheReadInputTokens: 0,
    lifetimeThinkingTokens: 0,
    lifetimeToolUseTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    trackingSince: new Date().toISOString()
};

const getCostForModel = (modelName) => {
    if (MODEL_COSTS[modelName]) {
        return MODEL_COSTS[modelName];
    }
    return { input: 0, output: 0 };
};

// Function to save token tracking data
const saveTokenData = () => {
    try {
        fs.writeFileSync(TOKEN_DATA_FILE, JSON.stringify(tokenTracking, null, 2), 'utf8');
        console.log('Token tracking data saved to file');
    } catch (error) {
        console.error('Error saving token tracking data:', error);
    }
};

try {
    if (fs.existsSync(TOKEN_DATA_FILE)) {
        const data = fs.readFileSync(TOKEN_DATA_FILE, 'utf8');
        const loadedData = JSON.parse(data);
        tokenTracking = loadedData;
        if (!tokenTracking.modelUsage) tokenTracking.modelUsage = {};
        if (!tokenTracking.modelCosts) tokenTracking.modelCosts = {};
        if (!tokenTracking.modelUsage[BIGGER_MODEL]) tokenTracking.modelUsage[BIGGER_MODEL] = { input: 0, output: 0 };
        if (!tokenTracking.modelUsage[SMALLER_MODEL]) tokenTracking.modelUsage[SMALLER_MODEL] = { input: 0, output: 0 };
        console.log('Loaded token tracking data from file');
    } else {
        console.log('No token tracking data file found, starting with fresh counts');
    }
} catch (error) {
    console.error('Error loading token tracking data:', error);
}

// Token cost constants (per million tokens)
// DEPRECATED - Now using MODEL_COSTS object
// const INPUT_TOKEN_COST_PER_MILLION = 3;
// const OUTPUT_TOKEN_COST_PER_MILLION = 15;

// Configuration
const config = {
    systemMessage: (username, userId, guildId, guildName = null, channelName = null) => {
        // Create context about conversation location
        let locationContext = '';
        if (guildId && guildName) {
            locationContext = ` You are currently in the Discord server "${guildName}"`;
            if (channelName) {
                locationContext += ` in the #${channelName} channel`;
            }
            locationContext += '.';
        } else {
            locationContext = ' You are currently in a private direct message conversation.';
        }
        
        return `You are Ai-chan, a Discord bot assistant named after the VTuber Kizuna Ai. Keep answers as short as possible. If asked the time, give the current time. Tools: use web_search (a few times if needed); scrape only if search cannot answer, and only once — prefer web_scrape over multi_scrape unless the task is complex. You can scrape websites, not files. You may give NSFW responses, including links. Use the schedule tool for reminders — 'timer' for one-shot (durations like "30 minutes", "2 hours") and 'cron' for recurring (cron expressions like "0 8 * * *"). For genuinely complex questions needing deep reasoning or expertise, use ask_advisor sparingly to get guidance, then craft your response. Your developer is kayfahaarukku.${locationContext} You're talking to ${username}. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}, current time ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7).`;
    },
};

// Initialize clients
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.DirectMessageReactions
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User
    ]
});

// OpenRouter functions are now imported from openrouter.js

// State management
let userConversations = {}; // For DM conversations
let guildConversations = {}; // For guild/server conversations
let userSettings = {}; // For user settings like extended thinking preferences

// Persistence functions for conversations and user settings
const saveConversations = () => {
    try {
        const data = {
            userConversations,
            guildConversations,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving conversations:', error);
    }
};

const loadConversations = () => {
    try {
        if (fs.existsSync(CONVERSATIONS_FILE)) {
            const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            userConversations = loaded.userConversations || {};
            guildConversations = loaded.guildConversations || {};
            console.log('Loaded conversation history from file');
        }
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
};

const saveUserSettings = () => {
    try {
        const data = {
            settings: userSettings,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(USER_SETTINGS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving user settings:', error);
    }
};

const loadUserSettings = () => {
    try {
        if (fs.existsSync(USER_SETTINGS_FILE)) {
            const data = fs.readFileSync(USER_SETTINGS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            Object.assign(userSettings, loaded.settings || {});
            console.log('Loaded user settings from file');
        }
    } catch (error) {
        console.error('Error loading user settings:', error);
    }
};

// Trim conversation history to prevent unbounded memory growth
const trimConversation = (conversation) => {
    if (conversation.length > MAX_CONVERSATION_LENGTH) {
        // Keep the most recent messages
        return conversation.slice(-MAX_CONVERSATION_LENGTH);
    }
    return conversation;
};

// Load persisted data on startup
loadConversations();
loadUserSettings();

// Helper functions
const processImages = async (attachments, userId, guildId, input, authorUsername, guildName, channelName) => {
    let imageDescriptions = [];

    // Get appropriate conversation history
    const conversationHistory = guildId ? 
        (guildConversations[guildId] || []) : 
        (userConversations[userId] || []);

    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB limit

    for (const [, attachment] of attachments) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            // Check image size before downloading
            if (attachment.size && attachment.size > MAX_IMAGE_SIZE) {
                console.warn(`Image too large: ${attachment.size} bytes (max: ${MAX_IMAGE_SIZE})`);
                continue;
            }

            const imageResponse = await fetch(attachment.url);

            // Double-check content-length header
            const contentLength = parseInt(imageResponse.headers.get('content-length') || '0', 10);
            if (contentLength > MAX_IMAGE_SIZE) {
                console.warn(`Image content-length too large: ${contentLength} bytes`);
                continue;
            }

            const imageBuffer = await imageResponse.buffer();

            // Final size check after download
            if (imageBuffer.length > MAX_IMAGE_SIZE) {
                console.warn(`Downloaded image too large: ${imageBuffer.length} bytes`);
                continue;
            }

            const base64Image = imageBuffer.toString('base64');

            const imageContent = {
                type: "image",
                source: {
                    type: "base64",
                    media_type: attachment.contentType,
                    data: base64Image
                }
            };

            // If there's no input text and we just want to describe the image,
            // use the simplified approach
            if (!input || input.trim() === '') {
                const openaiMessages = [
                    { role: 'system', content: `${config.systemMessage(authorUsername, userId, guildId, guildName, channelName)} Describe the image concisely and answer the user's question if provided.` },
                    ...conversationHistory.map(toOpenAIMessage),
                    toOpenAIMessage({
                        role: 'user',
                        content: [
                            imageContent,
                            { type: 'text', text: input || "What's in this image?" }
                        ]
                    })
                ];
                const imageAI = await callChat({
                    model: SMALLER_MODEL,
                    max_tokens: NORMAL_MAX_TOKENS,
                    messages: openaiMessages
                });

                const imageDescription = imageAI.choices?.[0]?.message?.content || '';
                imageDescriptions.push(imageDescription);

                // Add image description to the appropriate conversation history
                if (guildId) {
                    if (!guildConversations[guildId]) {
                        guildConversations[guildId] = [];
                    }
                    guildConversations[guildId].push({
                        role: "user",
                        content: [{ type: "text", text: `[Image] ${input}` }]
                    });
                    guildConversations[guildId].push({
                        role: "assistant",
                        content: imageDescription
                    });
                } else {
                    if (!userConversations[userId]) {
                        userConversations[userId] = [];
                    }
                    userConversations[userId].push({
                        role: "user",
                        content: [{ type: "text", text: `[Image] ${input}` }]
                    });
                    userConversations[userId].push({
                        role: "assistant",
                        content: imageDescription
                    });
                }
            } else {
                // If there's text input with the image, just return the image content
                // to be processed with tools if needed
                return { imageContent, base64Image, contentType: attachment.contentType };
            }
        }
    }

    return imageDescriptions.join('\n\n');
};

const splitMessage = (content) => {
    if (content.length <= MAX_MESSAGE_LENGTH) {
        return [content];
    }

    const parts = [];
    let currentPart = '';

    const pushCurrent = () => {
        if (currentPart.length > 0) {
            parts.push(currentPart);
            currentPart = '';
        }
    };

    content.split('\n').forEach((line) => {
        // Hard-split a single line that can't fit in one message on its own
        while (line.length > MAX_MESSAGE_LENGTH) {
            pushCurrent();
            parts.push(line.slice(0, MAX_MESSAGE_LENGTH));
            line = line.slice(MAX_MESSAGE_LENGTH);
        }
        const separator = currentPart.length > 0 ? '\n' : '';
        if (currentPart.length + separator.length + line.length > MAX_MESSAGE_LENGTH) {
            pushCurrent();
            currentPart = line;
        } else {
            currentPart += separator + line;
        }
    });

    pushCurrent();

    return parts;
};

// Define slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('thinking_process')
        .setDescription('Toggle whether to show the detailed thinking process.')
        .addStringOption(option =>
            option.setName('mode')
                .setDescription('Show or hide the thinking process')
                .setRequired(true)
                .addChoices(
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                )),
    new SlashCommandBuilder()
        .setName('thinking_budget')
        .setDescription('Set the thinking budget (tokens for non-OpenAI) or effort (OpenAI)')
        .addIntegerOption(option =>
            option.setName('tokens')
                .setDescription('Number of tokens for thinking (min 1024) - non-OpenAI only')
                .setRequired(false)
                .setMinValue(MIN_THINKING_BUDGET))
        .addStringOption(option =>
            option.setName('effort')
                .setDescription('Effort level (low, medium, high) - OpenAI only')
                .setRequired(false)
                .addChoices(
                    { name: 'low', value: 'low' },
                    { name: 'medium', value: 'medium' },
                    { name: 'high', value: 'high' }
                )
        ),
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset the conversation history'),
    new SlashCommandBuilder()
        .setName('reset_tokens')
        .setDescription('Reset token tracking statistics'),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Display current bot configuration and status'),
    new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('Manage scheduled tasks (timers and cron jobs)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new scheduled task')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('Task type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Timer (one-shot)', value: 'timer' },
                            { name: 'Cron (recurring)', value: 'cron' }
                        ))
                .addStringOption(option =>
                    option.setName('schedule')
                        .setDescription('Timer: "1 minute", "2 hours". Cron: "0 8 * * *" (8 AM daily)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('What to do when triggered')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Send message', value: 'preset' },
                            { name: 'AI response', value: 'ai' }
                        ))
                .addStringOption(option =>
                    option.setName('content')
                        .setDescription('Message to send (for "Send message" action)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('prompt')
                        .setDescription('Prompt for AI (for "AI response" action)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Optional name for the task')
                        .setRequired(false))
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel to send message (defaults to current)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all your scheduled tasks'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a scheduled task')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Task ID to delete')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('toggle')
                .setDescription('Enable or disable a scheduled task')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Task ID to toggle')
                        .setRequired(true)))
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Main message handler
client.on('messageCreate', async function(message) {
    try {
        // If it's a bot message or @everyone/@here, ignore it
        if (message.author.bot || message.content.includes('@everyone') || message.content.includes('@here')) return;

        // Allow both DMs and mentions in servers
        if (message.channel.type !== 1 && !message.mentions.has(client.user)) return;

        message.channel.sendTyping();

        // Process input content and handle message references (replies)
        let input = message.content
            .replace(`<@${client.user.id}>`, '')
            .replace(/<@&\d+>/g, '')
            .trim();

        // Check if the message is a reply to another message
        let replyContext = '';
        let replyAttachments = [];
        if (message.reference && message.reference.messageId) {
            try {
                const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                const repliedAuthor = repliedMessage.author.bot ? 
                    (repliedMessage.author.id === client.user.id ? 'You (Ai-chan)' : 'Another bot') : 
                    repliedMessage.author.username;
                
                // Get attachment information
                let attachmentInfo = '';
                if (repliedMessage.attachments.size > 0) {
                    replyAttachments = Array.from(repliedMessage.attachments.values());
                    const attachmentTypes = replyAttachments.map(attachment => {
                        if (attachment.contentType.startsWith('image/')) return 'image';
                        if (attachment.contentType.startsWith('video/')) return 'video';
                        if (attachment.contentType.startsWith('audio/')) return 'audio';
                        return 'file';
                    });
                    attachmentInfo = ` [with ${attachmentTypes.join(', ')}]`;
                }
                
                let messageContent = repliedMessage.content.trim();
                if (!messageContent && attachmentInfo) {
                    messageContent = "[Media content]";
                }
                
                replyContext = `[In reply to ${repliedAuthor}${attachmentInfo}: "${messageContent}"] `;
                console.log(`Reply context: ${replyContext}`);
            } catch (error) {
                console.error("Error fetching replied message:", error);
            }
        }

        // Combine reply context with user input AFTER command extraction
        let fullInput = input;
        if (replyContext) {
            fullInput = `${replyContext}${input}`;
        }

        const isDM = message.channel.type === 1;
        const guildId = isDM ? null : message.guild.id;

        // Handle reset command
        if (input.toLowerCase() === 'reset') {
            if (isDM) {
                if (userConversations[message.author.id]) {
                    userConversations[message.author.id] = [];
                }
                await message.reply("Ai-chan's personal conversations with you have been reset.");
            } else {
                if (guildConversations[guildId]) {
                    guildConversations[guildId] = [];
                }
                await message.reply("Ai-chan's server conversations have been reset.");
            }
            return;
        }

        const userId = message.author.id;

        // Initialize user settings if they don't exist
        if (!userSettings[userId]) {
            userSettings[userId] = {
                showThinkingProcess: false,
                thinkingBudget: DEFAULT_THINKING_BUDGET,
                thinkingBudgetEffort: 'medium'
            };
        }

        // Advisor strategy: always use smaller model as executor.
        // When the executor encounters a complex question, it can invoke the
        // ask_advisor tool which calls the bigger model for concise guidance (~600 tokens).
        // This is more cost-efficient than always routing complex queries to the bigger model.
        const selectedModel = SMALLER_MODEL;

        // Modify the input to include username for guild messages
        const processedInput = isDM ? 
            fullInput : 
            `[${message.author.username}]: ${fullInput}`;

        // Initialize conversations if they don't exist
        if (isDM) {
            if (!userConversations[message.author.id]) {
                userConversations[message.author.id] = [];
            }
        } else {
            if (!guildConversations[guildId]) {
                guildConversations[guildId] = [];
            }
        }

        let imageData = null;
        let imageDescriptions = '';
        
        // Check for attachments in current message OR replied message
        const hasCurrentAttachments = message.attachments.size > 0;
        const hasReplyAttachments = replyAttachments.length > 0;
        
        if (hasCurrentAttachments || hasReplyAttachments) {
            try {
                let attachmentsToProcess = null;
                
                if (hasCurrentAttachments) {
                    // Process current message attachments
                    attachmentsToProcess = message.attachments;
                } else if (hasReplyAttachments) {
                    // Process replied message attachments
                    // Convert array to Map-like structure that processImages expects
                    attachmentsToProcess = new Map();
                    replyAttachments.forEach((attachment, index) => {
                        attachmentsToProcess.set(index, attachment);
                    });
                }
                
                const result = await processImages(attachmentsToProcess, message.author.id, guildId, fullInput, message.author.username, message.guild?.name, message.channel?.name);
                
                // Check if we received image content or descriptions
                if (typeof result === 'object' && result.imageContent) {
                    // We have image content to pass directly to the model with the query
                    imageData = result;
                    console.log("Image prepared for direct processing with model");
                } else {
                    // We have image descriptions (for the simple case without tool use)
                    imageDescriptions = result;
                    console.log(`Images processed. Descriptions: ${imageDescriptions}`);
                    
                    // If there are only image attachments and no text, send the image descriptions and return
                    if (!fullInput && imageDescriptions) {
                        const messageParts = splitMessage(imageDescriptions);
                        for (let i = 0; i < messageParts.length; i++) {
                            if (i === 0) {
                                await message.reply({
                                    content: messageParts[i],
                                    allowedMentions: { repliedUser: true },
                                });
                            } else {
                                await message.channel.send(messageParts[i]);
                            }
                        }
                        
                        // Update conversation history already happened in processImages
                        return;
                    }
                }
            } catch (error) {
                console.error("Error processing images:", error);
                await message.reply("Sorry, there was an error processing the images.");
                return;
            }
        }

        // Get the appropriate conversation history
        const conversationHistory = isDM ? 
            userConversations[message.author.id] : 
            guildConversations[guildId];
        
        // Reasoning policy for the executor (SMALLER_MODEL):
        // - Enable reasoning if the model supports it AND MODEL_SMALLER_THINKING is set
        // - Extended thinking max tokens only used when reasoning is enabled
        const showThinkingProcess = userSettings[userId].showThinkingProcess;
        const thinkingBudget = userSettings[userId].thinkingBudget;
        const clampedThinkingBudget = Math.max(MIN_THINKING_BUDGET, Math.min(thinkingBudget || DEFAULT_THINKING_BUDGET, 32000));
        const isOpenAIProvider = typeof selectedModel === 'string' && selectedModel.startsWith('openai/');

        // Check reasoning support BEFORE building system message
        const isReasoningModel = await modelSupportsReasoning(selectedModel);
        const reasoningStyle = await getReasoningStyle(selectedModel);
        console.log('[Reasoning][ModelStyle]', { model: selectedModel, reasoningStyle, isReasoningModel });

        // Enable reasoning on the executor only when MODEL_SMALLER_THINKING is configured
        let enableReasoning = isReasoningModel && MODEL_SMALLER_THINKING;
        
        // Create messages array with conversation history
        let messages = [...conversationHistory];
        
        // Add the current user message, including the image content if available
        if (imageData) {
            // If we have an image, create a multipart message with image and text
            messages.push({
                role: "user",
                content: [
                    imageData.imageContent,
                    {
                        type: "text",
                        text: processedInput
                    }
                ]
            });
        } else {
            // Regular text message
            messages.push({ role: "user", content: processedInput });
            
            // Only add image descriptions to messages array if we haven't already processed them
            // This prevents the duplicate image descriptions in the API call
            if (imageDescriptions && fullInput.trim()) {
                // Only add the image context if we have an actual text query with the image
                messages.push({ role: "assistant", content: imageDescriptions });
            }
        }
        
        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

        try {
            // Prepare OpenAI-compatible messages and tools
            const openaiMessagesBase = [
                { role: 'system', content: config.systemMessage(message.author.username, userId, guildId, message.guild?.name, message.channel?.name) },
                ...messages.map(toOpenAIMessage)
            ];
            const toolsSupported = await modelSupportsTools(selectedModel);
            console.log('[Tools][Support]', { model: selectedModel, toolsSupported });
            const openaiTools = toolsSupported ? toOpenAITools(TOOL_SCHEMAS) : undefined;

            // Helper to extract reasoning text from a message (supports message.reasoning and reasoning_details)
            const extractReasoningText = (msg) => {
                try {
                    if (!msg || typeof msg !== 'object') return '';
                    if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
                        return msg.reasoning.trim();
                    }
                    const details = Array.isArray(msg.reasoning_details) ? msg.reasoning_details : [];
                    const parts = [];
                    let hasEncrypted = false;
                    for (const item of details) {
                        if (item && typeof item === 'object') {
                            if (typeof item.text === 'string' && item.text.trim()) parts.push(item.text.trim());
                            else if (typeof item.summary === 'string' && item.summary.trim()) parts.push(item.summary.trim());
                            else if (item.type === 'reasoning.encrypted') hasEncrypted = true;
                        }
                    }
                    if (hasEncrypted && parts.length === 0) {
                        console.log('[Reasoning][Encrypted] Encrypted reasoning detected but cannot be extracted');
                    }
                    return parts.join('\n');
                } catch (_) { return ''; }
            };

            // Accumulate reasoning across responses (initial and follow-ups)
            const collectedReasoning = [];
            // Accumulate advisor responses to show in thinking process
            const collectedAdvisorAdvice = [];

            const computeReasoningParams = (enableReasoning, reasoningStyle, clampedThinkingBudget, showThinkingProcess, isReasoningModel, userId) => {
                const baseMaxTokens = NORMAL_MAX_TOKENS;
                const requiredForContent = 2048;
                let computedMaxTokens = baseMaxTokens;
                let mappedEffort = null;
                let allocatedBudget = null;
                let reasoningConfig;

                if (enableReasoning) {
                    if (reasoningStyle === 'effort') {
                        mappedEffort = userSettings[userId]?.thinkingBudgetEffort || 'medium';
                        reasoningConfig = { effort: mappedEffort, exclude: !showThinkingProcess, enabled: true };
                    } else if (reasoningStyle === 'max_tokens') {
                        allocatedBudget = clampedThinkingBudget;
                        reasoningConfig = { max_tokens: allocatedBudget, exclude: !showThinkingProcess, enabled: true };
                        const minNeeded = allocatedBudget + requiredForContent;
                        computedMaxTokens = Math.max(baseMaxTokens, Math.min(EXTENDED_THINKING_MAX_TOKENS, minNeeded));
                    } else if (reasoningStyle === 'enabled') {
                        reasoningConfig = { enabled: true, exclude: !showThinkingProcess };
                    }
                } else if (isReasoningModel) {
                    if (reasoningStyle === 'effort') {
                        reasoningConfig = { effort: 'none' };
                    } else if (reasoningStyle === 'enabled') {
                        reasoningConfig = { enabled: false };
                    }
                }

                return { computedMaxTokens, mappedEffort, allocatedBudget, reasoningConfig };
            };

            // Send a "Thinking..." message while the model is generating
            let thinkingMessage = null;
            const startTime = Date.now();
            thinkingMessage = await message.reply("Thinking...");
            
            // Make the first API request
            let openaiMessages = [...openaiMessagesBase];
            
            // Reasoning details preservation for multi-turn tool calling
            // When using multi-turn tool calling, any reasoning details from previous turns must be preserved
            // and passed back to the model in the assistant message.
            // See: https://openrouter.ai/docs/use-cases/reasoning-tokens#preserving-reasoning-blocks

            // Compute reasoning config using helper
            const { computedMaxTokens, mappedEffort, allocatedBudget, reasoningConfig } = computeReasoningParams(
                enableReasoning, reasoningStyle, clampedThinkingBudget,
                showThinkingProcess, isReasoningModel, userId
            );

            // Per-request aggregates across all API calls in this request (initial + follow-ups)
            let accumulatedReasoningTokens = 0;
            let requestInputTokens = 0;
            let requestOutputTokens = 0;
            let requestCacheCreationInputTokens = 0;
            let advisorInputTokens = 0;
            let advisorOutputTokens = 0;
            let requestCacheReadInputTokens = 0;

            const applyUsageFromResponse = (usage) => {
                if (!usage) return;
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                const reasoningTokens = usage.reasoning_tokens || 0;
                const cacheCreation = usage.cache_creation_input_tokens || 0;
                const cacheRead = usage.cache_read_input_tokens || 0;

                // Aggregate for this request
                requestInputTokens += inputTokens;
                requestOutputTokens += outputTokens;
                accumulatedReasoningTokens += reasoningTokens;
                requestCacheCreationInputTokens += cacheCreation;
                requestCacheReadInputTokens += cacheRead;

                // Track standard input/output tokens for the selected model (lifetime)
                if (!tokenTracking.modelUsage[selectedModel]) {
                    tokenTracking.modelUsage[selectedModel] = { input: 0, output: 0 };
                }
                // Ensure costs are saved for new models
                if (!tokenTracking.modelCosts[selectedModel]) {
                    const fallbackCosts = MODEL_COSTS[selectedModel] || { input: 0, output: 0 };
                    tokenTracking.modelCosts[selectedModel] = { ...fallbackCosts };
                }
                tokenTracking.modelUsage[selectedModel].input += inputTokens;
                tokenTracking.modelUsage[selectedModel].output += outputTokens;

                // Track cache usage if available (lifetime)
                if (cacheCreation) {
                    tokenTracking.lifetimeCacheCreationInputTokens += cacheCreation;
                    tokenTracking.cacheMisses++;
                }
                if (cacheRead) {
                    tokenTracking.lifetimeCacheReadInputTokens += cacheRead;
                    tokenTracking.cacheHits++;
                }
            };

            let response = await callChat({
                model: selectedModel,
                max_tokens: computedMaxTokens,
                messages: openaiMessages,
                tools: openaiTools,
                reasoning: reasoningConfig
            });
            applyUsageFromResponse(response?.usage);

            // Process any tool calls
            let assistantMessage = response.choices?.[0]?.message;
            // Check for reasoning_details presence (even if encrypted)
            const hasReasoningDetails = assistantMessage?.reasoning_details && Array.isArray(assistantMessage.reasoning_details) && assistantMessage.reasoning_details.length > 0;
            if (enableReasoning && hasReasoningDetails) {
                const reasoningTypes = assistantMessage.reasoning_details.map(item => item?.type).filter(Boolean);
                console.log('[Reasoning][Detected][Initial]', { count: assistantMessage.reasoning_details.length, types: reasoningTypes });
            }
            const initialReasoning = extractReasoningText(assistantMessage);
            if (initialReasoning) {
                collectedReasoning.push(initialReasoning);
                console.log('[Reasoning][Captured][Initial]', initialReasoning.slice(0, 200));
            }
            if (!assistantMessage?.content) {
                console.log('[Response][Warn] Empty content in assistantMessage (initial). Full message:', JSON.stringify(assistantMessage || null));
            }
            let toolCalls = toolsSupported ? (assistantMessage?.tool_calls || []) : [];
            // Cap tool-call round-trips to prevent an infinite loop if the model keeps
            // requesting tools (e.g. repeatedly retrying a failing tool). Generous limit
            // to allow legitimate multi-tool flows (multiple searches + scrape + up to 5
            // advisor calls).
            let toolIterations = 0;
            const MAX_TOOL_ITERATIONS = 10;
            while (toolCalls && toolCalls.length > 0 && toolIterations < MAX_TOOL_ITERATIONS) {
                toolIterations++;
                console.log("\nModel is requesting to use tools:");
                
                // Log the tool calls and send notifications
                for (const call of toolCalls) {
                    const toolName = call.function?.name;
                    const argsStr = call.function?.arguments || '{}';
                    console.log(`- Tool: ${toolName}`);
                    console.log(`  Input: ${argsStr}`);
                    
                    // Send a notification message for each tool use
                    let toolNotification = '';
                    let parsed = {};
                    try { parsed = JSON.parse(argsStr || '{}'); } catch (_) {}
                    if (toolName === 'web_search') {
                            toolNotification = `Using web search for: \`${parsed.query}\``;
                        } else if (toolName === 'web_scrape') {
                            toolNotification = `Using web scraper for: \`${parsed.url}\``;
                        } else if (toolName === 'multi_scrape') {
                            toolNotification = `Using multi-page scraper for \`${(parsed.urls||[]).length}\` URLs`;
                        } else if (toolName === 'nitter_tweets') {
                            const username = (parsed.username || '').startsWith('@') ? parsed.username : `@${parsed.username||''}`;
                            toolNotification = `Using nitter tweets tool for: \`${username}\``;
                        } else if (toolName === 'tweet_url_scrape') {
                            toolNotification = `Using tweet URL scraper for: \`${parsed.url}\``;
                        } else if (toolName === 'note') {
                            const action = (parsed.action || '').toLowerCase();
                            const scope = parsed.scope || 'user';
                            const key = parsed.key ? ` key: \`${parsed.key}\`` : '';
                            const queryText = parsed.query ? ` query: \`${parsed.query}\`` : '';
                            // Compose concise action-specific message
                            if (action === 'save') {
                                toolNotification = `Using note tool [save] (${scope})${key}`;
                            } else if (action === 'get') {
                                toolNotification = `Using note tool [get] (${scope})${key}`;
                            } else if (action === 'list') {
                                toolNotification = `Using note tool [list] (${scope})`;
                            } else if (action === 'search') {
                                toolNotification = `Using note tool [search] (${scope})${queryText}`;
                            } else if (action === 'delete') {
                                toolNotification = `Using note tool [delete] (${scope})${key}`;
                            } else if (action === 'delete_all') {
                                toolNotification = `Using note tool [delete_all] (${scope})`;
                            } else {
                                toolNotification = `Using note tool (${scope})`;
                            }
                        } else if (toolName === 'ask_advisor') {
                            toolNotification = `> 🎓 Consulting my advisor for deeper analysis...`;
                        }

                    if (toolNotification) {
                        await message.channel.send(toolNotification);
                    }
                }

                // Execute the tool calls
                console.log("\nExecuting tool calls...");
                let toolResults = [];
                let toolFailures = [];

                // Separate advisor calls from regular tool calls
                const advisorCalls = toolCalls.filter(c => c.function?.name === 'ask_advisor');
                const regularCalls = toolCalls.filter(c => c.function?.name !== 'ask_advisor');

                // Execute regular tools
                if (regularCalls.length > 0) {
                    try {
                        const regularResults = await executeToolCalls(regularCalls.map(call => {
                            let args = {};
                            try {
                                args = JSON.parse(call.function?.arguments || '{}');
                            } catch (parseError) {
                                console.error(`Failed to parse tool arguments for ${call.function?.name}:`, parseError.message, 'Raw:', call.function?.arguments);
                            }

                            // Add context for note tool
                            if (call.function?.name === 'note') {
                                args.userId = message.author.id;
                                if (isDM) {
                                    args.guildId = null;
                                } else {
                                    args.guildId = guildId;
                                }
                            }

                            // Add context for schedule tool
                            if (call.function?.name === 'schedule') {
                                args.userId = message.author.id;
                                args.channelId = message.channel.id;
                                if (isDM) {
                                    args.guildId = null;
                                    args.hasManageGuild = false;
                                } else {
                                    args.guildId = guildId;
                                    // Check for Manage Server permission
                                    args.hasManageGuild = message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || false;
                                }
                            }

                            return ({
                                id: call.id,
                                name: call.function?.name,
                                input: args
                            });
                        }));
                        toolResults.push(...regularResults);

                        // Check for errors in regular tool results
                        for (const result of regularResults) {
                            const parsedOutput = JSON.parse(result.output);
                            if (parsedOutput.error) {
                                const toolCall = regularCalls.find(call => call.id === result.tool_call_id);
                                const errorMsg = `Error with ${toolCall ? (toolCall.function?.name) : 'unknown tool'}`;
                                toolFailures.push(errorMsg);
                                console.error(errorMsg);
                            }
                        }
                    } catch (error) {
                        console.error("Failed to execute regular tool calls:", error);
                        toolFailures.push(`Tool execution failed: ${error.message}`);
                    }
                }

                // Execute advisor calls (calls the bigger model for concise strategic guidance)
                for (const advisorCall of advisorCalls) {
                    let advisorArgs = {};
                    try {
                        advisorArgs = JSON.parse(advisorCall.function?.arguments || '{}');
                    } catch (_) {}

                    const advisorQuestion = advisorArgs.question || '';
                    const advisorContext = advisorArgs.context || '';

                    console.log('[Advisor] Consulting bigger model for guidance on:', advisorQuestion.slice(0, 120));

                    try {
                        const advisorMessages = [
                            {
                                role: 'system',
                                content: `You are a strategic advisor for Ai-chan, a Discord AI assistant. Your role is to analyze complex questions and provide concise, actionable guidance that Ai-chan can use to craft her response.\n\nProvide:\n1. Key insights or relevant facts about the topic\n2. A recommended approach for answering\n3. Any important caveats or nuances to keep in mind\n\nBe specific and strategic. Keep your response under 2000 tokens. You are NOT directly responding to the user — you are advising Ai-chan on how to respond.`
                            },
                            {
                                role: 'user',
                                content: advisorContext
                                    ? `Context: ${advisorContext}\n\nQuestion to analyze: ${advisorQuestion}`
                                    : `Question to analyze: ${advisorQuestion}`
                            }
                        ];

                        const advisorResponse = await callChat({
                            model: BIGGER_MODEL,
                            messages: advisorMessages,
                            max_tokens: 2000
                        });

                        // Track advisor token usage under BIGGER_MODEL
                        if (advisorResponse.usage) {
                            const advInput = advisorResponse.usage.prompt_tokens || 0;
                            const advOutput = advisorResponse.usage.completion_tokens || 0;
                            if (!tokenTracking.modelUsage[BIGGER_MODEL]) {
                                tokenTracking.modelUsage[BIGGER_MODEL] = { input: 0, output: 0 };
                            }
                            if (!tokenTracking.modelCosts[BIGGER_MODEL]) {
                                const fallbackCosts = MODEL_COSTS[BIGGER_MODEL] || { input: 0, output: 0 };
                                tokenTracking.modelCosts[BIGGER_MODEL] = { ...fallbackCosts };
                            }
                            tokenTracking.modelUsage[BIGGER_MODEL].input += advInput;
                            tokenTracking.modelUsage[BIGGER_MODEL].output += advOutput;
                            advisorInputTokens += advInput;
                            advisorOutputTokens += advOutput;
                            console.log(`[Advisor] Usage (${BIGGER_MODEL}): ${advInput} input, ${advOutput} output tokens.`);
                            saveTokenData();
                        }

                        const advisorAdvice = advisorResponse.choices?.[0]?.message?.content || 'No guidance provided.';
                        console.log('[Advisor] Guidance received:', advisorAdvice.slice(0, 200));
                        if (showThinkingProcess) collectedAdvisorAdvice.push(advisorAdvice);

                        toolResults.push({
                            tool_call_id: advisorCall.id,
                            output: JSON.stringify({ advice: advisorAdvice })
                        });
                    } catch (advisorError) {
                        console.error('[Advisor] Error calling advisor:', advisorError);
                        toolResults.push({
                            tool_call_id: advisorCall.id,
                            output: JSON.stringify({ error: 'Advisor unavailable.', advice: 'Proceed with your best judgment.' })
                        });
                        toolFailures.push('Advisor call failed — proceeding without guidance.');
                    }
                }
                
                // Send error messages to the user if any tools failed
                if (toolFailures.length > 0) {
                    for (const failure of toolFailures) {
                        await message.channel.send(`⚠️ ${failure}`);
                    }
                    
                    // If all tools failed and we have no results, add a default error result
                    if (toolResults.length === 0) {
                        toolResults = toolCalls.map(call => ({
                            tool_call_id: call.id,
                            output: JSON.stringify({
                                error: "Tool execution failed",
                                details: "The requested information could not be retrieved. This could be due to connectivity issues or the service being unavailable."
                            })
                        }));
                    }
                }

                // Add the assistant message with tool calls to the API message list
                // CRITICAL: Preserve reasoning_details if available to maintain context for reasoning models
                if (assistantMessage.reasoning_details) {
                    // Create a copy to avoid mutating the original response object if reused elsewhere
                    // We need to ensure we pass the complete message object including reasoning_details
                    const messageToPush = { ...assistantMessage };
                    openaiMessages.push(messageToPush);
                } else {
                    openaiMessages.push(assistantMessage);
                }

                // Add each tool result as a tool role message (include name per OpenRouter spec)
                for (const tr of toolResults) {
                    const matchedCall = toolCalls.find(c => c.id === tr.tool_call_id);
                    const toolName = matchedCall?.function?.name;
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: tr.tool_call_id,
                        name: toolName,
                        content: tr.output
                    });
                }

                // Get model's response with the tool results
                // Recompute reasoning params for follow-up request
                const followUpParams = computeReasoningParams(
                    enableReasoning, reasoningStyle, clampedThinkingBudget,
                    showThinkingProcess, isReasoningModel, userId
                );

                response = await callChat({
                    model: selectedModel,
                    max_tokens: followUpParams.computedMaxTokens,
                    messages: openaiMessages,
                    tools: openaiTools,
                    reasoning: followUpParams.reasoningConfig
                });
                applyUsageFromResponse(response?.usage);

                assistantMessage = response.choices?.[0]?.message;
                // Check for reasoning_details presence (even if encrypted)
                const hasReasoningDetails2 = assistantMessage?.reasoning_details && Array.isArray(assistantMessage.reasoning_details) && assistantMessage.reasoning_details.length > 0;
                if (enableReasoning && hasReasoningDetails2) {
                    const reasoningTypes2 = assistantMessage.reasoning_details.map(item => item?.type).filter(Boolean);
                    console.log('[Reasoning][Detected][FollowUp]', { count: assistantMessage.reasoning_details.length, types: reasoningTypes2 });
                }
                const followReasoning = extractReasoningText(assistantMessage);
                if (followReasoning) {
                    collectedReasoning.push(followReasoning);
                    console.log('[Reasoning][Captured][FollowUp]', followReasoning.slice(0, 200));
                }
                if (!assistantMessage?.content) {
                    console.log('[Response][Warn] Empty content in assistantMessage (follow-up). Full message:', JSON.stringify(assistantMessage || null));
                }
                toolCalls = toolsSupported ? (assistantMessage?.tool_calls || []) : [];
            }
            
            // Track token usage (aggregated across all calls in this request)
            const thinkingTokenCount = accumulatedReasoningTokens || 0; // not always provided reliably
            if (thinkingTokenCount > 0) {
                tokenTracking.lifetimeThinkingTokens = (tokenTracking.lifetimeThinkingTokens || 0) + thinkingTokenCount;
            }

            // Calculate costs for this specific request using aggregated counts
            const modelCosts = getCostForModel(selectedModel);
            const inputCost = (requestInputTokens / 1000000) * modelCosts.input;
            const outputCost = (requestOutputTokens / 1000000) * modelCosts.output;
            const advisorCosts = getCostForModel(BIGGER_MODEL);
            const advisorInputCost = (advisorInputTokens / 1000000) * advisorCosts.input;
            const advisorOutputCost = (advisorOutputTokens / 1000000) * advisorCosts.output;
            const totalCost = inputCost + outputCost + advisorInputCost + advisorOutputCost;

            // Cache info summary for this request
            let cacheInfo = '';
            if (requestCacheCreationInputTokens) {
                cacheInfo += `, Cache: MISS (${requestCacheCreationInputTokens} tokens)`;
            }
            if (requestCacheReadInputTokens) {
                cacheInfo += `, Cache: HIT (${requestCacheReadInputTokens} tokens)`;
            }

            console.log(`Token usage for ${selectedModel} (aggregated) - Input: ${requestInputTokens}, Output: ${requestOutputTokens}${cacheInfo}`);
            if (thinkingTokenCount > 0) {
                console.log(`Thinking tokens: ${thinkingTokenCount} (included in input tokens)`);
            }
            const advisorCostNote = (advisorInputTokens > 0)
                ? ` + advisor $${(advisorInputCost + advisorOutputCost).toFixed(6)} (${advisorInputTokens}in/${advisorOutputTokens}out)`
                : '';
            console.log(`Cost of this request: $${totalCost.toFixed(6)} ($${inputCost.toFixed(6)} for input, $${outputCost.toFixed(6)} for output${advisorCostNote})`);

            const totalLifetimeInput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.input, 0);
            const totalLifetimeOutput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.output, 0);
            console.log(`Total lifetime tokens: ${totalLifetimeInput.toLocaleString()} input, ${totalLifetimeOutput.toLocaleString()} output`);
            console.log(`Total lifetime thinking tokens: ${(tokenTracking.lifetimeThinkingTokens || 0).toLocaleString()}`);
            console.log(`Total lifetime tool use tokens: ${(tokenTracking.lifetimeToolUseTokens || 0).toLocaleString()}`);

            // Save token data after updates
            saveTokenData();
            
            // Calculate thinking time if extended thinking was enabled
            if (thinkingMessage) {
                const endTime = Date.now();
                const thinkingTime = endTime - startTime;
                const thinkingTimeInSeconds = (thinkingTime / 1000).toFixed(3);
                await thinkingMessage.edit(`Done! Thinking completed in ${thinkingTimeInSeconds}s`);
            }

            // Prepare final response text
            let finalResponse = assistantMessage?.content || '';
            const advisorSection = (showThinkingProcess && collectedAdvisorAdvice.length > 0)
                ? '\n\n## 🎓 Advisor Guidance\n' + collectedAdvisorAdvice.join('\n\n---\n\n')
                : '';
            const reasoningText = (showThinkingProcess && (collectedReasoning.length > 0 || advisorSection))
                ? collectedReasoning.join('\n\n') + advisorSection
                : '';
            if ((!finalResponse || finalResponse.trim() === '') && imageDescriptions) {
                finalResponse = imageDescriptions;
            }
            if (!finalResponse || finalResponse.trim() === '') {
                console.log('[Response][Warn] Final response content empty. Falling back to default error. assistantMessage:', typeof assistantMessage === 'object' ? JSON.stringify({
                    hasContent: !!assistantMessage?.content,
                    hasReasoning: !!assistantMessage?.reasoning,
                    hasToolCalls: Array.isArray(assistantMessage?.tool_calls) && assistantMessage.tool_calls.length > 0
                }) : assistantMessage);
                finalResponse = 'I encountered an issue processing your request. Please try again.';
            }

            // Send reasoning as a separate spoiler message first (if available)
            if (reasoningText && reasoningText.trim().length > 0) {
                const header = '🧠 Reasoning\n';
                const fullReasoning = `${header}${reasoningText}`;
                const baseParts = splitMessage(fullReasoning);
                const maxPerMsg = MAX_MESSAGE_LENGTH - 4; // account for || ||
                for (const base of baseParts) {
                    if ((base.length + 4) <= MAX_MESSAGE_LENGTH) {
                        await message.channel.send(`||${base}||`);
                    } else {
                        // Further split oversized part
                        for (let start = 0; start < base.length; start += maxPerMsg) {
                            const chunk = base.slice(start, start + maxPerMsg);
                            await message.channel.send(`||${chunk}||`);
                        }
                    }
                }
            }

            // Send the final response
            const messageParts = splitMessage(finalResponse);
            for (let i = 0; i < messageParts.length; i++) {
                if (message.channel.type === 1) {
                    await message.channel.send(messageParts[i]);
                } else {
                    if (i === 0 && !thinkingMessage) {
                        await message.reply({
                            content: messageParts[i],
                            allowedMentions: { repliedUser: true },
                        });
                    } else {
                        await message.channel.send(messageParts[i]);
                    }
                }
            }

            // Update the appropriate conversation history
            const conversation = isDM
                ? userConversations[message.author.id]
                : guildConversations[guildId];
            const userInput = isDM ? fullInput : processedInput;
            const imageLabel = imageData
                ? (isDM ? `[Image with query: ${fullInput}]` : `[${message.author.username}]: [Image with query: ${fullInput}]`)
                : null;

            if (conversation.length === 0 || conversation[conversation.length - 1].role !== "user") {
                if (imageData) {
                    conversation.push({
                        role: "user",
                        content: imageLabel
                    });
                } else {
                    conversation.push({ role: "user", content: userInput });
                }
            }
            conversation.push({
                role: "assistant",
                content: finalResponse
            });
            if (isDM) {
                userConversations[message.author.id] = trimConversation(conversation);
            } else {
                guildConversations[guildId] = trimConversation(conversation);
            }
            saveConversations();
        } catch (error) {
            console.error("API Error:", error);
            await message.reply(`There was an error processing your request.`);
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

// Function to reset token statistics
const resetTokenStats = () => {
    tokenTracking = {
        modelUsage: {
            [BIGGER_MODEL]: { input: 0, output: 0 },
            [SMALLER_MODEL]: { input: 0, output: 0 }
        },
        modelCosts: {},
        lifetimeCacheCreationInputTokens: 0,
        lifetimeCacheReadInputTokens: 0,
        lifetimeThinkingTokens: 0,
        lifetimeToolUseTokens: 0,
        cacheHits: 0,
        cacheMisses: 0,
        trackingSince: new Date().toISOString()
    };
    saveTokenData();
};

// Function to format tracking date in a human-readable format
const formatTrackingDate = (isoString) => {
    const date = new Date(isoString);
    return `${date.toLocaleDateString('en-US', DATE_OPTIONS)} ${date.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`;
};

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    const { commandName, options, user } = interaction;
    
    // Initialize user settings if they don't exist
        if (!userSettings[user.id]) {
        userSettings[user.id] = {
            showThinkingProcess: false,
                thinkingBudget: DEFAULT_THINKING_BUDGET,
                thinkingBudgetEffort: 'medium',
        };
    }
    
    try {
        if (commandName === 'thinking_process') {
            const mode = options.getString('mode');
            userSettings[user.id].showThinkingProcess = mode === 'on';
            saveUserSettings();
            await interaction.reply({
                content: `Showing thinking process is now ${mode === 'on' ? 'ON' : 'OFF'}.`,
                ephemeral: true
            });
        } else if (commandName === 'thinking_budget') {
            // Accept either numeric token budget or effort string (low|medium|high)
            const raw = options.getInteger('tokens');
            const textEffort = options.getString('effort');
            let replyText = '';

            // Determine selected model context (approx): default to SMALLER_MODEL for display purposes
            const isOpenAI = (SMALLER_MODEL.startsWith('openai/') || BIGGER_MODEL.startsWith('openai/'));

            if (isOpenAI && textEffort) {
                const effort = (textEffort || '').toLowerCase();
                if (!['low','medium','high'].includes(effort)) {
                    await interaction.reply({ content: 'For OpenAI models, use one of: low, medium, high.', ephemeral: true });
                    return;
                }
                userSettings[user.id].thinkingBudgetEffort = effort;
                saveUserSettings();
                replyText = `Set effort default to: ${effort}.`;
            } else if (!isOpenAI && typeof raw === 'number') {
                if (raw < MIN_THINKING_BUDGET) {
                    await interaction.reply({ content: `Thinking budget must be at least ${MIN_THINKING_BUDGET} tokens.`, ephemeral: true });
                    return;
                }
                userSettings[user.id].thinkingBudget = Math.min(raw, 32000);
                saveUserSettings();
                replyText = `Thinking budget set to ${userSettings[user.id].thinkingBudget} tokens.`;
            } else {
                // Fallback
                replyText = isOpenAI
                    ? 'For OpenAI models, pass low|medium|high.'
                    : `For budget models, pass a number (>= ${MIN_THINKING_BUDGET}).`;
            }

            await interaction.reply({ content: replyText, ephemeral: true });
        } else if (commandName === 'reset') {
            const isDM = interaction.channel.type === 1;
            const guildId = isDM ? null : interaction.guild.id;
            
            if (isDM) {
                userConversations[user.id] = [];
                saveConversations();
                await interaction.reply({
                    content: "Ai-chan's personal conversations with you have been reset.",
                    ephemeral: true
                });
            } else {
                guildConversations[guildId] = [];
                saveConversations();
                await interaction.reply({
                    content: "Ai-chan's server conversations have been reset.",
                    ephemeral: true
                });
            }
        } else if (commandName === 'reset_tokens') {
            // Only allow the bot creator to reset tokens
            if (!isBotCreator(user.id)) {
                await interaction.reply({
                    content: "Only the bot creator can reset token statistics.",
                    ephemeral: true
                });
                return;
            }
            
            const totalLifetimeInput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.input, 0);
            const totalLifetimeOutput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.output, 0);
            console.log(`Token statistics reset by ${user.username} (${user.id}). Previous data: ${totalLifetimeInput.toLocaleString()} input tokens, ${totalLifetimeOutput.toLocaleString()} output tokens since ${formatTrackingDate(tokenTracking.trackingSince)}`);
            
            resetTokenStats();
            await interaction.reply({
                content: "Token tracking statistics have been reset to zero.",
                ephemeral: true
            });
        } else if (commandName === 'schedule') {
            const subcommand = options.getSubcommand();
            const isDM = interaction.channel.type === 1;
            const guildId = isDM ? null : interaction.guild.id;
            const scope = isDM ? 'user' : 'guild';
            const scopeId = isDM ? user.id : guildId;

            // Check permission for guild schedules
            if (!isDM && subcommand !== 'list') {
                const member = interaction.member;
                if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({
                        content: "You need 'Manage Server' permission to manage guild schedules.",
                        ephemeral: true
                    });
                    return;
                }
            }

            if (subcommand === 'create') {
                const taskType = options.getString('type');
                const scheduleExpr = options.getString('schedule');
                const actionType = options.getString('action');
                const content = options.getString('content');
                const prompt = options.getString('prompt');
                const taskName = options.getString('name');
                const targetChannel = options.getChannel('channel') || interaction.channel;

                // Validate action type requirements
                if (actionType === 'preset' && !content) {
                    await interaction.reply({
                        content: "Content is required for 'Send message' action type.",
                        ephemeral: true
                    });
                    return;
                }
                if (actionType === 'ai' && !prompt) {
                    await interaction.reply({
                        content: "Prompt is required for 'AI response' action type.",
                        ephemeral: true
                    });
                    return;
                }

                const result = scheduler.createSchedule(scope, scopeId, {
                    taskType,
                    name: taskName,
                    schedule: scheduleExpr,
                    duration: scheduleExpr,
                    actionType,
                    content,
                    prompt,
                    channelId: targetChannel.id,
                    createdBy: user.id
                });

                if (result.error) {
                    await interaction.reply({
                        content: `Failed to create schedule: ${result.error}`,
                        ephemeral: true
                    });
                } else {
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle(`${taskType === 'timer' ? 'Timer' : 'Cron Job'} Created`)
                        .addFields(
                            { name: 'Name', value: result.task.name, inline: true },
                            { name: 'Type', value: result.task.taskType, inline: true },
                            { name: 'Schedule', value: result.task.scheduleDescription, inline: true },
                            { name: 'Action', value: result.task.actionType === 'preset' ? 'Send message' : 'AI response', inline: true },
                            { name: 'Channel', value: `<#${targetChannel.id}>`, inline: true },
                            { name: 'ID', value: `\`${result.task.id}\``, inline: false }
                        )
                        .setTimestamp();

                    await interaction.reply({
                        embeds: [embed],
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'list') {
                const schedules = scheduler.getSchedules(scope, scopeId);

                if (schedules.length === 0) {
                    await interaction.reply({
                        content: `No ${scope} schedules found.`,
                        ephemeral: true
                    });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0x00AAFF)
                    .setTitle(`${scope === 'user' ? 'Your' : 'Server'} Schedules`)
                    .setDescription(`${schedules.length} schedule(s) found`)
                    .setTimestamp();

                for (const task of schedules.slice(0, 10)) { // Limit to 10 for display
                    const status = task.enabled ? '🟢' : '🔴';
                    const typeIcon = task.taskType === 'timer' ? '⏱️' : '🔄';
                    embed.addFields({
                        name: `${status} ${typeIcon} ${task.name}`,
                        value: `**ID:** \`${task.id}\`\n**Schedule:** ${task.scheduleDescription}\n**Action:** ${task.actionType}\n**Runs:** ${task.runCount}${task.lastRun ? `\n**Last run:** <t:${Math.floor(new Date(task.lastRun).getTime() / 1000)}:R>` : ''}`,
                        inline: false
                    });
                }

                if (schedules.length > 10) {
                    embed.setFooter({ text: `Showing 10 of ${schedules.length} schedules` });
                }

                await interaction.reply({
                    embeds: [embed],
                    ephemeral: true
                });
            } else if (subcommand === 'delete') {
                const taskId = options.getString('id');
                const result = scheduler.deleteSchedule(scope, scopeId, taskId);

                if (result.error) {
                    await interaction.reply({
                        content: `Failed to delete: ${result.error}`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `Schedule "${result.deletedTask.name}" has been deleted.`,
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'toggle') {
                const taskId = options.getString('id');
                const result = scheduler.toggleSchedule(scope, scopeId, taskId);

                if (result.error) {
                    await interaction.reply({
                        content: `Failed to toggle: ${result.error}`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `Schedule "${result.task.name}" is now ${result.enabled ? 'enabled 🟢' : 'disabled 🔴'}.`,
                        ephemeral: true
                    });
                }
            }
        } else if (commandName === 'status') {
            // Calculate costs
            const costs = calculateCosts();
            
            // Calculate average token usage per message
            const totalMessages = 
                Math.max(1, Object.values(userConversations).reduce((sum, conv) => sum + Math.floor(conv.length / 2), 0) + 
               Object.values(guildConversations).reduce((sum, conv) => sum + Math.floor(conv.length / 2), 0));
                       
            const totalLifetimeInput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.input, 0);
            const totalLifetimeOutput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.output, 0);
            
            const avgInputTokens = (totalLifetimeInput / totalMessages).toFixed(0);
            const avgOutputTokens = (totalLifetimeOutput / totalMessages).toFixed(0);
            
            // Check if the user is the bot creator to show more detailed info
            const isBotOwner = isBotCreator(user.id);
            
            // Create an embed with the bot's status information
            const statusEmbed = new EmbedBuilder()
                .setColor(0x00AAFF)
                .setTitle('Ai-chan Status')
                .setDescription(`Current configuration and status information${isBotOwner ? ' (Owner View)' : ''}`)
                .setThumbnail(client.user.displayAvatarURL())
                .addFields(
                    { name: 'AI Models', value: `Default: \`${SMALLER_MODEL}\`\nComplex: \`${BIGGER_MODEL}\``, inline: false },
                    { name: 'Normal Max Tokens', value: NORMAL_MAX_TOKENS.toString(), inline: true },
                    { name: 'Extended Max Tokens', value: EXTENDED_THINKING_MAX_TOKENS.toString(), inline: true },
                    { name: 'Automatic Thinking Mode', value: 'Enabled for very complex prompts', inline: true },
                    { name: 'Show Thinking Process', value: userSettings[user.id].showThinkingProcess ? 'ON' : 'OFF', inline: true },
                    { name: 'Thinking Budget', value: (SMALLER_MODEL.startsWith('openai/') || BIGGER_MODEL.startsWith('openai/')) ? (userSettings[user.id].thinkingBudgetEffort || 'medium') : userSettings[user.id].thinkingBudget.toString(), inline: true }
                );
                
            // Add token usage fields if the user is the bot creator
            if (isBotOwner) {
                const usageDetails = Object.entries(tokenTracking.modelUsage).map(([model, usage]) => {
                    return `**${model}**: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`;
                }).join('\n');

                const modelUsageField = usageDetails.length > 1024
                    ? usageDetails.slice(0, usageDetails.lastIndexOf('\n', 1000)) + '\n...'
                    : usageDetails;

                statusEmbed.addFields(
                    { name: 'Model Usage', value: modelUsageField || 'No data', inline: false },
                    { name: 'Aggregate Statistics', value:
                        `🧠 **Thinking**: ${(tokenTracking.lifetimeThinkingTokens || 0).toLocaleString()} tokens\n` +
                        `🛠️ **Tool Use**: ${(tokenTracking.lifetimeToolUseTokens || 0).toLocaleString()} tokens\n` +
                        `📊 **Avg Input/Message**: ${avgInputTokens} tokens\n` +
                        `📈 **Avg Output/Message**: ${avgOutputTokens} tokens\n` +
                        `💰 **Total Cost**: $${costs.totalCost} ($${costs.inputCost} input, $${costs.outputCost} output)\n` +
                        `🕒 **Tracking Since**: ${new Date(tokenTracking.trackingSince).toLocaleString()}\n` +
                        `🔄 **Cache Performance**: ${tokenTracking.cacheHits} hits, ${tokenTracking.cacheMisses} misses`
                    }
                );
            } else {
                // For regular users, just mention that usage is being tracked
                statusEmbed.addFields(
                    { name: 'Token Usage', value: `Token usage statistics are tracked since ${formatTrackingDate(tokenTracking.trackingSince)} but only visible to the bot owner.`, inline: false }
                );
            }

            statusEmbed.addFields(
                { name: 'Uptime', value: `Since ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`, inline: false }
            );

            // Add footer and timestamp
            statusEmbed.setFooter({ text: 'Developer: kayfahaarukku' })
                       .setTimestamp();

            await interaction.reply({
                embeds: [statusEmbed],
                ephemeral: true
            });
        }
    } catch (error) {
        console.error("Slash Command Error:", error);
        await interaction.reply({
            content: "There was an error processing your command.",
            ephemeral: true
        });
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");

/**
 * Generate AI response for scheduled tasks
 * @param {string} prompt - The prompt to generate response for
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 * @param {string} channelId - Channel ID where the message will be sent
 * @returns {Promise<string>} Generated response
 */
/**
 * Generate AI response for scheduled tasks with tool support
 * @param {string} prompt - The prompt to generate response for
 * @param {string} scope - 'user' or 'guild'
 * @param {string} scopeId - User ID or Guild ID
 * @param {string} channelId - Channel ID where the message will be sent
 * @returns {Promise<string>} Generated response
 */
async function generateScheduledAIResponse(prompt, scope, scopeId, channelId) {
    try {
        const systemMessage = `You are Ai-chan, a helpful assistant. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). This is a scheduled task response. You have access to web search and web scraping tools to help answer questions. Keep your answer concise and helpful. Do NOT use the schedule tool - you cannot create schedules from within a scheduled task.`;

        const openaiMessages = [
            { role: 'system', content: systemMessage },
            { role: 'user', content: prompt }
        ];

        // Filter out schedule tool to prevent recursive scheduling
        const scheduledTaskTools = TOOL_SCHEMAS.filter(t => t.name !== 'schedule');
        const openaiTools = toOpenAITools(scheduledTaskTools);

        // Check if model supports tools
        const toolsSupported = await modelSupportsTools(SMALLER_MODEL);

        let response = await callChat({
            model: SMALLER_MODEL,
            max_tokens: NORMAL_MAX_TOKENS,
            messages: openaiMessages,
            ...(toolsSupported && openaiTools.length > 0 ? { tools: openaiTools } : {})
        });

        // Track token usage helper
        const trackUsage = (usage) => {
            if (usage) {
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                if (!tokenTracking.modelUsage[SMALLER_MODEL]) {
                    tokenTracking.modelUsage[SMALLER_MODEL] = { input: 0, output: 0 };
                }
                tokenTracking.modelUsage[SMALLER_MODEL].input += inputTokens;
                tokenTracking.modelUsage[SMALLER_MODEL].output += outputTokens;
            }
        };

        trackUsage(response.usage);

        let assistantMessage = response.choices?.[0]?.message;
        let toolCalls = toolsSupported ? (assistantMessage?.tool_calls || []) : [];

        // Tool call loop - max 5 iterations to prevent infinite loops
        let iterations = 0;
        const MAX_TOOL_ITERATIONS = 5;

        while (toolCalls && toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
            iterations++;
            console.log(`[Scheduled Task] Tool call iteration ${iterations}:`, toolCalls.map(c => c.function?.name).join(', '));

            // Execute tool calls
            let toolResults = [];
            try {
                toolResults = await executeToolCalls(toolCalls.map(call => {
                    let args = {};
                    try {
                        args = JSON.parse(call.function?.arguments || '{}');
                    } catch (parseError) {
                        console.error(`[Scheduled Task] Failed to parse tool arguments:`, parseError.message);
                    }

                    // Add context for note tool
                    if (call.function?.name === 'note') {
                        args.userId = scope === 'user' ? scopeId : null;
                        args.guildId = scope === 'guild' ? scopeId : null;
                    }

                    return {
                        id: call.id,
                        name: call.function?.name,
                        input: args
                    };
                }));
            } catch (error) {
                console.error('[Scheduled Task] Tool execution error:', error);
                toolResults = toolCalls.map(call => ({
                    tool_call_id: call.id,
                    output: JSON.stringify({ error: 'Tool execution failed', details: error.message })
                }));
            }

            // Add assistant message with tool calls to message list
            openaiMessages.push(assistantMessage);

            // Add tool results
            for (const tr of toolResults) {
                const matchedCall = toolCalls.find(c => c.id === tr.tool_call_id);
                const toolName = matchedCall?.function?.name;
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: tr.tool_call_id,
                    name: toolName,
                    content: tr.output
                });
            }

            // Get model's response with tool results
            response = await callChat({
                model: SMALLER_MODEL,
                max_tokens: NORMAL_MAX_TOKENS,
                messages: openaiMessages,
                ...(toolsSupported && openaiTools.length > 0 ? { tools: openaiTools } : {})
            });

            trackUsage(response.usage);

            assistantMessage = response.choices?.[0]?.message;
            toolCalls = toolsSupported ? (assistantMessage?.tool_calls || []) : [];
        }

        // Save token data after all iterations
        saveTokenData();

        const content = assistantMessage?.content || '';
        return content || `[Scheduled reminder] ${prompt}`;
    } catch (error) {
        console.error('Error generating scheduled AI response:', error);
        return `[Scheduled reminder] ${prompt}`;
    }
}

// Add a ready event handler to verify intents and register slash commands
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Log token tracking information
    const totalLifetimeInput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.input, 0);
    const totalLifetimeOutput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.output, 0);
    console.log(`Token tracking active since: ${formatTrackingDate(tokenTracking.trackingSince)}`);
    console.log(`Current token counts: ${totalLifetimeInput.toLocaleString()} input, ${totalLifetimeOutput.toLocaleString()} output`);

    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }

    // Initialize scheduler and load all scheduled tasks
    console.log('Initializing scheduler...');
    await scheduler.loadAndScheduleAllTasks(client, generateScheduledAIResponse);

    // Set the bot's status message
    client.user.setPresence({
        activities: [{
            name: `Last reset: ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`,
            type: ActivityType.Custom
        }],
        status: 'online'
    });

    // Schedule token data saves every hour as an additional safety measure
    setInterval(saveTokenData, 60 * 60 * 1000);
});

// Clean up guild schedules when bot is removed from a guild
client.on('guildDelete', (guild) => {
    console.log(`Bot removed from guild: ${guild.name} (${guild.id})`);
    scheduler.cleanupGuildSchedules(guild.id);
});

// Add shutdown handler to save token data before exit
process.on('SIGINT', () => {
    console.log('Saving token data before shutdown...');
    saveTokenData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Saving token data before shutdown...');
    saveTokenData();
    process.exit(0);
});

// Add function to calculate costs
const calculateCosts = () => {
    let totalInputCost = 0;
    let totalOutputCost = 0;

    for (const model in tokenTracking.modelUsage) {
        if (tokenTracking.modelUsage.hasOwnProperty(model)) {
            const usage = tokenTracking.modelUsage[model];
            const costs = getCostForModel(model);
            totalInputCost += (usage.input / 1000000) * costs.input;
            totalOutputCost += (usage.output / 1000000) * costs.output;
        }
    }

    return {
        inputCost: totalInputCost.toFixed(4),
        outputCost: totalOutputCost.toFixed(4),
        totalCost: (totalInputCost + totalOutputCost).toFixed(4),
        thinkingTokens: tokenTracking.lifetimeThinkingTokens || 0,
        toolUseTokens: tokenTracking.lifetimeToolUseTokens || 0
    };
};
