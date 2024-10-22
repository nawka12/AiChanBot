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

const OpenAI = require('openai');

const openai = new OpenAI({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});

const options = { day: 'numeric', month: 'long', year: 'numeric' };
const userConversations = {};
const aiModel = "gpt-4o";

// Price per million tokens
const promptTokenPrice = 2.50;     // $2.50 per million tokens
const completionTokenPrice = 10.00; // $10.00 per million tokens

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
                message.reply("Ai-chan's conversations with you have been reset.");
                return;
            }

            const moderation = await openai.moderations.create({
                input: `${commandContent}`
            });

            if (moderation.results[0].flagged) {
                message.reply(`Your input is inappropriate. I will not respond to that.`);
                return;
            }

            let messages = [];

            const systemMessage = `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible.`;
            
            if (command === 'search' || command === 'deepsearch') {
                try {
                    // Create query using GPT to generate better search terms
                    const queryResponse = await openai.chat.completions.create({
                        model: aiModel,
                        messages: [
                            {
                                role: "system",
                                content: command === 'search' 
                                    ? `Your job is to convert questions into a search query. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', options)}`
                                    : `Your job is to convert questions into search queries. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', options)}`
                            },
                            {
                                role: "user",
                                content: commandContent
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 100
                    });

                    const queries = command === 'search' 
                        ? [queryResponse.choices[0].message.content]
                        : queryResponse.choices[0].message.content.split(',').map(q => q.trim());

                    let allResults = [];

                    for(let query of queries) {
                        message.channel.send(`Searching the web for \`${query}\``);
                        const searchResult = await searchQuery(query);
                        const results = searchResult.results.slice(0, command === 'search' ? 3 : 3);
                        allResults = allResults.concat(results);
                    }

                    const searchContent = `Here's more data from the web about my question:\n\n${allResults.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
                    messages.push({ role: "user", content: searchContent });
                } catch (error) {
                    console.error(error);
                    message.reply(`There was an error processing your ${command} request.`);
                    return;
                }
            } else {
                messages.push({ role: "user", content: input });
            }

            // Add conversation history
            if (userConversations[message.author.id]) {
                messages = [...userConversations[message.author.id], ...messages];
            }

            try {
                const gptResponse = await openai.chat.completions.create({
                    model: aiModel,
                    messages: [
                        { role: "system", content: systemMessage },
                        ...messages
                    ],
                    temperature: 1.0,
                    max_tokens: 4096
                });

                if (!userConversations[message.author.id]) {
                    userConversations[message.author.id] = [];
                }
                userConversations[message.author.id].push({ role: "user", content: input });
                userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

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

                const messageParts = splitMessage(gptResponse.choices[0].message.content);

                // Calculate token usage and cost
                const promptTokens = gptResponse.usage.prompt_tokens;
                const completionTokens = gptResponse.usage.completion_tokens;
                const totalTokens = gptResponse.usage.total_tokens;
                const cost = (
                    (promptTokens * (promptTokenPrice / 1000000)) + 
                    (completionTokens * (completionTokenPrice / 1000000))
                ).toFixed(6);
                const usageInfo = `\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``;

                // Send messages with token usage info
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
                message.reply(`There was an error processing your request.`);
            }
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
