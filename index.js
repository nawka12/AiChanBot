require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');

// Constants
const AI_MODEL = "gpt-4o";
const MAX_TOKENS = 4096;
const MAX_SEARCH_RESULTS = 3;
const MAX_MESSAGE_LENGTH = 2000;
const DATE_OPTIONS = { day: 'numeric', month: 'long', year: 'numeric' };

// Price per million tokens
const PROMPT_TOKEN_PRICE = 2.50;     // $2.50 per million tokens
const COMPLETION_TOKEN_PRICE = 10.00; // $10.00 per million tokens

// Configuration
const config = {
    systemMessage: (command) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible.`,
    querySystemMessage: `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}`,
    queryDeepSystemMessage: `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}`,
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`,
};

// Initialize clients
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const openai = new OpenAI({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});

// State management
const userConversations = {};
const userContexts = {};

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
                max_tokens: MAX_TOKENS
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

const processContext = async (userId) => {
    const conversationHistory = userConversations[userId];
    const lastConversation = conversationHistory.slice(-2).map(conv => conv.content).join('\n');

    const contextPrompt = userContexts[userId]
        ? `Last context summary: ${userContexts[userId]}\nLast conversation: ${lastConversation}`
        : `Last conversation: ${lastConversation}`;

    console.log(`\n\nCP: ${contextPrompt}`);
    
    const contextResponse = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
            { role: "system", content: config.contextSystemMessage },
            { role: "user", content: contextPrompt }
        ],
        max_tokens: 200
    });
    
    const finalContext = contextResponse.choices[0].message.content;
    console.log(`\n\nFC: ${finalContext}`);
    return finalContext;
};

const performSearch = async (command, queryResponse, commandContent, message) => {
    const queries = queryResponse.choices[0].message.content.split(',').map(q => q.trim());
    let allResults = [];
    
    for (let query of queries) {
        // Send a message indicating the search query
        await message.channel.send(`Searching the web for \`${query}\``);
        
        const searchResult = await searchQuery(query);
        allResults = allResults.concat(searchResult.results.slice(0, MAX_SEARCH_RESULTS));
    }
    
    const searchContent = `Here's more data from the web about my question:\n\n${allResults.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
    return searchContent;
};

const formatSearchResults = (searchResult) => {
    const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
    return results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n');
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
        if (message.author.bot || !message.mentions.has(client.user)) return;

        message.channel.sendTyping();

        const input = message.content
            .replace(`<@${client.user.id}>`, '')
            .replace(/<@&\d+>/g, '')
            .trim();
        const [rawCommand, ...contentParts] = input.split(' ');
        const command = rawCommand.toLowerCase();
        const commandContent = contentParts.join(' ');

        if (command === 'reset') {
            userConversations[message.author.id] = [];
            userContexts[message.author.id] = '';
            await message.reply("Ai-chan's conversations with you have been reset.");
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
                if (userConversations[message.author.id].length >= 2) {
                    userContexts[message.author.id] = await processContext(message.author.id);
                }

                const queryContext = `${userContexts[message.author.id] ? `Context: ${userContexts[message.author.id]}\n` : ''}${imageDescriptions ? `Image descriptions: ${imageDescriptions}\n` : ''}Question: ${commandContent}`;

                const queryResponse = await openai.chat.completions.create({
                    model: AI_MODEL,
                    messages: [
                        { role: "system", content: command === 'search' ? config.querySystemMessage : config.queryDeepSystemMessage },
                        { role: "user", content: queryContext }
                    ],
                    temperature: 0.7,
                    max_tokens: 100
                });

                searchContent = await performSearch(command, queryResponse, commandContent, message);
                messages.push({ role: "user", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                await message.reply(`There was an error processing your search request.`);
                return;
            }
        } else {
            messages.push({ role: "user", content: input });
            if (imageDescriptions) {
                messages.push({ role: "assistant", content: imageDescriptions });
            }
            if (userConversations[message.author.id].length >= 2) {
                userContexts[message.author.id] = await processContext(message.author.id);
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
                    { role: "system", content: config.systemMessage(command) },
                    ...messages
                ],
                temperature: 1.0,
                max_tokens: MAX_TOKENS
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

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
