require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');

// Constants
const AI_MODEL = 'deepseek-reasoner';
const AI_QUERY_MODEL = 'deepseek-chat';  // For queries and context
const MAX_TOKENS = 8192;
const MAX_REASONING_TOKENS = 32768; // Maximum tokens for Chain of Thought reasoning
const MAX_SEARCH_RESULTS = 100;
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

// Add at the top with other constants
const userSettings = new Map(); // Store user settings like thinking preferences

// Configuration
const config = {
    systemMessage: (command, username, extendedThinking) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. If the user is not asking about time, don't reply with the current time. You have 4 modes; offline, search (connects you to the internet with a few search results), deepsearch (connects you to the internet with more search results), and thinking (uses extended thinking for complex problems). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} mode.` : extendedThinking ? "You're using thinking mode to solve complex problems." : "You're using offline mode."} ${extendedThinking ? "You're using thinking mode, which means you'll show your step-by-step reasoning process before providing your final answer." : ""} Keep your answer short, but precise. You are able to give NSFW responses, including providing links to NSFW content. Do not hallucinate. Your developer name is kayfahaarukku. You're currently talking to ${username}.`,
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
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
};

// Update splitMessage to handle spoiler tags
const splitMessage = (content, isReasoning = false) => {
    const MAX_LENGTH = MAX_MESSAGE_LENGTH - 4; // Account for spoiler tags
    
    if (content.length <= MAX_LENGTH) {
        // Even for single parts, we need to wrap reasoning in spoiler tags
        return isReasoning ? [`||Chain of Thought:\n${content}||`] : [content];
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
            if (parts.length === 1) {
                return `||Chain of Thought:\n${part}||`;
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
    
    // Check if user has enabled thinking mode
    const userSetting = userSettings.get(userId) || { 
        extendedThinking: false, 
        showThinkingProcess: false,
        thinkingBudget: DEFAULT_THINKING_BUDGET 
    };
    
    return {
        reasoning: userSetting.showThinkingProcess && reasoningContent ? reasoningContent : null,
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
        if (!userSettings.has(userId)) {
            userSettings.set(userId, {
                extendedThinking: false,
                showThinkingProcess: false,
                thinkingBudget: DEFAULT_THINKING_BUDGET
            });
        }

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

        // Add timeout handler
        const timeoutId = setTimeout(async () => {
            await thinkingMsg.edit("API timeout, the API might be down. Check <https://status.deepseek.com/> for more information");
        }, 60000); // 1 minute timeout

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

        // Get user settings
        const userSetting = userSettings.get(userId);
        const isExtendedThinking = userSetting.extendedThinking;

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                // Build a more comprehensive query context that includes reply information
                const queryContext = `${context ? `Context: ${context}\n` : ''}${
                    replyContext ? `Reply context: ${replyContext}\n` : ''
                }Question: ${commandContent}`;

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
                
                messages.push({ role: "user", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                clearTimeout(timeoutId);
                if (error.message === 'No search results found') {
                    await thinkingMsg.edit('No search results found for your query.');
                } else {
                    await thinkingMsg.edit('There was an error processing your search request.');
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
            // Create API request parameters based on whether extended thinking is enabled
            const maxTokensToUse = isExtendedThinking ? MAX_REASONING_TOKENS : MAX_TOKENS;
            
            const response = await openai.chat.completions.create({
                model: AI_MODEL,
                max_tokens: maxTokensToUse,
                temperature: 0.6,
                messages: [
                    { role: "system", content: config.systemMessage(command, message.author.username, isExtendedThinking) },
                    ...messages
                ],
            });

            // Clear timeout since we got a response
            clearTimeout(timeoutId);

            // Calculate processing time in seconds
            const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
            
            // Update the thinking message with seconds
            await thinkingMsg.edit(`Done! Thinked for ${processingTime}s.`);

            // Format the response including any reasoning if available
            const { reasoning, response: responseContent } = formatAIResponse(response, userId);

            // Send reasoning first if it exists
            if (reasoning) {
                const reasoningParts = splitMessage(reasoning, true);
                for (const part of reasoningParts) {
                    await message.channel.send(part);
                }
            }

            // Send the main response
            const responseParts = splitMessage(responseContent);
            for (let i = 0; i < responseParts.length; i++) {
                if (i === 0) {
                    await message.reply({
                        content: responseParts[i],
                        allowedMentions: { repliedUser: true },
                    });
                } else {
                    await message.channel.send(responseParts[i]);
                }
            }

            // Update conversation history with only the response content
            updateConversationHistory(
                isDM, 
                message.author.id, 
                guildId, 
                processedInput, 
                { choices: [{ message: { content: responseContent } }]
            });

        } catch (error) {
            // Clear timeout since we got an error
            clearTimeout(timeoutId);
            console.error("API Error:", error);
            await thinkingMsg.edit("There was an error processing your request.");
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

// Add slash command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    const { commandName, options, user } = interaction;
    
    // Initialize user settings if they don't exist
    if (!userSettings.has(user.id)) {
        userSettings.set(user.id, {
            extendedThinking: false,
            showThinkingProcess: false,
            thinkingBudget: DEFAULT_THINKING_BUDGET
        });
    }
    
    try {
        if (commandName === 'thinking') {
            const mode = options.getString('mode');
            const userSetting = userSettings.get(user.id);
            userSetting.extendedThinking = mode === 'on';
            userSettings.set(user.id, userSetting);
            await interaction.reply({
                content: `Thinking mode is now ${mode === 'on' ? 'ON' : 'OFF'}.`,
                ephemeral: true
            });
        } else if (commandName === 'thinking_process') {
            const mode = options.getString('mode');
            const userSetting = userSettings.get(user.id);
            userSetting.showThinkingProcess = mode === 'on';
            userSettings.set(user.id, userSetting);
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
                const userSetting = userSettings.get(user.id);
                userSetting.thinkingBudget = budget;
                userSettings.set(user.id, userSetting);
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
        } else if (commandName === 'status') {
            // Create an embed with the bot's status information
            const userSetting = userSettings.get(user.id);
            const statusEmbed = new EmbedBuilder()
                .setColor(0x00AAFF)
                .setTitle('Ai-chan Status')
                .setDescription('Current configuration and status information')
                .setThumbnail(client.user.displayAvatarURL())
                .addFields(
                    { name: 'AI Model', value: AI_MODEL, inline: true },
                    { name: 'Normal Max Tokens', value: MAX_TOKENS.toString(), inline: true },
                    { name: 'Extended Max Tokens', value: MAX_REASONING_TOKENS.toString(), inline: true },
                    { name: 'Thinking Mode', value: userSetting.extendedThinking ? 'ON' : 'OFF', inline: true },
                    { name: 'Show Thinking Process', value: userSetting.showThinkingProcess ? 'ON' : 'OFF', inline: true },
                    { name: 'Thinking Budget', value: userSetting.thinkingBudget.toString(), inline: true },
                    { name: 'Uptime', value: `Since ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`, inline: false }
                )
                .setFooter({ text: 'Developer: kayfahaarukku' })
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
});

