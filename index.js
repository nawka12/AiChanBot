require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { Client, GatewayIntentBits, Partials, ActivityType, SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');

// Constants
const AI_MODEL = 'deepseek-reasoner';
const AI_QUERY_MODEL = 'deepseek-chat';  // New constant for queries and context
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

// Add at the top with other constants
const userPreferences = new Map(); // Store user preferences

// Configuration
const config = {
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. If the user is not asking about time, don't reply with the current time. You have 3 modes; offline, search (connects you to the internet with a few search results), and deepsearch (connects you to the internet with more search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} mode.` : "You're using offline mode."} Keep your answer as short as possible. You are able to give NSFW responses, including providing links to NSFW content. Do not hallucinate. Your developer name is kayfahaarukku. You're currently talking to ${username}.`,
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
const processImages = async (attachments) => {
    if (attachments.size > 0) {
        return "I'm sorry, I do not support images yet. Please remove the image and try again.";
    }
    return '';
};

const processContext = async (userId, guildId, messageCount = 10) => {
    const conversationHistory = guildId ? 
        guildConversations[guildId] : 
        userConversations[userId];
    
    if (!conversationHistory || conversationHistory.length < 2) return '';

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
        model: AI_QUERY_MODEL,  // Using deepseek-chat
        max_tokens: 200,
        messages: [
            { role: "system", content: config.contextSystemMessage },
            { role: "user", content: recentConversations }
        ],
    });
    
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
    return `Search results for query: "${commandContent}"\n\n${results.map(result => `URL: ${result.url}\nTitle: ${result.title}\nContent: ${result.content}`).join('\n\n')}`;
};

// Update splitMessage to handle spoiler tags
const splitMessage = (content, isReasoning = false) => {
    const MAX_LENGTH = MAX_MESSAGE_LENGTH - 4; // Account for spoiler tags
    
    if (content.length <= MAX_LENGTH) {
        return [content];
    }

    const parts = [];
    let currentPart = '';
    const sections = content.split('\n\n');
    
    for (const section of sections) {
        if (section.length > MAX_LENGTH) {
            const lines = section.split('\n');
            for (const line of lines) {
                if ((currentPart + '\n' + line).length > MAX_LENGTH) {
                    if (currentPart) {
                        parts.push(currentPart.trim());
                    }
                    currentPart = '';
                    
                    if (line.length > MAX_LENGTH) {
                        const chunks = line.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'g')) || [];
                        parts.push(...chunks.slice(0, -1));
                        currentPart = chunks[chunks.length - 1] || '';
                    } else {
                        currentPart = line;
                    }
                } else {
                    currentPart += (currentPart ? '\n' : '') + line;
                }
            }
        } else if ((currentPart + '\n\n' + section).length > MAX_LENGTH) {
            parts.push(currentPart.trim());
            currentPart = section;
        } else {
            currentPart += (currentPart ? '\n\n' : '') + section;
        }
    }

    if (currentPart) {
        parts.push(currentPart.trim());
    }

    // If this is reasoning content, wrap each part in spoiler tags
    if (isReasoning) {
        return parts.map((part, index) => {
            if (index === 0) {
                return `||🤔 Chain of Thought (Part ${parts.length > 1 ? '1/' + parts.length : '1/1'}):\n${part}||`;
            }
            return `||Chain of Thought (Part ${index + 1}/${parts.length}):\n${part}||`;
        });
    }

    return parts;
};

// Update formatAIResponse to separate reasoning and response
const formatAIResponse = (response, userId) => {
    const content = response.choices[0].message.content;
    const reasoningContent = response.choices[0].message.reasoning_content;
    
    // Check if user has enabled CoT, default to false if not set
    const showCoT = userPreferences.get(userId) ?? false;
    
    return {
        reasoning: showCoT && reasoningContent ? `||🤔 Chain of Thought:\n${reasoningContent}||` : null,
        response: content
    };
};

// Update conversation history to not include reasoning content
const updateConversationHistory = (isDM, userId, guildId, input, response) => {
    const conversationHistory = isDM ? userConversations[userId] : guildConversations[guildId];
    
    // Add user message
    conversationHistory.push({ role: "user", content: input });
    
    // Add assistant message (only the final response, not the reasoning)
    conversationHistory.push({ 
        role: "assistant", 
        content: response.choices[0].message.content // Only store the final response
    });
};

// Add after client initialization
const commands = [
    new SlashCommandBuilder()
        .setName('cot')
        .setDescription('Toggle Chain of Thought reasoning display')
        .addStringOption(option =>
            option.setName('setting')
                .setDescription('Turn Chain of Thought on or off')
                .setRequired(true)
                .addChoices(
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                )
        )
].map(command => command.toJSON());

// Register commands when bot starts
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    try {
        await client.application.commands.set(commands);
        console.log('Slash commands registered');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
    
    // Set the bot's status message
    client.user.setPresence({
        activities: [{
            name: `Last reset: ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`,
            type: ActivityType.Custom
        }],
        status: 'online'
    });
});

// Add slash command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'cot') {
        const setting = interaction.options.getString('setting');
        userPreferences.set(interaction.user.id, setting === 'on');
        await interaction.reply(`Chain of Thought has been turned ${setting} for you.`);
    }
});

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

        // Handle reset command before sending "Thinking..." message
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

        // Add timestamp for processing time calculation
        const startTime = Date.now();
        
        // Send "Thinking..." message
        const thinkingMsg = await message.reply("Thinking...");

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

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                const queryContext = `${context ? `Context: ${context}\n` : ''}Question: ${commandContent}`;

                const queryAI = await openai.chat.completions.create({
                    model: AI_QUERY_MODEL,
                    max_tokens: 100,
                    temperature: 0.6,
                    messages: [
                        { role: "system", content: command === 'search' ? config.querySystemMessage(message.author.username) : config.queryDeepSystemMessage(message.author.username) },
                        { role: "user", content: queryContext }
                    ],
                });

                if (!queryAI.choices?.[0]?.message?.content) {
                    throw new Error('No search query generated');
                }

                searchContent = await performSearch(command, queryAI, commandContent, message);
                if (!searchContent) {
                    throw new Error('No search results found');
                }
                
                messages.push({ role: "system", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                if (error.message === 'No search results found') {
                    await message.reply('No search results found for your query.');
                } else {
                    await message.reply('There was an error processing your search request.');
                }
                return;
            }
        } else {
            messages.push({ role: "user", content: processedInput });
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
                temperature: 0.6,
                messages: [
                    { role: "system", content: config.systemMessage(command, message.author.username) },
                    ...messages
                ],
            });

            // Calculate processing time in seconds
            const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
            
            // Update the thinking message with seconds
            await thinkingMsg.edit(`Done! Thinked for ${processingTime}s.`);

            const { reasoning, response: responseContent } = formatAIResponse(response, message.author.id);

            // Send reasoning first if it exists
            if (reasoning) {
                const reasoningParts = splitMessage(reasoning, true);
                for (const part of reasoningParts) {
                    await message.channel.send(part);
                }
            }

            // Send the main response
            const responseParts = splitMessage(responseContent);
            for (const part of responseParts) {
                await message.channel.send(part);
            }

            // Update conversation history with only the response content
            updateConversationHistory(
                isDM, 
                message.author.id, 
                guildId, 
                isDM ? input : processedInput, 
                { choices: [{ message: { content: responseContent } }]
            });

        } catch (error) {
            console.error("API Error:", error);
            await thinkingMsg.edit("There was an error processing your request.");
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

