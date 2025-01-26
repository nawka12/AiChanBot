require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');

// Constants
const AI_MODEL = 'deepseek-reasoner';
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
const MAX_REASONING_TOKENS = 32768; // Maximum tokens for Chain of Thought reasoning

// Add new variable to store startup time
const startupTime = new Date();

// Configuration
const config = {
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. You have 3 modes; offline, search (connects you to the internet with a few search results), and deepsearch (connects you to the internet with more search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} mode.` : "You're using offline mode."} Keep your answer as short as possible. You are able to give NSFW responses, including providing links to NSFW content. Your developer name is kayfahaarukku. You're currently talking to ${username}.`,
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

const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
});

// State management
const userConversations = {}; // For DM conversations
const guildConversations = {}; // For guild/server conversations

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

            const imageAI = await openai.chat.completions.create({
                model: AI_MODEL,
                max_tokens: MAX_TOKENS,
                messages: [
                    { role: "system", content: `${config.systemMessage('offline', userId)} Describe the image concisely and answer the user's question if provided.` },
                    ...conversationHistory,
                    {
                        role: "user",
                        content: `[Image URL: ${attachment.url}] ${input || "What's in this image?"}`
                    }
                ]
            });

            const imageDescription = formatAIResponse(imageAI);
            imageDescriptions.push(imageDescription);

            // Update conversation history - store only the content, not reasoning
            const historyEntry = {
                role: "assistant",
                content: imageAI.choices[0].message.content
            };

            if (guildId) {
                if (!guildConversations[guildId]) {
                    guildConversations[guildId] = [];
                }
                guildConversations[guildId].push({
                    role: "user",
                    content: [{ type: "text", text: `[Image] ${input}` }]
                });
                guildConversations[guildId].push(historyEntry);
            } else {
                if (!userConversations[userId]) {
                    userConversations[userId] = [];
                }
                userConversations[userId].push({
                    role: "user",
                    content: [{ type: "text", text: `[Image] ${input}` }]
                });
                userConversations[userId].push(historyEntry);
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

    const contextAI = await openai.chat.completions.create({
        model: AI_MODEL,
        max_tokens: 200,
        messages: [
            { role: "system", content: config.contextSystemMessage },
            { role: "user", content: recentConversations }
        ],
    });
    
    // Only use the final content, not reasoning, for context
    const contextSummary = contextAI.choices[0].message.content;
    console.log(`Generated context for ${userId}:`, contextSummary);
    return contextSummary;
};

const performSearch = async (command, queryAI, commandContent, message) => {
    if (command === 'search') {
        const finalQuery = queryAI.choices[0].message.content;
        await message.channel.send(`Searching the web for \`${finalQuery}\``);
        const searchResult = await searchQuery(finalQuery);
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        const queries = queryAI.choices[0].message.content.split(',').map(q => q.trim());
        let allResults = [];
        
        for (let query of queries) {
            await message.channel.send(`Searching the web for \`${query}\``);
            const searchResult = await searchQuery(query);
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

// Helper function to format AI response
const formatAIResponse = (response) => {
    const reasoning = response.choices[0].message.reasoning_content;
    const content = response.choices[0].message.content;
    
    // If there's reasoning content, format it with the final answer
    if (reasoning) {
        return `**Reasoning:**\n${reasoning}\n\n**Answer:**\n${content}`;
    }
    return content;
};

// Main message handler
client.on('messageCreate', async function(message) {
    try {
        // If it's a bot message or @everyone/@here, ignore it
        if (message.author.bot || message.content.includes('@everyone') || message.content.includes('@here')) return;

        // Allow both DMs and mentions in servers
        if (message.channel.type !== 1 && !message.mentions.has(client.user)) return;

        message.channel.sendTyping();

        const input = message.content
            .replace(`<@${client.user.id}>`, '')
            .replace(/<@&\d+>/g, '')
            .trim()
            .replace(/\n+/g, ' ');
        const [rawCommand, ...contentParts] = input.split(' ');
        const command = rawCommand.toLowerCase();
        const commandContent = contentParts.join(' ');

        const isDM = message.channel.type === 1;
        const guildId = isDM ? null : message.guild.id;

        // Modify the input to include username for guild messages
        const processedInput = isDM ? 
            input : 
            `[${message.author.username}]: ${input}`;

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
                imageDescriptions = await processImages(message.attachments, message.author.id, guildId, input);
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

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                const queryContext = `${context ? `Context: ${context}\n` : ''}${
                    imageDescriptions ? `Image descriptions: ${imageDescriptions}\n` : ''
                }Question: ${commandContent}`;

                const queryAI = await openai.chat.completions.create({
                    model: AI_MODEL,
                    max_tokens: 100,
                    temperature: 0.7,
                    messages: [
                        { role: "system", content: command === 'search' ? config.querySystemMessage(message.author.username) : config.queryDeepSystemMessage(message.author.username) },
                        { role: "user", content: queryContext }
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
            const response = await openai.chat.completions.create({
                model: AI_MODEL,
                max_tokens: MAX_TOKENS,
                messages: [
                    { role: "system", content: config.systemMessage(command, message.author.username) },
                    ...messages
                ],
            });

            // Format response with reasoning if available
            const responseContent = formatAIResponse(response);

            // Update conversation history with only the content, not reasoning
            if (isDM) {
                userConversations[message.author.id].push({ role: "user", content: input });
                userConversations[message.author.id].push({ 
                    role: "assistant", 
                    content: response.choices[0].message.content  // Store only final content
                });
            } else {
                guildConversations[guildId].push({ role: "user", content: processedInput });
                guildConversations[guildId].push({ 
                    role: "assistant", 
                    content: response.choices[0].message.content  // Store only final content
                });
            }

            const messageParts = splitMessage(responseContent);

            for (let i = 0; i < messageParts.length; i++) {
                if (message.channel.type === 1) {
                    // For DMs
                    await message.channel.send(messageParts[i]);
                } else {
                    // For guild messages
                    if (i === 0) {
                        await message.reply({
                            content: messageParts[i],
                            allowedMentions: { repliedUser: true },
                        });
                    } else {
                        await message.channel.send(messageParts[i]);
                    }
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

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");

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
