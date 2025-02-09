require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');

// Constants
const AI_MODEL = "o3-mini";
const MAX_TOKENS = 8192;
const MAX_SEARCH_RESULTS = 3;
const MAX_MESSAGE_LENGTH = 2000;
const DATE_OPTIONS = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
const TIME_OPTIONS = { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta'  // GMT+7 timezone (Indonesia)
};

// Price per million tokens
const PROMPT_TOKEN_PRICE = 1.10;     // $1.10 per million tokens
const COMPLETION_TOKEN_PRICE = 4.40; // $4.40 per million tokens

// Configuration
const config = {
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible. You're currently talking to ${username}.`,
    querySystemMessage: (username) => `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    queryDeepSystemMessage: (username) => `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`,
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

const openai = new OpenAI({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});

// State management
const userConversations = {}; // For DM conversations
const guildConversations = {}; // For guild/server conversations
const userContexts = {};

// Add new variable to store startup time
const startupTime = new Date();

// Helper functions
const processImages = async (attachments, userId, input) => {
    let imageDescriptions = [];

    for (const [, attachment] of attachments) {
        if (attachment.contentType.startsWith('image/')) {
            const imageResponse = await fetch(attachment.url);
            const imageBuffer = await imageResponse.buffer();
            const base64Image = imageBuffer.toString('base64');

            const imageAI = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: input || "What's in this image?" },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${attachment.contentType};base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_completion_tokens: MAX_TOKENS
            });

            const imageDescription = imageAI.choices[0].message.content;
            imageDescriptions.push(imageDescription);

            // Add image description to the conversation history
            if (!userConversations[userId]) {
                userConversations[userId] = [];
            }
            userConversations[userId].push({ role: "user", content: `[Image] ${input}` });
            userConversations[userId].push({ role: "assistant", content: imageDescription });
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

    const contextResponse = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
            { role: "system", content: config.contextSystemMessage },
            { role: "user", content: recentConversations }
        ],
        max_completion_tokens: 200
    });
    
    const contextSummary = contextResponse.choices[0].message.content;
    console.log(`Generated context for ${userId}:`, contextSummary);
    return contextSummary;
};

const performSearch = async (command, queryResponse, commandContent, message) => {
    if (command === 'search') {
        let finalQuery = queryResponse.choices[0].message.content.trim();
        
        // Fallback: if no query generated, use the original commandContent
        if (!finalQuery) {
            console.warn("Query generation returned empty. Falling back to commandContent as query.");
            finalQuery = commandContent;
        }
        
        console.log('Search query:', finalQuery);
        await message.channel.send(`Searching the web for \`${finalQuery}\``);
        const searchResult = await searchQuery(finalQuery);
        
        if (!searchResult || !searchResult.results) {
            throw new Error('Invalid search results structure');
        }
        
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        let queriesRaw = queryResponse.choices[0].message.content;
        if (!queriesRaw.trim()) {
            console.warn("Query generation returned empty for deepsearch. Falling back to commandContent.");
            queriesRaw = commandContent;
        }
        const queries = queriesRaw.split(',').map(q => q.trim()).filter(q => q);
        
        if (!queries.length) {
            throw new Error('Empty search queries generated');
        }
        
        let allResults = [];
        
        for (let query of queries) {
            console.log('Deep search query:', query);
            await message.channel.send(`Searching the web for \`${query}\``);
            const searchResult = await searchQuery(query);
            
            if (!searchResult || !searchResult.results) {
                throw new Error('Invalid search results structure');
            }
            
            allResults = allResults.concat(searchResult.results.slice(0, MAX_SEARCH_RESULTS));
        }
        
        return formatSearchResults(allResults, commandContent);
    }
};

const formatSearchResults = (results, commandContent) => {
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
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

// Main message handler
client.on('messageCreate', async function(message) {
    try {
        if (message.author.bot || message.content.includes('@everyone') || message.content.includes('@here')) return;

        // Allow both DMs and mentions in servers
        if (message.channel.type !== 1 && !message.mentions.has(client.user)) return;

        const isDM = message.channel.type === 1;
        const guildId = isDM ? null : message.guild.id;

        // Modify the input to include username for guild messages
        const processedInput = isDM ? 
            message.content : 
            `[${message.author.username}]: ${message.content}`;

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

        message.channel.sendTyping();

        const input = processedInput
            .replace(`<@${client.user.id}>`, '')
            .replace(/<@&\d+>/g, '')
            .trim();
        const [rawCommand, ...contentParts] = input.split(' ');
        const command = rawCommand.toLowerCase();
        const commandContent = contentParts.join(' ');

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
                imageDescriptions = await processImages(message.attachments, message.author.id, input);
                console.log(`Images processed. Descriptions: ${imageDescriptions}`);
                
                // If it's offline mode, send the image descriptions as the response
                if (command !== 'search' && command !== 'deepsearch') {
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

        // Initialize user data if it doesn't exist
        if (!userContexts[message.author.id]) userContexts[message.author.id] = '';
        if (!userConversations[message.author.id]) userConversations[message.author.id] = [];

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                // Build query context using any existing conversation context and/or image descriptions
                const queryContext = `${context ? `Context: ${context}\n` : ''}${
                    imageDescriptions ? `Image descriptions: ${imageDescriptions}\n` : ''
                }Question: ${commandContent}`;

                console.log('Query Context:', queryContext);

                const queryResponse = await openai.chat.completions.create({
                    model: AI_MODEL,
                    messages: [
                        {
                            role: "developer",
                            content: command === 'search'
                                ? config.querySystemMessage(message.author.username)
                                : config.queryDeepSystemMessage(message.author.username)
                        },
                        { role: "user", content: queryContext }
                    ],
                    max_completion_tokens: 100
                });
                
                console.log('Query Response:', queryResponse.choices[0].message.content);

                searchContent = await performSearch(command, queryResponse, commandContent, message);
                messages.push({ role: "user", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                await message.reply(`There was an error processing your search request: ${error.message}`);
                return;
            }
        } else {
            messages.push({ role: "user", content: input });
            if (imageDescriptions) {
                messages.push({ role: "assistant", content: imageDescriptions });
            }
            if (userConversations[message.author.id].length >= 2) {
                userContexts[message.author.id] = await processContext(message.author.id, guildId, 10);
            }
        }

        messages = [...userConversations[message.author.id], ...messages];
        messages = messages.filter((message, index, self) =>
            index === self.findIndex((t) => t.role === message.role && t.content === message.content)
        );

        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

        try {
            const gptResponse = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: [
                    { role: "developer", content: config.systemMessage(command, message.author.username) },
                    ...messages
                ],
                max_completion_tokens: MAX_TOKENS
            });

            userConversations[message.author.id].push({ role: "user", content: input });
            userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

            const messageParts = splitMessage(gptResponse.choices[0].message.content);

            // Calculate token usage and cost
            const promptTokens = gptResponse.usage.prompt_tokens;
            const completionTokens = gptResponse.usage.completion_tokens;
            const totalTokens = gptResponse.usage.total_tokens;
            const cost = (
                (promptTokens * (PROMPT_TOKEN_PRICE / 1000000)) + 
                (completionTokens * (COMPLETION_TOKEN_PRICE / 1000000))
            ).toFixed(6);
            const usageInfo = `\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``;

            for (let i = 0; i < messageParts.length; i++) {
                const content = i === messageParts.length - 1 
                    ? `${messageParts[i]}\n\n${usageInfo}`
                    : messageParts[i];

                if (i === 0) {
                    await message.reply({
                        content,
                        allowedMentions: { repliedUser: true },
                    });
                } else {
                    await message.channel.send(content);
                }
            }
        } catch (error) {
            console.error("API Error:", error);
            await message.reply(`There was an error processing your request.`);
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

// Add a ready event handler to verify intents
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Set the bot's status message
    client.user.setPresence({
        activities: [{
            name: `Last reset: ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`,
            type: ActivityType.Custom
        }],
        status: 'online'
    });
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
