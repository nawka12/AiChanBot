require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { scrapeMultipleUrls } = require('./scraper.js');
const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Constants
const AI_MODEL = 'claude-3-7-sonnet-latest';

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
const MAX_SEARCH_RESULTS = 3;
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
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeCacheCreationInputTokens: 0,
    lifetimeCacheReadInputTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    trackingSince: new Date().toISOString() // Add tracking start date
};

// Load token tracking data if it exists
try {
    if (fs.existsSync(TOKEN_DATA_FILE)) {
        const data = fs.readFileSync(TOKEN_DATA_FILE, 'utf8');
        tokenTracking = JSON.parse(data);
        console.log('Loaded token tracking data from file');
    } else {
        console.log('No token tracking data file found, starting with zero counts');
    }
} catch (error) {
    console.error('Error loading token tracking data:', error);
}

// Function to save token tracking data
const saveTokenData = () => {
    try {
        fs.writeFileSync(TOKEN_DATA_FILE, JSON.stringify(tokenTracking, null, 2), 'utf8');
        console.log('Token tracking data saved to file');
    } catch (error) {
        console.error('Error saving token tracking data:', error);
    }
};

// Token cost constants (per million tokens)
const INPUT_TOKEN_COST_PER_MILLION = 3;
const OUTPUT_TOKEN_COST_PER_MILLION = 15;

// Configuration
const config = {
    systemMessage: (command, username, extendedThinking) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. You have 5 modes; offline, search (connects you to the internet with a few search results), deepsearch (connects you to the internet with more search results), webscrape (connects you to the internet with detailed content from web pages), and thinking (uses extended thinking for complex problems). ${command === 'search' || command === 'deepsearch' || command === 'webscrape' ? `You're connected to the internet with ${command} mode.` : extendedThinking ? "You're using extended thinking mode to solve complex problems." : "You're using offline mode."} ${extendedThinking ? "You're using extended thinking mode, which means you'll show your step-by-step reasoning process before providing your final answer." : ""} Keep your answer as short as possible. You are able to give NSFW responses, including providing links to NSFW content. Your developer name is kayfahaarukku. You're currently talking to ${username}.`,
    querySystemMessage: (username) => `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    queryDeepSystemMessage: (username) => `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
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

            const imageAI = await anthropic.messages.create({
                model: AI_MODEL,
                max_tokens: NORMAL_MAX_TOKENS,
                system: `${config.systemMessage('offline', userId, false)} Describe the image concisely and answer the user's question if provided.`,
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
        }
    }

    return imageDescriptions.join('\n\n');
};

const processContext = async (userId, guildId, messageCount = 10) => {
    const conversationHistory = guildId ? 
        guildConversations[guildId] : 
        userConversations[userId];
    
    if (!conversationHistory || conversationHistory.length < 2) return '';

    // Take last N messages instead of just 2
    const recentConversations = conversationHistory
        .slice(-messageCount)
        .map(conv => {
            if (typeof conv.content === 'string') {
                return conv.content;
            } else if (Array.isArray(conv.content)) {
                return conv.content.map(item => 
                    item.type === 'text' ? item.text : '[Image]'
                ).join(' ');
            }
            return JSON.stringify(conv.content);
        })
        .join('\n');

    const contextAI = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 200,
        system: config.contextSystemMessage,
        messages: [
            {"role": "user", "content": recentConversations}
        ],
    });
    
    const contextSummary = contextAI.content[0].text;
    console.log(`Generated context for ${userId}:`, contextSummary);
    return contextSummary;
};

const performSearch = async (command, queryAI, commandContent, message) => {
    if (command === 'search') {
        const finalQuery = queryAI.content[0].text;
        await message.channel.send(`Searching the web for \`${finalQuery}\``);
        const searchResult = await searchQuery(finalQuery);
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        const queries = queryAI.content[0].text.split(',').map(q => q.trim());
        let allResults = [];
        const seenUrls = new Set(); // Keep track of URLs we've already added
        
        for (let query of queries) {
            await message.channel.send(`Searching the web for \`${query}\``);
            const searchResult = await searchQuery(query);
            
            // Try to get MAX_SEARCH_RESULTS unique results from each query
            let uniqueResults = [];
            let resultsIndex = 0;
            
            // Loop through search results until we have enough unique results
            // or until we've gone through all available results
            while (uniqueResults.length < MAX_SEARCH_RESULTS && resultsIndex < searchResult.results.length) {
                const result = searchResult.results[resultsIndex];
                
                // Only add results with URLs we haven't seen before
                if (!seenUrls.has(result.url)) {
                    uniqueResults.push(result);
                    seenUrls.add(result.url);
                } else {
                    // Log when a result is skipped due to duplication
                    console.log(`Skipped duplicate result: ${result.url} from query "${query}"`);
                }
                
                resultsIndex++;
            }
            
            // Add unique results to our collection
            allResults = allResults.concat(uniqueResults);
            
            // If we couldn't find enough unique results, log a message
            if (uniqueResults.length < MAX_SEARCH_RESULTS) {
                console.log(`Query "${query}" returned ${uniqueResults.length} unique results after deduplication.`);
            }
        }
        
        return formatSearchResults(allResults, commandContent);
    } else if (command === 'webscrape') {
        // Use a single query like the search command
        const finalQuery = queryAI.content[0].text;
        await message.channel.send(`Searching the web for \`${finalQuery}\``);
        const searchResult = await searchQuery(finalQuery);
        
        // Get more results from search to have backups in case scraping fails
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS * 3); // Get 9 results instead of 3
        
        // Extract URLs from search results for scraping
        const urls = results.map(result => result.url);
        
        // Scrape content from URLs
        await message.channel.send(`Scraping content from up to 3 websites (will try additional sites if some fail)...`);
        const scrapedResults = await scrapeMultipleUrls(urls);
        
        // Format scraped content for Claude
        return formatScrapedResults(scrapedResults, commandContent);
    }
};

const formatSearchResults = (results, commandContent) => {
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
};

const formatScrapedResults = (scrapedResults, commandContent) => {
    // Calculate successful scrapes
    const successfulScrapes = scrapedResults.filter(result => 
        !result.title.includes('Error') && result.content.length > 100
    ).length;
    
    let formattedContent = `Here's detailed content from ${successfulScrapes}/${scrapedResults.length} web pages regarding my question:\n\n`;
    
    // No content length limits per source as requested
    
    scrapedResults.forEach((result, index) => {
        formattedContent += `--- SOURCE ${index + 1} ---\n`;
        formattedContent += `URL: ${result.url}\n`;
        formattedContent += `TITLE: ${result.title}\n`;
        formattedContent += `CONTENT: ${result.content}\n\n`;
    });
    
    formattedContent += `My question is: ${commandContent}`;
    
    // No total length limit as requested
    
    return formattedContent;
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
        .setName('thinking')
        .setDescription('Toggle thinking mode on or off')
        .addStringOption(option => 
            option.setName('mode')
                .setDescription('Enable or disable thinking mode')
                .setRequired(true)
                .addChoices(
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                )),
    new SlashCommandBuilder()
        .setName('thinking_process')
        .setDescription('Toggle whether to show the thinking process')
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

        // Preserve newlines in the original message but create a version without them for command detection
        const inputForCommandDetection = input.replace(/\n+/g, ' ');
        
        // Check if the message is a reply to another message
        let replyContext = '';
        if (message.reference && message.reference.messageId) {
            try {
                const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                const repliedAuthor = repliedMessage.author.bot ? 
                    (repliedMessage.author.id === client.user.id ? 'You (Ai-chan)' : 'Another bot') : 
                    repliedMessage.author.username;
                
                // Check if the replied message has attachments
                let attachmentInfo = '';
                if (repliedMessage.attachments.size > 0) {
                    const attachmentTypes = Array.from(repliedMessage.attachments.values())
                        .map(attachment => {
                            if (attachment.contentType.startsWith('image/')) return 'image';
                            if (attachment.contentType.startsWith('video/')) return 'video';
                            if (attachment.contentType.startsWith('audio/')) return 'audio';
                            return 'file';
                        });
                    attachmentInfo = ` [with ${attachmentTypes.join(', ')}]`;
                }
                
                // Handle empty content with attachments case
                let messageContent = repliedMessage.content.trim();
                if (!messageContent && attachmentInfo) {
                    messageContent = "[Media content]";
                }
                
                // Use the full message content without trimming to 150 characters
                replyContext = `[In reply to ${repliedAuthor}${attachmentInfo}: "${messageContent}"] `;
                console.log(`Reply context: ${replyContext}`);
            } catch (error) {
                console.error("Error fetching replied message:", error);
            }
        }
        
        // Extract command BEFORE combining with reply context
        const [rawCommand, ...contentParts] = inputForCommandDetection.split(' ');
        const command = rawCommand.toLowerCase();
        const commandContent = contentParts.join(' ');

        // Combine reply context with user input AFTER command extraction
        let fullInput = input;
        if (replyContext) {
            fullInput = `${replyContext}${input}`;
        }

        const isDM = message.channel.type === 1;
        const guildId = isDM ? null : message.guild.id;
        const userId = message.author.id;

        // Initialize user settings if they don't exist
        if (!userSettings[userId]) {
            userSettings[userId] = {
                extendedThinking: false,
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

        // Handle reset command
        if (command === 'reset') {
            if (isDM) {
                userConversations[message.author.id] = [];
                await message.reply("Ai-chan's personal conversations with you have been reset.");
            } else {
                guildConversations[guildId] = [];
                await message.reply("Ai-chan's server conversations have been reset.");
            }
            return;
        }

        let imageDescriptions = '';
        if (message.attachments.size > 0) {
            try {
                imageDescriptions = await processImages(message.attachments, message.author.id, guildId, fullInput);
                console.log(`Images processed. Descriptions: ${imageDescriptions}`);
                
                // If it's offline mode, send the image descriptions as the response
                if (command !== 'search' && command !== 'deepsearch' && command !== 'webscrape') {
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
                    return; // Exit the function here for offline mode with images
                }
            } catch (error) {
                console.error("Error processing images:", error);
                await message.reply("Sorry, there was an error processing the images.");
                return;
            }
        }

        let messages = [];
        let searchContent = '';
        
        // Check if extended thinking is enabled for this user
        const isExtendedThinking = userSettings[userId].extendedThinking;
        const showThinkingProcess = userSettings[userId].showThinkingProcess;
        const thinkingBudget = userSettings[userId].thinkingBudget;

        if (command === 'search' || command === 'deepsearch' || command === 'webscrape') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                // Build a more comprehensive query context that includes reply information
                const queryContext = `${context ? `Context: ${context}\n` : ''}${
                    replyContext ? `Reply context: ${replyContext}\n` : ''
                }${
                    imageDescriptions ? `Image descriptions: ${imageDescriptions}\n` : ''
                }Question: ${commandContent}`;

                // Use appropriate system message based on the command
                const querySystemMessage = command === 'deepsearch' ? 
                    config.queryDeepSystemMessage(message.author.username) : 
                    config.querySystemMessage(message.author.username);
                
                const queryAI = await anthropic.messages.create({
                    model: AI_MODEL,
                    max_tokens: 1024,
                    temperature: 0.7,
                    system: querySystemMessage,
                    messages: [
                        {"role": "user", "content": queryContext}
                    ],
                });

                searchContent = await performSearch(command, queryAI, commandContent, message);
                messages.push({ role: "user", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                await message.reply(`There was an error processing your search request.`);
                return;
            }
        } else {
            messages.push({ role: "user", content: processedInput });
            if (imageDescriptions) {
                messages.push({ role: "assistant", content: imageDescriptions });
            }
        }

        // Get the appropriate conversation history
        const conversationHistory = isDM ? 
            userConversations[message.author.id] : 
            guildConversations[guildId];
        
        messages = [...conversationHistory, ...messages];

        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

        try {
            // Create API request parameters
            const apiParams = {
                model: AI_MODEL,
                max_tokens: isExtendedThinking ? EXTENDED_THINKING_MAX_TOKENS : NORMAL_MAX_TOKENS,
                system: config.systemMessage(command, message.author.username, isExtendedThinking),
                messages: messages,
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
            const response = await anthropic.messages.create(apiParams);
            
            // Track token usage
            if (response.usage) {
                const previousInputTokens = tokenTracking.lifetimeInputTokens;
                const previousOutputTokens = tokenTracking.lifetimeOutputTokens;
                
                tokenTracking.lifetimeInputTokens += response.usage.input_tokens || 0;
                tokenTracking.lifetimeOutputTokens += response.usage.output_tokens || 0;
                
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
                
                // Calculate token increase
                const inputIncrease = tokenTracking.lifetimeInputTokens - previousInputTokens;
                const outputIncrease = tokenTracking.lifetimeOutputTokens - previousOutputTokens;
                
                // Calculate costs
                const inputCost = (inputIncrease / 1000000) * INPUT_TOKEN_COST_PER_MILLION;
                const outputCost = (outputIncrease / 1000000) * OUTPUT_TOKEN_COST_PER_MILLION;
                const totalCost = inputCost + outputCost;
                
                console.log(`Token usage - Input: ${response.usage.input_tokens}, Output: ${response.usage.output_tokens}${cacheInfo}`);
                console.log(`Cost of this request: $${totalCost.toFixed(6)} ($${inputCost.toFixed(6)} for input, $${outputCost.toFixed(6)} for output)`);
                console.log(`Total lifetime tokens: ${tokenTracking.lifetimeInputTokens.toLocaleString()} input, ${tokenTracking.lifetimeOutputTokens.toLocaleString()} output`);
                
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

            // Process the response based on whether it contains thinking content
            let finalResponse = '';
            let thinkingContent = '';
            
            // Check if the response has thinking content
            if (response.content.length > 1 && response.content[0].type === 'thinking') {
                thinkingContent = response.content[0].thinking;
                finalResponse = response.content[1].text;
                
                // If extended thinking is enabled and show thinking process is enabled, show the thinking process
                if (isExtendedThinking && showThinkingProcess) {
                    // Send the thinking process first
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
                finalResponse = response.content[0].text;
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
                userConversations[message.author.id].push({ role: "user", content: fullInput });
                userConversations[message.author.id].push({ 
                    role: "assistant", 
                    content: finalResponse 
                });
            } else {
                guildConversations[guildId].push({ role: "user", content: processedInput });
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
        lifetimeInputTokens: 0,
        lifetimeOutputTokens: 0,
        lifetimeCacheCreationInputTokens: 0,
        lifetimeCacheReadInputTokens: 0,
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
            extendedThinking: false,
            showThinkingProcess: false,
            thinkingBudget: DEFAULT_THINKING_BUDGET
        };
    }
    
    try {
        if (commandName === 'thinking') {
            const mode = options.getString('mode');
            userSettings[user.id].extendedThinking = mode === 'on';
            await interaction.reply({
                content: `Thinking mode is now ${mode === 'on' ? 'ON' : 'OFF'}.`,
                ephemeral: true
            });
        } else if (commandName === 'thinking_process') {
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
            
            console.log(`Token statistics reset by ${user.username} (${user.id}). Previous data: ${tokenTracking.lifetimeInputTokens.toLocaleString()} input tokens, ${tokenTracking.lifetimeOutputTokens.toLocaleString()} output tokens since ${formatTrackingDate(tokenTracking.trackingSince)}`);
            
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
                       
            const avgInputTokens = (tokenTracking.lifetimeInputTokens / totalMessages).toFixed(0);
            const avgOutputTokens = (tokenTracking.lifetimeOutputTokens / totalMessages).toFixed(0);
            
            // Check if the user is the bot creator to show more detailed info
            const isBotOwner = isBotCreator(user.id);
            
            // Create an embed with the bot's status information
            const statusEmbed = new EmbedBuilder()
                .setColor(0x00AAFF)
                .setTitle('Ai-chan Status')
                .setDescription(`Current configuration and status information${isBotOwner ? ' (Owner View)' : ''}`)
                .setThumbnail(client.user.displayAvatarURL())
                .addFields(
                    { name: 'AI Model', value: AI_MODEL, inline: true },
                    { name: 'Normal Max Tokens', value: NORMAL_MAX_TOKENS.toString(), inline: true },
                    { name: 'Extended Max Tokens', value: EXTENDED_THINKING_MAX_TOKENS.toString(), inline: true },
                    { name: 'Thinking Mode', value: userSettings[user.id].extendedThinking ? 'ON' : 'OFF', inline: true },
                    { name: 'Show Thinking Process', value: userSettings[user.id].showThinkingProcess ? 'ON' : 'OFF', inline: true },
                    { name: 'Thinking Budget', value: userSettings[user.id].thinkingBudget.toString(), inline: true }
                );
                
            // Only show token usage to bot owner
            if (isBotOwner) {
                statusEmbed.addFields(
                    { name: 'Tracking Since', value: formatTrackingDate(tokenTracking.trackingSince), inline: false },
                    { name: 'Lifetime Input Tokens', value: tokenTracking.lifetimeInputTokens.toLocaleString(), inline: true },
                    { name: 'Lifetime Output Tokens', value: tokenTracking.lifetimeOutputTokens.toLocaleString(), inline: true },
                    { name: 'Total Tokens', value: (tokenTracking.lifetimeInputTokens + tokenTracking.lifetimeOutputTokens).toLocaleString(), inline: true },
                    { name: 'Avg. Input / Message', value: avgInputTokens, inline: true },
                    { name: 'Avg. Output / Message', value: avgOutputTokens, inline: true },
                    { name: 'Input Cost', value: `$${costs.inputCost} ($3/M)`, inline: true },
                    { name: 'Output Cost', value: `$${costs.outputCost} ($15/M)`, inline: true },
                    { name: 'Total Cost', value: `$${costs.totalCost}`, inline: true },
                    { name: 'Total Messages', value: totalMessages.toString(), inline: true }
                );
                
                // Add cache information if there are any cache hits or misses
                if (tokenTracking.cacheHits > 0 || tokenTracking.cacheMisses > 0) {
                    const cacheHitRate = (tokenTracking.cacheHits / (tokenTracking.cacheHits + tokenTracking.cacheMisses) * 100).toFixed(2);
                    const cacheSavings = (tokenTracking.lifetimeCacheReadInputTokens * INPUT_TOKEN_COST_PER_MILLION / 1000000).toFixed(4);
                    
                    statusEmbed.addFields(
                        { name: 'Cache Hits', value: tokenTracking.cacheHits.toString(), inline: true },
                        { name: 'Cache Misses', value: tokenTracking.cacheMisses.toString(), inline: true },
                        { name: 'Cache Hit Rate', value: `${cacheHitRate}%`, inline: true },
                        { name: 'Cache Creation Tokens', value: tokenTracking.lifetimeCacheCreationInputTokens.toLocaleString(), inline: true },
                        { name: 'Cache Read Tokens', value: tokenTracking.lifetimeCacheReadInputTokens.toLocaleString(), inline: true },
                        { name: 'Est. Cache Savings', value: `$${cacheSavings}`, inline: true }
                    );
                }
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
    console.log(`Token tracking active since: ${formatTrackingDate(tokenTracking.trackingSince)}`);
    console.log(`Current token counts: ${tokenTracking.lifetimeInputTokens.toLocaleString()} input, ${tokenTracking.lifetimeOutputTokens.toLocaleString()} output`);
    
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
    const inputCost = (tokenTracking.lifetimeInputTokens / 1000000) * INPUT_TOKEN_COST_PER_MILLION;
    const outputCost = (tokenTracking.lifetimeOutputTokens / 1000000) * OUTPUT_TOKEN_COST_PER_MILLION;
    return {
        inputCost: inputCost.toFixed(4),
        outputCost: outputCost.toFixed(4),
        totalCost: (inputCost + outputCost).toFixed(4)
    };
};