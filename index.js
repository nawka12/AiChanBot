require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const whitelist = require('./whitelist.json');

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});
const aiModel = `claude-3-5-sonnet-latest`

const options = { day: 'numeric', month: 'long', year: 'numeric' };
const userConversations = {};
const userContexts = {};

client.on('messageCreate', async function(message) {
    try {
        if (message.author.bot) return;

        if (message.mentions.has(client.user)) {
            message.channel.sendTyping();

            const input = message.content.replace(`<@${client.user.id}>`, '').trim();
            const command = input.split(' ')[0].toLowerCase();
            const commandContent = input.replace(command, '').trim();

            if (command === 'reset') {
                userConversations[message.author.id] = [];
                userContexts[message.author.id] = '';
                message.reply("Ai-chan's conversations with you have been reset.");
                return;
            }

            let messages = [];

            const systemMessage = `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible.`;
            const querySystemMessage = `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', options)}`;
            const queryDeepSystemMessage = `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', options)}`;
            const contextSystemMessage = `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`;

            // Initialize user context if it doesn't exist
            if (!userContexts[message.author.id]) {
                userContexts[message.author.id] = '';
            }

            // Initialize user conversations if it doesn't exist
            if (!userConversations[message.author.id]) {
                userConversations[message.author.id] = [];
            }

            const shouldGenerateContext = userConversations[message.author.id].length >= 2;

            async function processContext() {
                if (!shouldGenerateContext) return '';

                const conversationHistory = userConversations[message.author.id];
                const lastConversation = conversationHistory.slice(-2).map(conv => conv.content).join('\n');

                const contextPrompt = userContexts[message.author.id]
                    ? `Last context summary: ${userContexts[message.author.id]}\nLast conversation: ${lastConversation}`
                    : `Last conversation: ${lastConversation}`;

                console.log(`\n\nCP: ${contextPrompt}`);
                
                const contextAI = await anthropic.messages.create({
                    model: aiModel,
                    max_tokens: 200,
                    system: contextSystemMessage,
                    messages: [
                        {"role": "user", "content": contextPrompt}
                    ],
                });
                
                const finalContext = contextAI.content[0].text;
                console.log(`\n\nFC: ${finalContext}`);
                return finalContext;
            }

            if (command === 'search' || command === 'deepsearch') {
                try {
                    // Only update context if there's previous conversation
                    if (shouldGenerateContext) {
                        userContexts[message.author.id] = await processContext();
                    }

                    const queryContext = userContexts[message.author.id]
                        ? `Context: ${userContexts[message.author.id]}\nQuestion: ${commandContent}`
                        : `Question: ${commandContent}`;

                    const queryAI = await anthropic.messages.create({
                        model: aiModel,
                        max_tokens: 100,
                        temperature: 0.7,
                        system: command === 'search' ? querySystemMessage : queryDeepSystemMessage,
                        messages: [
                            {"role": "user", "content": queryContext}
                        ],
                    });

                    if (command === 'search') {
                        const finalQuery = queryAI.content[0].text;
                        message.channel.send(`Searching the web for \`${finalQuery}\``);
                        const searchResult = await searchQuery(finalQuery);
                        const results = searchResult.results.slice(0, 3);
                        const searchContent = `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
                        messages.push({ role: "user", content: searchContent });
                    } else {
                        const queries = queryAI.content[0].text.split(',').map(q => q.trim());
                        let allResults = [];
                        
                        for (let query of queries) {
                            message.channel.send(`Searching the web for \`${query}\``);
                            const searchResult = await searchQuery(query);
                            allResults = allResults.concat(searchResult.results.slice(0, 3));
                        }
                        
                        const searchContent = `Here's more data from the web about my question:\n\n${allResults.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
                        messages.push({ role: "user", content: searchContent });
                    }
                } catch (error) {
                    console.error(error);
                    message.reply(`There was an error processing your search request.`);
                    return;
                }
            } else {
                // Only update context if there's previous conversation
                if (shouldGenerateContext) {
                    userContexts[message.author.id] = await processContext();
                }
                messages.push({ role: "user", content: input });
            }

            // Add conversation history
            messages = [...userConversations[message.author.id], ...messages];

            console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

            try {
                const response = await anthropic.messages.create({
                    model: aiModel,
                    max_tokens: 4096,
                    system: systemMessage,
                    messages: messages,
                });

                // Update conversation history
                userConversations[message.author.id].push({ role: "user", content: input });
                userConversations[message.author.id].push({ role: "assistant", content: response.content[0].text });

                // Split and send messages if response exceeds Discord's character limit
                const maxLength = 2000;
                const splitMessage = (content) => {
                    if (content.length <= maxLength) {
                        return [content];
                    }

                    const parts = [];
                    let currentPart = '';

                    content.split('\n').forEach((line) => {
                        if ((currentPart + line).length > maxLength) {
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

                const messageParts = splitMessage(response.content[0].text);

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
            } catch (error) {
                console.error("API Error:", error);
                message.reply(`There was an error processing your request.`);
            }
        }
    } catch (err) {
        console.log("General Error:", err);
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
