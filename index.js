require('dotenv').config();


const { TOOL_SCHEMAS, executeToolCalls } = require('./tools.js');
const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Constants
const SONNET_MODEL = 'claude-sonnet-4-20250514';
const HAIKU_MODEL = 'claude-3-5-haiku-20241022'; // As requested by user
const COMPLEXITY_CHECK_MODEL = 'claude-3-5-haiku-20241022'; // Use a known fast model for complexity check

const MODEL_COSTS = {
    [SONNET_MODEL]: {
        input: 3, // per million tokens
        output: 15
    },
    [HAIKU_MODEL]: {
        input: 0.80, // per million tokens
        output: 4.0
    }
};

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

// Add token tracking variables
let tokenTracking = {
    modelUsage: {
        [SONNET_MODEL]: { input: 0, output: 0 },
        [HAIKU_MODEL]: { input: 0, output: 0 }
    },
    lifetimeCacheCreationInputTokens: 0,
    lifetimeCacheReadInputTokens: 0,
    lifetimeThinkingTokens: 0, // New field to track thinking tokens separately
    lifetimeToolUseTokens: 0,  // New field to track tool use tokens separately
    cacheHits: 0,
    cacheMisses: 0,
    trackingSince: new Date().toISOString() // Add tracking start date
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
                [SONNET_MODEL]: {
                    input: loadedData.lifetimeInputTokens || 0,
                    output: loadedData.lifetimeOutputTokens || 0
                },
                [HAIKU_MODEL]: { input: 0, output: 0 }
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
            if (!tokenTracking.modelUsage[SONNET_MODEL]) tokenTracking.modelUsage[SONNET_MODEL] = { input: 0, output: 0 };
            if (!tokenTracking.modelUsage[HAIKU_MODEL]) tokenTracking.modelUsage[HAIKU_MODEL] = { input: 0, output: 0 };
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
    systemMessage: (username, extendedThinking) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. You have 2 modes; standard and thinking (uses extended thinking for complex problems). ${extendedThinking ? "You're using extended thinking mode to solve complex problems." : "You're using standard mode."} ${extendedThinking ? "You're using extended thinking mode, which means you'll show your step-by-step reasoning process before providing your final answer." : ""} Keep your answer as short as possible. You have access to web search and web scraping tools. You can only use web scraping tools once. If it possible to answer the user's question with only web search, do not use web scraping tools. If the user's question needs web scraping, but not too complex, use web scrape instead of multi scrape. You cannot scrape files, only websites. You are able to give NSFW responses, including providing links to NSFW content. Your developer name is kayfahaarukku. You're currently talking to ${username}.`,
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

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const getPromptComplexity = async (prompt) => {
    try {
        const response = await anthropic.messages.create({
            model: COMPLEXITY_CHECK_MODEL,
            max_tokens: 10,
            system: `You are a prompt complexity analyzer. Your task is to classify the user's prompt into one of three categories: 'simple', 'complex', or 'very_complex'.
- 'simple': A straightforward question, a simple request, a greeting, or a short phrase that can be answered without deep reasoning or multiple steps. Examples: "hello", "what's the weather?", "tell me a joke".
- 'complex': A prompt that requires some reasoning, data retrieval (like web search), or a multi-part answer. It's not a simple lookup. Examples: "summarize this article", "what are the main differences between Python and JavaScript?", "write a short story about a robot".
- 'very_complex': A prompt that requires deep, step-by-step reasoning, planning, code generation, or analysis of a complex topic. This often involves a chain of thought. Examples: "develop a business plan for a new tech startup", "write a detailed technical report on quantum computing", "act as a travel agent and plan a 2-week itinerary for Japan".
Respond with ONLY one of the three category names and nothing else.`,
            messages: [{ role: 'user', content: prompt }]
        });
        const complexity = response.content[0].text.trim().toLowerCase();
        
        // Track token usage for the complexity check itself
        if (response.usage && tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL]) {
            const inputTokens = response.usage.input_tokens || 0;
            const outputTokens = response.usage.output_tokens || 0;
            tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL].input += inputTokens;
            tokenTracking.modelUsage[COMPLEXITY_CHECK_MODEL].output += outputTokens;
            console.log(`Complexity check (${COMPLEXITY_CHECK_MODEL}) usage: ${inputTokens} input, ${outputTokens} output tokens.`);
            saveTokenData(); // Save data after tracking
        }

        if (['simple', 'complex', 'very_complex'].includes(complexity)) {
            console.log(`Prompt complexity assessed as: ${complexity}`);
            return complexity;
        }
        console.warn(`Unexpected complexity assessment: ${complexity}. Defaulting to 'simple'.`);
        return 'simple'; // Default to simple if the model returns something unexpected
    } catch (error) {
        console.error('Error assessing prompt complexity:', error);
        return 'simple'; // Default to simple on error
    }
};

// State management
const userConversations = {}; // For DM conversations
const guildConversations = {}; // For guild/server conversations
const userSettings = {}; // For user settings like extended thinking preferences

// Helper functions
const processImages = async (attachments, userId, guildId, input) => {
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
                const imageAI = await anthropic.messages.create({
                    model: HAIKU_MODEL,
                    max_tokens: NORMAL_MAX_TOKENS,
                    system: `${config.systemMessage(userId, false)} Describe the image concisely and answer the user's question if provided.`,
                    messages: [
                        ...conversationHistory,
                        {
                            role: "user",
                            content: [
                                imageContent,
                                {
                                    type: "text",
                                    text: input || "What's in this image?"
                                }
                            ]
                        }
                    ]
                });

                const imageDescription = imageAI.content[0].text;
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
        .setDescription('Set the thinking budget (tokens)')
        .addIntegerOption(option => 
            option.setName('budget')
                .setDescription('Number of tokens for thinking (min 1024)')
                .setRequired(true)
                .setMinValue(MIN_THINKING_BUDGET)),
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

        // New logic: Determine prompt complexity to select model
        const complexity = await getPromptComplexity(fullInput);
        let selectedModel = HAIKU_MODEL;
        let forceExtendedThinking = false;
        
        switch (complexity) {
            case 'complex':
                selectedModel = SONNET_MODEL;
                await message.channel.send(`> 🔍 This seems a bit complex. Switching to my more powerful Sonnet model to give you the best possible answer.`);
                break;
            case 'very_complex':
                selectedModel = SONNET_MODEL;
                forceExtendedThinking = true;
                await message.channel.send(`> 🧠 This requires deep thought. Engaging my powerful Sonnet model and enabling thinking mode for a thorough analysis.`);
                break;
        }

        const userId = message.author.id;

        // Initialize user settings if they don't exist
        if (!userSettings[userId]) {
            userSettings[userId] = {
                showThinkingProcess: false,
                thinkingBudget: DEFAULT_THINKING_BUDGET
            };
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
                
                const result = await processImages(attachmentsToProcess, message.author.id, guildId, fullInput);
                
                // Check if we received image content or descriptions
                if (typeof result === 'object' && result.imageContent) {
                    // We have image content to pass directly to Claude with the query
                    imageData = result;
                    console.log("Image prepared for direct processing with Claude");
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
        const isExtendedThinking = forceExtendedThinking;
        const showThinkingProcess = userSettings[userId].showThinkingProcess;
        const thinkingBudget = userSettings[userId].thinkingBudget;
        
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
            // Create API request parameters
            const apiParams = {
                model: selectedModel,
                max_tokens: isExtendedThinking ? EXTENDED_THINKING_MAX_TOKENS : NORMAL_MAX_TOKENS,
                system: config.systemMessage(message.author.username, isExtendedThinking),
                messages: messages,
                tools: TOOL_SCHEMAS
            };
            
            // Add thinking parameters if extended thinking is enabled
            if (isExtendedThinking) {
                apiParams.thinking = {
                    type: "enabled",
                    budget_tokens: thinkingBudget
                };
            }
            
            // Send a "Thinking..." message if extended thinking is enabled
            let thinkingMessage = null;
            const startTime = Date.now();
            
            if (isExtendedThinking) {
                thinkingMessage = await message.reply("Thinking...");
            }
            
            // Make the API request
            let response = await anthropic.messages.create(apiParams);
            
            // Add debug logging for initial response
            console.log(`Initial response - content types: ${response.content.map(item => item.type).join(', ')}`);
            console.log(`Has thinking content: ${response.content.some(item => item.type === 'thinking')}`);
            if (response.content.some(item => item.type === 'thinking')) {
                console.log(`Thinking item exists: ${!!response.content.find(item => item.type === 'thinking')}`);
            }
            
            // Process any tool calls from Claude
            let toolCallFound = response.content.some(item => item.type === 'tool_use');
            
            while (toolCallFound) {
                console.log("\nClaude is requesting to use tools:");
                const toolCalls = response.content.filter(item => item.type === 'tool_use');
                
                // Log the tool calls and send notifications
                for (const call of toolCalls) {
                    console.log(`- Tool: ${call.name}`);
                    console.log(`  Input: ${JSON.stringify(call.input, null, 2)}`);
                    
                    // Send a notification message for each tool use
                    let toolNotification = '';
                    if (call.name === 'web_search') {
                        toolNotification = `Using web search for: \`${call.input.query}\``;
                    } else if (call.name === 'web_scrape') {
                        toolNotification = `Using web scraper for: \`${call.input.url}\``;
                    } else if (call.name === 'multi_scrape') {
                        toolNotification = `Using multi-page scraper for \`${call.input.urls.length}\` URLs`;
                    } else if (call.name === 'nitter_tweets') {
                        const username = call.input.username.startsWith('@') ? call.input.username : `@${call.input.username}`;
                        toolNotification = `Using nitter tweets tool for: \`${username}\``;
                    } else if (call.name === 'tweet_url_scrape') {
                        toolNotification = `Using tweet URL scraper for: \`${call.input.url}\``;
                    }
                    
                    if (toolNotification) {
                        await message.channel.send(toolNotification);
                    }
                }

                // Execute the tool calls
                console.log("\nExecuting tool calls...");
                let toolResults = [];
                let toolFailures = [];
                
                try {
                    toolResults = await executeToolCalls(toolCalls.map(call => ({
                        id: call.id,
                        name: call.name,
                        input: call.input
                    })));
                    
                    // Check for errors in tool results
                    for (const result of toolResults) {
                        const parsedOutput = JSON.parse(result.output);
                        if (parsedOutput.error) {
                            const toolCall = toolCalls.find(call => call.id === result.tool_call_id);
                            const errorMsg = `Error with ${toolCall ? toolCall.name : 'unknown tool'}`;
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

                // Add the tool outputs to the messages
                messages.push({
                    role: 'assistant',
                    content: response.content
                });

                // Add the tool results to the messages
                messages.push({
                    role: 'user',
                    content: toolResults.map(result => ({
                        type: 'tool_result',
                        tool_use_id: result.tool_call_id,
                        content: result.output
                    }))
                });

                // Get Claude's response with the tool results
                const apiParamsAfterTools = {
                    model: selectedModel,
                    max_tokens: isExtendedThinking ? EXTENDED_THINKING_MAX_TOKENS : NORMAL_MAX_TOKENS,
                    system: config.systemMessage(message.author.username, isExtendedThinking) + (toolFailures.length > 0 ? 
                        " NOTE: Some tools encountered errors when trying to access the web. Please acknowledge this in your response and try to answer the question with the information you have, or suggest alternative approaches if appropriate." : ""),
                    messages: messages,
                    tools: TOOL_SCHEMAS // Add tools to subsequent calls so Claude can continue using them
                };
                
                // Add thinking parameters if extended thinking is enabled
                if (isExtendedThinking) {
                    apiParamsAfterTools.thinking = {
                        type: "enabled",
                        budget_tokens: thinkingBudget
                    };
                }
                
                // Make the API request
                response = await anthropic.messages.create(apiParamsAfterTools);
                
                // Add debug logging for response after tools
                console.log(`Response after tools - content types: ${response.content.map(item => item.type).join(', ')}`);
                console.log(`Has thinking content: ${response.content.some(item => item.type === 'thinking')}`);
                if (response.content.some(item => item.type === 'thinking')) {
                    console.log(`Thinking item exists: ${!!response.content.find(item => item.type === 'thinking')}`);
                }
                
                // Check if new tool calls were made
                toolCallFound = response.content.some(item => item.type === 'tool_use');
            }
            
            // Track token usage
            if (response.usage) {
                const inputTokens = response.usage.input_tokens || 0;
                const outputTokens = response.usage.output_tokens || 0;

                // Track standard input/output tokens for the selected model
                if (!tokenTracking.modelUsage[selectedModel]) {
                    tokenTracking.modelUsage[selectedModel] = { input: 0, output: 0 };
                }
                tokenTracking.modelUsage[selectedModel].input += inputTokens;
                tokenTracking.modelUsage[selectedModel].output += outputTokens;

                // Track extended thinking tokens if present in the response
                let thinkingTokenCount = 0;
                if (isExtendedThinking && response.content.some(item => item.type === 'thinking')) {
                    const thinkingItem = response.content.find(item => item.type === 'thinking');
                    if (thinkingItem && thinkingItem.thinking) {
                        // Note: This is an estimate as Anthropic doesn't provide exact thinking token count
                        // Current assistant turn thinking DOES count toward input tokens
                        thinkingTokenCount = Math.ceil(thinkingItem.thinking.length / 4); // Rough estimate
                        tokenTracking.lifetimeThinkingTokens += thinkingTokenCount;
                        console.log(`Estimated thinking tokens: ${thinkingTokenCount}`);
                    }
                }
                
                // Track tool use tokens if present in the response
                let toolUseTokenCount = 0;
                const toolUseItems = response.content.filter(item => item.type === 'tool_use');
                if (toolUseItems.length > 0) {
                    // Rough estimate of tool use tokens - adjust according to actual usage patterns
                    toolUseTokenCount = toolUseItems.reduce((acc, item) => {
                        // Estimate tokens for each tool call based on parameters
                        return acc + Math.ceil(JSON.stringify(item).length / 4);
                    }, 0);
                    tokenTracking.lifetimeToolUseTokens += toolUseTokenCount;
                    console.log(`Estimated tool use tokens: ${toolUseTokenCount}`);
                }
                
                // Track cache usage if available
                let cacheInfo = '';
                if (response.usage.cache_creation_input_tokens) {
                    tokenTracking.lifetimeCacheCreationInputTokens += response.usage.cache_creation_input_tokens;
                    tokenTracking.cacheMisses++;
                    cacheInfo = `, Cache: MISS (${response.usage.cache_creation_input_tokens} tokens)`;
                }
                if (response.usage.cache_read_input_tokens) {
                    tokenTracking.lifetimeCacheReadInputTokens += response.usage.cache_read_input_tokens;
                    tokenTracking.cacheHits++;
                    cacheInfo = `, Cache: HIT (${response.usage.cache_read_input_tokens} tokens)`;
                }
                
                // Calculate costs for this specific request
                const modelCosts = MODEL_COSTS[selectedModel] || { input: 0, output: 0 };
                const inputCost = (inputTokens / 1000000) * modelCosts.input;
                const outputCost = (outputTokens / 1000000) * modelCosts.output;
                const totalCost = inputCost + outputCost;
                
                console.log(`Token usage for ${selectedModel} - Input: ${inputTokens}, Output: ${outputTokens}${cacheInfo}`);
                if (thinkingTokenCount > 0) {
                    console.log(`Thinking tokens: ${thinkingTokenCount} (included in input tokens)`);
                }
                if (toolUseTokenCount > 0) {
                    console.log(`Tool use tokens: ${toolUseTokenCount} (included in input tokens)`);
                }
                console.log(`Cost of this request: $${totalCost.toFixed(6)} ($${inputCost.toFixed(6)} for input, $${outputCost.toFixed(6)} for output)`);

                const totalLifetimeInput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.input, 0);
                const totalLifetimeOutput = Object.values(tokenTracking.modelUsage).reduce((sum, usage) => sum + usage.output, 0);
                console.log(`Total lifetime tokens: ${totalLifetimeInput.toLocaleString()} input, ${totalLifetimeOutput.toLocaleString()} output`);
                console.log(`Total lifetime thinking tokens: ${(tokenTracking.lifetimeThinkingTokens || 0).toLocaleString()}`);
                console.log(`Total lifetime tool use tokens: ${(tokenTracking.lifetimeToolUseTokens || 0).toLocaleString()}`);
                
                // Save token data after each update
                saveTokenData();
            }
            
            // Calculate thinking time if extended thinking was enabled
            if (isExtendedThinking && thinkingMessage) {
                const endTime = Date.now();
                const thinkingTime = endTime - startTime;
                const thinkingTimeInSeconds = (thinkingTime / 1000).toFixed(2);
                await thinkingMessage.edit(`Done! Thinking completed in ${thinkingTimeInSeconds}s.`);
            }

            // Enhanced debugging of the response content
            console.log(`Response content types: ${response.content ? response.content.map(item => item.type).join(', ') : 'no content'}`);
            console.log(`Response content length: ${response.content ? response.content.length : 0}`);
            if (response.content && response.content.length > 0) {
                for (let i = 0; i < response.content.length; i++) {
                    console.log(`Item ${i} type: ${response.content[i].type}`);
                    if (response.content[i].type === 'text') {
                        console.log(`Text content length: ${response.content[i].text.length}`);
                    }
                }
            } else {
                console.log("WARNING: Empty response content array");
            }

            // Process the response based on whether it contains thinking content
            let finalResponse = '';
            let thinkingContent = '';
            
            // Handle case where response.content is empty or undefined
            if (!response.content || response.content.length === 0) {
                // Check if we just processed images that might already have descriptions
                if (imageDescriptions) {
                    // Use the image description as the final response
                    finalResponse = imageDescriptions;
                    console.log("Using image description as response since API returned empty content");
                } else {
                    finalResponse = "I received an empty response from the API. This could be due to a temporary issue. Please try your query again or simplify it.";
                }
            } else {
                // Get the text content from the response
                const textContent = response.content.find(item => item.type === 'text');
                
                // If no text content, create a fallback response about tool usage
                if (!textContent || !textContent.text || textContent.text.trim() === '') {
                    const toolCalls = response.content.filter(item => item.type === 'tool_use');
                    if (toolCalls.length > 0) {
                        finalResponse = "I've used my tools to gather information, but something went wrong with generating the final response. The data has been collected successfully, so please ask me to summarize what I found about your query.";
                    } else if (imageDescriptions) {
                        // Also check here if we have image descriptions available
                        finalResponse = imageDescriptions;
                        console.log("Using image description as response since text content is empty");
                    } else {
                        finalResponse = 'I encountered an issue processing your request. This could be due to an error with the API. Please try again with a simpler query.';
                    }
                } else {
                    finalResponse = textContent.text;
                }
            }
            
            // Improved check for thinking content - handle different response formats
            const hasThinkingContent = response.content && response.content.some(item => item.type === 'thinking');
            const thinkingItem = response.content && hasThinkingContent ? response.content.find(item => item.type === 'thinking') : null;
            
            if (hasThinkingContent && thinkingItem) {
                thinkingContent = thinkingItem.thinking;
                
                // If extended thinking is enabled and show thinking process is enabled, show the thinking process
                if (isExtendedThinking && showThinkingProcess) {
                    // Send the thinking process first
                    console.log("Sending thinking process, length:", thinkingContent.length);
                    const thinkingParts = splitMessage(`**My thinking process:**\n\n${thinkingContent}`);
                    for (let i = 0; i < thinkingParts.length; i++) {
                        await message.channel.send(thinkingParts[i]);
                    }
                    
                    // Then send the final response
                    const responseParts = splitMessage(`**My answer:**\n\n${finalResponse}`);
                    for (let i = 0; i < responseParts.length; i++) {
                        if (i === 0) {
                            if (thinkingMessage) {
                                // If we already sent a thinking message, send a new message instead of replying again
                                await message.channel.send(responseParts[i]);
                            } else {
                                await message.reply({
                                    content: responseParts[i],
                                    allowedMentions: { repliedUser: true },
                                });
                            }
                        } else {
                            await message.channel.send(responseParts[i]);
                        }
                    }
                } else {
                    // If extended thinking is not enabled or show thinking process is disabled, just send the final response
                    const messageParts = splitMessage(finalResponse);
                    
                    for (let i = 0; i < messageParts.length; i++) {
                        if (message.channel.type === 1) {
                            // For DMs
                            await message.channel.send(messageParts[i]);
                        } else {
                            // For guild messages
                            if (i === 0 && !thinkingMessage) {
                                // Only reply to the original message if we didn't send a thinking message
                                await message.reply({
                                    content: messageParts[i],
                                    allowedMentions: { repliedUser: true },
                                });
                            } else {
                                await message.channel.send(messageParts[i]);
                            }
                        }
                    }
                }
            } else {
                // Standard response without thinking content
                const messageParts = splitMessage(finalResponse);
                
                for (let i = 0; i < messageParts.length; i++) {
                    if (message.channel.type === 1) {
                        // For DMs
                        await message.channel.send(messageParts[i]);
                    } else {
                        // For guild messages
                        if (i === 0 && !thinkingMessage) {
                            // Only reply to the original message if we didn't send a thinking message
                            await message.reply({
                                content: messageParts[i],
                                allowedMentions: { repliedUser: true },
                            });
                        } else {
                            await message.channel.send(messageParts[i]);
                        }
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
                            content: [`[${message.author.username}]: [Image with query: ${fullInput}]`]
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
            // Check for overloaded error
            if (error.error?.error?.type === 'overloaded_error') {
                await message.reply("Sorry, Claude's servers are currently overloaded. Please try again in a few minutes. 🔄");
            } else {
                await message.reply(`There was an error processing your request.`);
            }
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

// Function to reset token statistics
const resetTokenStats = () => {
    tokenTracking = {
        modelUsage: {
            [SONNET_MODEL]: { input: 0, output: 0 },
            [HAIKU_MODEL]: { input: 0, output: 0 }
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
            thinkingBudget: DEFAULT_THINKING_BUDGET
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
            const budget = options.getInteger('budget');
            if (budget < MIN_THINKING_BUDGET) {
                await interaction.reply({
                    content: `Thinking budget must be at least ${MIN_THINKING_BUDGET} tokens.`,
                    ephemeral: true
                });
            } else {
                userSettings[user.id].thinkingBudget = budget;
                await interaction.reply({
                    content: `Thinking budget set to ${budget} tokens.`,
                    ephemeral: true
                });
            }
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
                    { name: 'AI Models', value: `Default: \`${HAIKU_MODEL}\`\nComplex: \`${SONNET_MODEL}\``, inline: false },
                    { name: 'Normal Max Tokens', value: NORMAL_MAX_TOKENS.toString(), inline: true },
                    { name: 'Extended Max Tokens', value: EXTENDED_THINKING_MAX_TOKENS.toString(), inline: true },
                    { name: 'Automatic Thinking Mode', value: 'Enabled for very complex prompts', inline: false },
                    { name: 'Show Thinking Process', value: userSettings[user.id].showThinkingProcess ? 'ON' : 'OFF', inline: true },
                    { name: 'Thinking Budget', value: userSettings[user.id].thinkingBudget.toString(), inline: true }
                );
                
            // Add token usage fields if the user is the bot creator
            if (isBotOwner) {
                const usageDetails = Object.entries(tokenTracking.modelUsage).map(([model, usage]) => {
                    const modelName = model.split('-').slice(0, 2).join('-'); // Make model name shorter
                    return `**${modelName}**: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`;
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
        if (tokenTracking.modelUsage.hasOwnProperty(model) && MODEL_COSTS[model]) {
            const usage = tokenTracking.modelUsage[model];
            const costs = MODEL_COSTS[model];
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