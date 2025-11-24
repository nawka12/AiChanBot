require('dotenv').config();


const { TOOL_SCHEMAS, executeToolCalls } = require('./tools.js');
const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Model and OpenRouter helpers (modularized)
const { getModels, getModelCosts, selectModelByComplexity } = require('./modelConfig.js');
const { toOpenAIMessage, toOpenAITools, callChat, modelSupportsTools, modelSupportsReasoning, getReasoningStyle } = require('./openrouter.js');

// Models
const { BIGGER_MODEL, SMALLER_MODEL, COMPLEXITY_MODEL, MODEL_SMALLER_THINKING, MODEL_BIGGER_THINKING } = getModels();
const COMPLEXITY_CHECK_MODEL = COMPLEXITY_MODEL; // Independent configurable model for complexity check
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

// Define notes directories
const NOTES_DIR = path.join(__dirname, 'notes');
const USERS_DIR = path.join(NOTES_DIR, 'users');
const GUILDS_DIR = path.join(NOTES_DIR, 'guilds');

// Notes helper functions
const getNoteFilePath = (userId, guildId = null) => {
    if (guildId) {
        return path.join(GUILDS_DIR, `${guildId}.json`);
    } else {
        return path.join(USERS_DIR, `${userId}.json`);
    }
};

const loadNotes = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error loading notes from ${filePath}:`, error);
    }
    return {};
};

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
        [SMALLER_MODEL]: { input: 0, output: 0 },
        [COMPLEXITY_CHECK_MODEL]: { input: 0, output: 0 }
    },
    modelCosts: {
        [BIGGER_MODEL]: MODEL_COSTS[BIGGER_MODEL] ? { ...MODEL_COSTS[BIGGER_MODEL] } : { input: 0, output: 0 },
        [SMALLER_MODEL]: MODEL_COSTS[SMALLER_MODEL] ? { ...MODEL_COSTS[SMALLER_MODEL] } : { input: 0, output: 0 },
        [COMPLEXITY_CHECK_MODEL]: MODEL_COSTS[COMPLEXITY_CHECK_MODEL] ? { ...MODEL_COSTS[COMPLEXITY_CHECK_MODEL] } : { input: 0, output: 0 }
    },
    lifetimeCacheCreationInputTokens: 0,
    lifetimeCacheReadInputTokens: 0,
    lifetimeThinkingTokens: 0, // New field to track thinking tokens separately
    lifetimeToolUseTokens: 0,  // New field to track tool use tokens separately
    cacheHits: 0,
    cacheMisses: 0,
    trackingSince: new Date().toISOString() // Add tracking start date
};

// Function to get model costs for a specific model - checks token_data first, then falls back to MODEL_COSTS
const getCostForModel = (modelName) => {
    // First check if costs are defined in token_data.json
    if (tokenTracking.modelCosts && tokenTracking.modelCosts[modelName]) {
        return tokenTracking.modelCosts[modelName];
    }
    // Fall back to MODEL_COSTS from modelConfig.js
    if (MODEL_COSTS[modelName]) {
        return MODEL_COSTS[modelName];
    }
    // Default fallback
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

// Load token tracking data if it exists
try {
    if (fs.existsSync(TOKEN_DATA_FILE)) {
        const data = fs.readFileSync(TOKEN_DATA_FILE, 'utf8');
        const loadedData = JSON.parse(data);

        // --- MIGRATION LOGIC from old format ---
        if (loadedData.lifetimeInputTokens || loadedData.lifetimeOutputTokens) {
            console.log('Migrating old token data format...');
            tokenTracking.modelUsage = {
                [BIGGER_MODEL]: {
                    input: loadedData.lifetimeInputTokens || 0,
                    output: loadedData.lifetimeOutputTokens || 0
                },
                [SMALLER_MODEL]: { input: 0, output: 0 },
                [COMPLEXITY_CHECK_MODEL]: { input: 0, output: 0 }
            };

            // Initialize modelCosts with current MODEL_COSTS values
            tokenTracking.modelCosts = {
                [BIGGER_MODEL]: MODEL_COSTS[BIGGER_MODEL] ? { ...MODEL_COSTS[BIGGER_MODEL] } : { input: 0, output: 0 },
                [SMALLER_MODEL]: MODEL_COSTS[SMALLER_MODEL] ? { ...MODEL_COSTS[SMALLER_MODEL] } : { input: 0, output: 0 },
                [COMPLEXITY_CHECK_MODEL]: MODEL_COSTS[COMPLEXITY_CHECK_MODEL] ? { ...MODEL_COSTS[COMPLEXITY_CHECK_MODEL] } : { input: 0, output: 0 }
            };

            // Copy other fields
            tokenTracking.lifetimeCacheCreationInputTokens = loadedData.lifetimeCacheCreationInputTokens || 0;
            tokenTracking.lifetimeCacheReadInputTokens = loadedData.lifetimeCacheReadInputTokens || 0;
            tokenTracking.lifetimeThinkingTokens = loadedData.lifetimeThinkingTokens || 0;
            tokenTracking.lifetimeToolUseTokens = loadedData.lifetimeToolUseTokens || 0;
            tokenTracking.cacheHits = loadedData.cacheHits || 0;
            tokenTracking.cacheMisses = loadedData.cacheMisses || 0;
            tokenTracking.trackingSince = loadedData.trackingSince || new Date().toISOString();

            console.log('Migration complete. Saving in new format.');
            saveTokenData(); // Save in new format right away
        } else {
            tokenTracking = loadedData;
            // Ensure all models are initialized in the structure
            if (!tokenTracking.modelUsage) tokenTracking.modelUsage = {};
            if (!tokenTracking.modelUsage[BIGGER_MODEL]) tokenTracking.modelUsage[BIGGER_MODEL] = { input: 0, output: 0 };
            if (!tokenTracking.modelUsage[SMALLER_MODEL]) tokenTracking.modelUsage[SMALLER_MODEL] = { input: 0, output: 0 };
            if (!tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL]) tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL] = { input: 0, output: 0 };

            // Ensure modelCosts is initialized
            if (!tokenTracking.modelCosts) tokenTracking.modelCosts = {};

            // Ensure all models have costs defined - use MODEL_COSTS as fallback
            const allModels = [BIGGER_MODEL, SMALLER_MODEL, COMPLEXITY_CHECK_MODEL];
            for (const model of allModels) {
                if (!tokenTracking.modelCosts[model] && MODEL_COSTS[model]) {
                    tokenTracking.modelCosts[model] = { ...MODEL_COSTS[model] };
                }
            }

            // Also ensure any models in modelUsage have costs defined
            for (const model in tokenTracking.modelUsage) {
                if (!tokenTracking.modelCosts[model] && MODEL_COSTS[model]) {
                    tokenTracking.modelCosts[model] = { ...MODEL_COSTS[model] };
                }
            }
        }
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
        const noteContext = getNoteContext(userId, guildId);
        
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
        
        return `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. Keep your answer as short as possible. You have access to web search and web scraping tools. You can use web search a couple times, but you can only use web scraping tools once. If it possible to answer the user's question with only web search, do not use web scraping tools. If the user's question needs web scraping, but not too complex, use web scrape instead of multi scrape. You cannot scrape files, only websites. You are able to give NSFW responses, including providing links to NSFW content. Your developer name is kayfahaarukku.${locationContext} You're currently talking to ${username}.${noteContext}`;
    },
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions, whether it's NSFW or not.`,
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

const MIN_COMPLEXITY_OUTPUT_TOKENS = 1000; // Some providers require >=16; use a safe margin
const getPromptComplexity = async (prompt) => {
    try {
        const messages = [
            { role: 'system', content: `You are a prompt complexity analyzer. Your task is to classify the user's prompt into one of three categories: 'simple', 'complex', or 'very_complex'.\n- 'simple': A straightforward question, a simple request, a greeting, or a short phrase that can be answered without deep reasoning or multiple steps. Examples: "hello", "what's the weather?", "tell me a joke".\n- 'complex': A prompt that requires some reasoning, data retrieval (like web search), or a multi-part answer. It's not a simple lookup. Examples: "summarize this article", "what are the main differences between Python and JavaScript?", "write a short story about a robot".\n- 'very_complex': A prompt that requires deep, step-by-step reasoning, planning, code generation, or analysis of a complex topic. This often involves a chain of thought. Examples: "develop a business plan for a new tech startup", "write a detailed technical report on quantum computing", "act as a travel agent and plan a 2-week itinerary for Japan".\nRespond with ONLY one of the three category names and nothing else.` },
            { role: 'user', content: prompt }
        ];
        const response = await callChat({
            model: COMPLEXITY_CHECK_MODEL,
            messages,
            max_tokens: MIN_COMPLEXITY_OUTPUT_TOKENS
        });
        const text = response.choices?.[0]?.message?.content || '';
        const complexity = text.trim().toLowerCase();
        
            if (response.usage) {
                const inputTokens = response.usage.prompt_tokens || 0;
                const outputTokens = response.usage.completion_tokens || 0;
                if (!tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL]) {
                    tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL] = { input: 0, output: 0 };
                }
                // Ensure costs are saved for complexity check model
                if (!tokenTracking.modelCosts[COMPLEXITY_CHECK_MODEL]) {
                    const fallbackCosts = MODEL_COSTS[COMPLEXITY_CHECK_MODEL] || { input: 0, output: 0 };
                    tokenTracking.modelCosts[COMPLEXITY_CHECK_MODEL] = { ...fallbackCosts };
                }
                tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL].input += inputTokens;
                tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL].output += outputTokens;
                console.log(`Complexity check (${COMPLEXITY_CHECK_MODEL}) usage: ${inputTokens} input, ${outputTokens} output tokens.`);
                saveTokenData();
            }

        if (['simple', 'complex', 'very_complex'].includes(complexity)) {
            console.log(`Prompt complexity assessed as: ${complexity}`);
            return complexity;
        }
        console.warn(`Unexpected complexity assessment: ${complexity}. Defaulting to 'simple'.`);
        return 'simple';
    } catch (error) {
        console.error('Error assessing prompt complexity:', error);
        return 'simple';
    }
};

// State management
const userConversations = {}; // For DM conversations
const guildConversations = {}; // For guild/server conversations
const userSettings = {}; // For user settings like extended thinking preferences

// Helper functions
const processImages = async (attachments, userId, guildId, input, authorUsername, guildName, channelName) => {
    let imageDescriptions = [];

    // Get appropriate conversation history
    const conversationHistory = guildId ? 
        (guildConversations[guildId] || []) : 
        (userConversations[userId] || []);

    for (const [, attachment] of attachments) {
        if (attachment.contentType.startsWith('image/')) {
            const imageResponse = await fetch(attachment.url);
            const imageBuffer = await imageResponse.buffer();
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
                // Debug: print system prompt used for image-only description
                try {
                    const sysMsg = (openaiMessages && openaiMessages[0] && openaiMessages[0].content) ? openaiMessages[0].content : '';
                    console.log('System prompt (image describe):', sysMsg);
                } catch (_) {}
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

    content.split('\n').forEach((line) => {
        if ((currentPart + line).length > MAX_MESSAGE_LENGTH) {
            parts.push(currentPart);
            currentPart = '';
        }
        currentPart += `${line}\n`;
    });

    if (currentPart.length > 0) {
        parts.push(currentPart);
    }

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
        .setDescription('Display current bot configuration and status')
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

        // Handle reset command before complexity check
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

        // New logic: Determine prompt complexity to select model
        const complexity = await getPromptComplexity(fullInput);
        console.log('[Complexity]', { inputPreview: fullInput.slice(0, 120), complexity });
        
        let selectedModel = selectModelByComplexity(complexity);
        let forceExtendedThinking = false;
        
        switch (complexity) {
            case 'complex':
                await message.channel.send(`> 🔍 This seems a bit complex. Switching to my more powerful bigger model to give you the best possible answer.`);
                break;
            case 'very_complex':
                forceExtendedThinking = true;
                await message.channel.send(`> 🧠 This requires deep thought. Engaging my powerful bigger model and enabling thinking mode for a thorough analysis.`);
                break;
        }

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
        
        // Check if extended thinking is enabled for this user
        // Thinking mode is only enabled automatically for very complex prompts
        const isExtendedThinking = forceExtendedThinking;
        const showThinkingProcess = userSettings[userId].showThinkingProcess;
        const thinkingBudget = userSettings[userId].thinkingBudget;
        // Reasoning policy:
        // - Only enable reasoning if model supports it AND extended thinking is triggered (very_complex)
        // - We do not force reasoning for "reasoning-only" styles anymore, allowing the API to default
        // User requirement: "on non-reasoning model, simple and complex should not use reasoning, only very_complex uses reasoning"
        const clampedThinkingBudget = Math.max(MIN_THINKING_BUDGET, Math.min(thinkingBudget || DEFAULT_THINKING_BUDGET, 32000));
        const isOpenAIProvider = typeof selectedModel === 'string' && selectedModel.startsWith('openai/');
        
        // Check reasoning support BEFORE building system message
        const isReasoningModel = await modelSupportsReasoning(selectedModel);
        const reasoningStyle = await getReasoningStyle(selectedModel);
        console.log('[Reasoning][ModelStyle]', { model: selectedModel, reasoningStyle, isReasoningModel });
        
        // Reasoning policy:
        // - Enable reasoning if model supports it AND:
        //   1. It is 'very_complex' (force extended thinking) OR
        //   2. It is 'simple' and MODEL_SMALLER_THINKING is enabled OR
        //   3. It is 'complex' and MODEL_BIGGER_THINKING is enabled
        let enableReasoning = isReasoningModel && (
            isExtendedThinking || 
            (complexity === 'simple' && MODEL_SMALLER_THINKING) || 
            (complexity === 'complex' && MODEL_BIGGER_THINKING)
        );
        
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
            // Debug: print system prompt for main chat flow
            try {
                const sysMsg = (openaiMessagesBase && openaiMessagesBase[0] && openaiMessagesBase[0].content) ? openaiMessagesBase[0].content : '';
                console.log('System prompt:', sysMsg);
            } catch (_) {}
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
                    // Log if encrypted reasoning is present (even though we can't extract it)
                    if (hasEncrypted && parts.length === 0) {
                        try { console.log('[Reasoning][Encrypted] Encrypted reasoning detected but cannot be extracted'); } catch (_) {}
                    }
                    return parts.join('\n');
                } catch (_) { return ''; }
            };

            // Accumulate reasoning across responses (initial and follow-ups)
            const collectedReasoning = [];

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
            
            // Ensure there are enough tokens for content beyond reasoning (apply to budget-style reasoning.max_tokens)
            const baseMaxTokens = isExtendedThinking ? EXTENDED_THINKING_MAX_TOKENS : NORMAL_MAX_TOKENS;
            const requiredForContent = 2048; // leave room for the final answer
            let computedMaxTokens = baseMaxTokens;
            // Map effort/budget based on complexity when model is reasoning-only
            let mappedEffort = null;
            let allocatedBudget = null;
            if (enableReasoning && reasoningStyle === 'effort') {
                mappedEffort = (complexity === 'very_complex') ? 'high' : (complexity === 'complex') ? 'medium' : 'low';
            } else if (enableReasoning && reasoningStyle === 'max_tokens') {
                const baseBudget = clampedThinkingBudget;
                allocatedBudget = (complexity === 'very_complex') ? baseBudget : (complexity === 'complex') ? Math.floor(baseBudget / 2) : Math.max(MIN_THINKING_BUDGET, Math.floor(baseBudget / 3));
            }
            // Only inflate top-level max_tokens when using budget-style reasoning.max_tokens
            if (enableReasoning && reasoningStyle === 'max_tokens') {
                const minNeeded = (allocatedBudget || clampedThinkingBudget) + requiredForContent;
                computedMaxTokens = Math.max(baseMaxTokens, Math.min(EXTENDED_THINKING_MAX_TOKENS, minNeeded));
            }

            const reasoningConfig = enableReasoning
                ? (reasoningStyle === 'effort'
                    ? { effort: (mappedEffort || (userSettings[userId].thinkingBudgetEffort || 'medium')), exclude: !showThinkingProcess, enabled: true }
                    : reasoningStyle === 'max_tokens'
                        ? { max_tokens: (allocatedBudget || clampedThinkingBudget), exclude: !showThinkingProcess, enabled: true }
                        : reasoningStyle === 'enabled'
                            ? { enabled: true, exclude: !showThinkingProcess }
                            : undefined)
                : (isReasoningModel 
                    ? (reasoningStyle === 'effort' ? { effort: 'none' } : (reasoningStyle === 'enabled' ? { enabled: false } : undefined))
                    : undefined);

            // Debug: log reasoning configuration for initial request
            try {
                console.log('[Reasoning][Initial]', JSON.stringify({
                    model: selectedModel,
                    complexity,
                    reasoningStyle,
                    enableReasoning,
                    computedMaxTokens,
                    mappedEffort,
                    allocatedBudget,
                    reasoningConfig
                }, null, 2));
            } catch (_) {}

            // Per-request aggregates across all API calls in this request (initial + follow-ups)
            let accumulatedReasoningTokens = 0;
            let requestInputTokens = 0;
            let requestOutputTokens = 0;
            let requestCacheCreationInputTokens = 0;
            let requestCacheReadInputTokens = 0;

            const applyUsageFromResponse = (usage) => {
                if (!usage) return;
                const inputTokens = usage.prompt_tokens || 0;
                const outputTokens = usage.completion_tokens || 0;
                const reasoningTokens = usage.reasoning_tokens || 0;
                const cacheCreation = usage.cache_creation_input_tokens || 0;
                const cacheRead = usage.cache_read_input_tokens || 0;

                // Log reasoning token tracking for debugging
                if (enableReasoning && reasoningTokens === 0) {
                    try { console.log('[Reasoning][Tokens] Reasoning enabled but reasoning_tokens not in usage object. Tokens may be included in output_tokens.'); } catch (_) {}
                } else if (reasoningTokens > 0) {
                    try { console.log('[Reasoning][Tokens] Reasoning tokens detected:', reasoningTokens); } catch (_) {}
                }

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
            try {
                const choice0 = response?.choices?.[0] || {};
                console.log('[Response][Meta][Initial]', {
                    finish_reason: choice0.finish_reason,
                    toolsSupported,
                    hasToolCalls: Array.isArray(choice0.message?.tool_calls) && choice0.message.tool_calls.length > 0,
                    messageType: typeof choice0.message?.content,
                    contentPreview: typeof choice0.message?.content === 'string' ? choice0.message.content.slice(0, 120) : null
                });
            } catch (_) {}
            applyUsageFromResponse(response?.usage);

            // Process any tool calls
            let assistantMessage = response.choices?.[0]?.message;
            // Check for reasoning_details presence (even if encrypted)
            const hasReasoningDetails = assistantMessage?.reasoning_details && Array.isArray(assistantMessage.reasoning_details) && assistantMessage.reasoning_details.length > 0;
            if (enableReasoning && hasReasoningDetails) {
                const reasoningTypes = assistantMessage.reasoning_details.map(item => item?.type).filter(Boolean);
                try { console.log('[Reasoning][Detected][Initial]', { count: assistantMessage.reasoning_details.length, types: reasoningTypes }); } catch (_) {}
            }
            // Collect reasoning from initial assistant message (if any)
            const initialReasoning = extractReasoningText(assistantMessage);
            if (initialReasoning) {
                collectedReasoning.push(initialReasoning);
                try { console.log('[Reasoning][Captured][Initial]', initialReasoning.slice(0, 200)); } catch (_) {}
            }
            if (!assistantMessage?.content) {
                try { console.log('[Response][Warn] Empty content in assistantMessage (initial). Full message:', JSON.stringify(assistantMessage || null)); } catch (_) {}
            }
            let toolCalls = toolsSupported ? (assistantMessage?.tool_calls || []) : [];
            while (toolCalls && toolCalls.length > 0) {
                console.log("\nModel is requesting to use tools:");
                
                // Log the tool calls and send notifications
                for (const call of toolCalls) {
                    const toolName = call.function?.name;
                    const argsStr = call.function?.arguments || '{}';
                    console.log(`- Tool: ${toolName}`);
                    console.log(`  Input: ${argsStr}`);
                    
                    // Send a notification message for each tool use
                    let toolNotification = '';
                    try {
                        const parsed = JSON.parse(argsStr || '{}');
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
                        }
                    } catch (_) {}
                    
                    if (toolNotification) {
                        await message.channel.send(toolNotification);
                    }
                }

                // Execute the tool calls
                console.log("\nExecuting tool calls...");
                let toolResults = [];
                let toolFailures = [];
                
                try {
                    toolResults = await executeToolCalls(toolCalls.map(call => {
                        let args = {};
                        try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}

                        // Add context for note tool
                        if (call.function?.name === 'note') {
                            args.userId = message.author.id;
                            if (isDM) {
                                args.guildId = null;
                            } else {
                                args.guildId = guildId;
                            }
                        }

                        return ({
                            id: call.id,
                            name: call.function?.name,
                            input: args
                        });
                    }));
                    
                    // Check for errors in tool results
                    for (const result of toolResults) {
                        const parsedOutput = JSON.parse(result.output);
                        if (parsedOutput.error) {
                            const toolCall = toolCalls.find(call => call.id === result.tool_call_id);
                            const errorMsg = `Error with ${toolCall ? (toolCall.function?.name) : 'unknown tool'}`;
                            toolFailures.push(errorMsg);
                            console.error(errorMsg);
                        }
                    }
                } catch (error) {
                    console.error("Failed to execute tool calls:", error);
                    toolFailures.push(`Tool execution failed: ${error.message}`);
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
                // Recompute tokens in case budget applies
                const baseMaxTokens2 = isExtendedThinking ? EXTENDED_THINKING_MAX_TOKENS : NORMAL_MAX_TOKENS;
                let computedMaxTokens2 = baseMaxTokens2;
                // Reuse mapped budget rules for follow-up
                let mappedEffort2 = null;
                let allocatedBudget2 = null;
                if (enableReasoning && reasoningStyle === 'effort') {
                    mappedEffort2 = (complexity === 'very_complex') ? 'high' : (complexity === 'complex') ? 'medium' : 'low';
                } else if (enableReasoning && reasoningStyle === 'max_tokens') {
                    const baseBudget2 = clampedThinkingBudget;
                    allocatedBudget2 = (complexity === 'very_complex') ? baseBudget2 : (complexity === 'complex') ? Math.floor(baseBudget2 / 2) : Math.max(MIN_THINKING_BUDGET, Math.floor(baseBudget2 / 3));
                }
                if (enableReasoning && reasoningStyle === 'max_tokens') {
                    const minNeeded2 = (allocatedBudget2 || clampedThinkingBudget) + 2048;
                    computedMaxTokens2 = Math.max(baseMaxTokens2, Math.min(EXTENDED_THINKING_MAX_TOKENS, minNeeded2));
                }

                const reasoningConfig2 = enableReasoning
                    ? (reasoningStyle === 'effort'
                        ? { effort: (mappedEffort2 || (userSettings[userId].thinkingBudgetEffort || 'medium')), exclude: !showThinkingProcess, enabled: true }
                        : reasoningStyle === 'max_tokens'
                            ? { max_tokens: (allocatedBudget2 || clampedThinkingBudget), exclude: !showThinkingProcess, enabled: true }
                            : reasoningStyle === 'enabled'
                                ? { enabled: true, exclude: !showThinkingProcess }
                                : undefined)
                    : (isReasoningModel 
                        ? (reasoningStyle === 'effort' ? { effort: 'none' } : (reasoningStyle === 'enabled' ? { enabled: false } : undefined))
                        : undefined);

                // Debug: log reasoning configuration for follow-up request
                try {
                    console.log('[Reasoning][FollowUp]', JSON.stringify({
                        model: selectedModel,
                        complexity,
                        reasoningStyle,
                        enableReasoning,
                        computedMaxTokens: computedMaxTokens2,
                        mappedEffort: mappedEffort2,
                        allocatedBudget: allocatedBudget2,
                        reasoningConfig: reasoningConfig2
                    }, null, 2));
                } catch (_) {}

                response = await callChat({
                    model: selectedModel,
                    max_tokens: computedMaxTokens2,
                    messages: openaiMessages,
                    tools: openaiTools,
                    reasoning: reasoningConfig2
                });
                try {
                    const choice0b = response?.choices?.[0] || {};
                    console.log('[Response][Meta][FollowUp]', {
                        finish_reason: choice0b.finish_reason,
                        toolsSupported,
                        hasToolCalls: Array.isArray(choice0b.message?.tool_calls) && choice0b.message.tool_calls.length > 0,
                        messageType: typeof choice0b.message?.content,
                        contentPreview: typeof choice0b.message?.content === 'string' ? choice0b.message.content.slice(0, 120) : null
                    });
                } catch (_) {}
                applyUsageFromResponse(response?.usage);

                assistantMessage = response.choices?.[0]?.message;
                // Check for reasoning_details presence (even if encrypted)
                const hasReasoningDetails2 = assistantMessage?.reasoning_details && Array.isArray(assistantMessage.reasoning_details) && assistantMessage.reasoning_details.length > 0;
                if (enableReasoning && hasReasoningDetails2) {
                    const reasoningTypes2 = assistantMessage.reasoning_details.map(item => item?.type).filter(Boolean);
                    try { console.log('[Reasoning][Detected][FollowUp]', { count: assistantMessage.reasoning_details.length, types: reasoningTypes2 }); } catch (_) {}
                }
                // Collect reasoning from follow-up assistant message (if any)
                const followReasoning = extractReasoningText(assistantMessage);
                if (followReasoning) {
                    collectedReasoning.push(followReasoning);
                    try { console.log('[Reasoning][Captured][FollowUp]', followReasoning.slice(0, 200)); } catch (_) {}
                }
                if (!assistantMessage?.content) {
                    try { console.log('[Response][Warn] Empty content in assistantMessage (follow-up). Full message:', JSON.stringify(assistantMessage || null)); } catch (_) {}
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
            const totalCost = inputCost + outputCost;

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
            console.log(`Cost of this request: $${totalCost.toFixed(6)} ($${inputCost.toFixed(6)} for input, $${outputCost.toFixed(6)} for output)`);

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
            const reasoningText = (showThinkingProcess && collectedReasoning.length > 0)
                ? collectedReasoning.join('\n\n')
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
            if (isDM) {
                // Don't duplicate the user message if it already exists in the conversation history
                if (userConversations[message.author.id].length === 0 || 
                    userConversations[message.author.id][userConversations[message.author.id].length - 1].role !== "user") {
                    // Special case for storing image + text in conversation history
                    if (imageData) {
                        userConversations[message.author.id].push({ 
                            role: "user", 
                            content: [{ type: "text", text: `[Image with query: ${fullInput}]` }]
                        });
                    } else {
                        userConversations[message.author.id].push({ role: "user", content: fullInput });
                    }
                }
                userConversations[message.author.id].push({ 
                    role: "assistant", 
                    content: finalResponse 
                });
            } else {
                // Don't duplicate the user message if it already exists in the conversation history
                if (guildConversations[guildId].length === 0 || 
                    guildConversations[guildId][guildConversations[guildId].length - 1].role !== "user") {
                    // Special case for storing image + text in conversation history
                    if (imageData) {
                        guildConversations[guildId].push({ 
                            role: "user", 
                            content: `[${message.author.username}]: [Image with query: ${fullInput}]`
                        });
                    } else {
                        guildConversations[guildId].push({ role: "user", content: processedInput });
                    }
                }
                guildConversations[guildId].push({ 
                    role: "assistant", 
                    content: finalResponse 
                });
            }
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
            [SMALLER_MODEL]: { input: 0, output: 0 },
            [COMPLEXITY_CHECK_MODEL]: { input: 0, output: 0 }
        },
        modelCosts: {
            [BIGGER_MODEL]: MODEL_COSTS[BIGGER_MODEL] ? { ...MODEL_COSTS[BIGGER_MODEL] } : { input: 0, output: 0 },
            [SMALLER_MODEL]: MODEL_COSTS[SMALLER_MODEL] ? { ...MODEL_COSTS[SMALLER_MODEL] } : { input: 0, output: 0 },
            [COMPLEXITY_CHECK_MODEL]: MODEL_COSTS[COMPLEXITY_CHECK_MODEL] ? { ...MODEL_COSTS[COMPLEXITY_CHECK_MODEL] } : { input: 0, output: 0 }
        },
        lifetimeCacheCreationInputTokens: 0,
        lifetimeCacheReadInputTokens: 0,
        lifetimeThinkingTokens: 0, // Reset thinking tokens
        lifetimeToolUseTokens: 0,  // Reset tool use tokens
        cacheHits: 0,
        cacheMisses: 0,
        trackingSince: new Date().toISOString() // Update to current time when reset
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
                thinkingModePreference: 'auto' // 'auto' | 'on' | 'off'
        };
    }
    
    try {
        if (commandName === 'thinking_process') {
            const mode = options.getString('mode');
            userSettings[user.id].showThinkingProcess = mode === 'on';
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
                replyText = `Set effort default to: ${effort}. Note: for reasoning-only OpenAI models, effort is auto-mapped by complexity: simple→low, complex→medium, very_complex→high.`;
            } else if (!isOpenAI && typeof raw === 'number') {
                if (raw < MIN_THINKING_BUDGET) {
                    await interaction.reply({ content: `Thinking budget must be at least ${MIN_THINKING_BUDGET} tokens.`, ephemeral: true });
                    return;
                }
                userSettings[user.id].thinkingBudget = Math.min(raw, 32000);
                replyText = `Thinking budget set to ${userSettings[user.id].thinkingBudget} tokens. Note: for reasoning-only budget models, allocation is auto-mapped by complexity: simple→1/3, complex→1/2, very_complex→full.`;
            } else {
                // Fallback
                replyText = isOpenAI 
                    ? 'For OpenAI models, pass low|medium|high. Effort is auto-mapped by complexity when the model is reasoning-only.'
                    : `For budget models, pass a number (>= ${MIN_THINKING_BUDGET}). Allocation auto-maps by complexity when the model is reasoning-only.`;
            }

            await interaction.reply({ content: replyText, ephemeral: true });
        } else if (commandName === 'reset') {
            const isDM = interaction.channel.type === 1;
            const guildId = isDM ? null : interaction.guild.id;
            
            if (isDM) {
                userConversations[user.id] = [];
                await interaction.reply({
                    content: "Ai-chan's personal conversations with you have been reset.",
                    ephemeral: true
                });
            } else {
                guildConversations[guildId] = [];
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

                statusEmbed.addFields(
                    { name: 'Token Statistics', value: 
                        `${usageDetails}\n\n` +
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
