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

client.on('messageCreate', async function(message) {
    try {
        // Ignore messages from bots
        if (message.author.bot) {
            return;
        }

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

            // if (!whitelist.list.includes(message.author.id)) {
            //     message.reply(`You're not authorized to use me.`);
            //     return;
            // }

            const moderation = await openai.moderations.create({
                input: `${commandContent}`
            });

            if (moderation.results[0].flagged) {
                message.reply(`Your input is inappropriate. I will not respond to that.`);
                return;
            }

            if (command === 'deepsearch') {
                try {
                    const searchResult = await searchQuery(commandContent);
                    const messageDeep = [
                        { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You're connected to the internet. Keep your answer as short as possible.` },
                        { role: "system", content: `Here's more data from the web about the user's question:` },
                        ...userConversations[message.author.id] || []
                    ];

                    for (let i = 0; i < Math.min(searchResult.results.length, 10); i++) {
                        const { url, title, content } = searchResult.results[i];
                        messageDeep.push({ role: "system", content: `URL: ${url}, Title: ${title}, Content: ${content}` });
                    }

                    messageDeep.push({ role: "user", content: `${commandContent}` });

                    const gptResponse = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages: messageDeep,
                        temperature: 0.4,
                        max_tokens: 256,
                    });

                    if (!userConversations[message.author.id]) {
                        userConversations[message.author.id] = [];
                    }
                    userConversations[message.author.id].push({ role: "user", content: commandContent });
                    userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

                    const promptTokens = gptResponse.usage.prompt_tokens;
                    const completionTokens = gptResponse.usage.completion_tokens;
                    const totalTokens = gptResponse.usage.total_tokens;
                    const cost = ((promptTokens * 0.000005) + (completionTokens * 0.000015)).toFixed(6);

                    message.reply(`${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``);
                    return;
                } catch (error) {
                    console.error(error);
                    message.reply(`There was an error processing your request.`);
                    return;
                }
            }

            if (command === 'search') {
                try {
                    const searchResult = await searchQuery(commandContent);
                    const results = searchResult.results.slice(0, 2);
                    const messages = [
                        {
                            role: "system",
                            content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You're connected to the internet. Keep your answer as short as possible.`,
                        },
                        {
                            role: "system",
                            content: `Here's more data from the web about the user's question:`,
                        },
                        ...userConversations[message.author.id] || []
                    ];
                    results.forEach((result) => {
                        messages.push({
                            role: "system",
                            content: `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`,
                        });
                    });
                    messages.push({ role: "user", content: `${commandContent}` });

                    const gptResponse = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages,
                        temperature: 0.4,
                        max_tokens: 256,
                    });

                    if (!userConversations[message.author.id]) {
                        userConversations[message.author.id] = [];
                    }
                    userConversations[message.author.id].push({ role: "user", content: commandContent });
                    userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

                    const promptTokens = gptResponse.usage.prompt_tokens;
                    const completionTokens = gptResponse.usage.completion_tokens;
                    const totalTokens = gptResponse.usage.total_tokens;
                    const cost = ((promptTokens * 0.000005) + (completionTokens * 0.000015)).toFixed(6);

                    message.reply(`${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``);
                    return;
                } catch (error) {
                    console.error(error);
                    message.reply(`There was an error processing your request.`);
                    return;
                }
            }

            // Handle general queries
            const messages = [
                { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You're not connected to the internet. Keep your answer as short as possible.` },
                ...userConversations[message.author.id] || [],
                { role: "user", content: `${input}` }
            ];

            const gptResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages,
                temperature: 0.4,
                max_tokens: 256,
            });

            if (!userConversations[message.author.id]) {
                userConversations[message.author.id] = [];
            }
            userConversations[message.author.id].push({ role: "user", content: input });
            userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

            const promptTokens = gptResponse.usage.prompt_tokens;
            const completionTokens = gptResponse.usage.completion_tokens;
            const totalTokens = gptResponse.usage.total_tokens;
            const cost = ((promptTokens * 0.000005) + (completionTokens * 0.000015)).toFixed(6);

            message.reply(`${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``);
        }
    } catch (err) {
        console.log(err);
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
