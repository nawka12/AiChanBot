require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const whitelist = require('./whitelist.json');

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
]});

const OpenAI = require('openai');

const openai = new OpenAI({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});
const options = { day: 'numeric', month: 'long', year: 'numeric' };
const userConversations = {};

client.on('messageCreate', async function(message){
    try {
        if(message.mentions.has(client.user) && message.content.toLowerCase().includes("reset")){
          message.channel.sendTyping();
          userConversations[message.author.id] = [];
          message.reply("Ai-chan's conversations with you have been reset.");
          return;
        }

        // if(message.author.bot || (!message.content.toLowerCase().startsWith("aisearch!") && !message.content.toLowerCase().startsWith("aideep!") && !message.content.toLowerCase().startsWith("ai!")) || message.content.toLowerCase() == ("aisearch!") || message.content.toLowerCase() == ("aideep!") || message.content.toLowerCase() == ("ai!") ) return;
        // if(!whitelist.list.includes(message.author.id)){
        //    message.reply(`You're not authorized to use me.`);
        //    return;
        //}

        const input = message.content.replace(`<@${client.user.id}>`, '').trim();
        const moderation = await openai.moderations.create({
            input: `${input}`
        });
        if(moderation.results[0].flagged == true){
            message.reply(`Your input is inappropriate. I will not respond to that.`);
            return;
        }

        if(message.mentions.has(client.user) && message.content.toLowerCase().includes("deepsearch")){
            try {
                const deepInput = input.replace("deepsearch", "").trim();
                const searchResult = await searchQuery(`${deepInput}`);
                const messageDeep = [
                    { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. Keep your answer as short as possible.` },
                    { role: "system", content: `Here's more data from the web about the user's question:`},
                    ...userConversations[message.author.id] || []
                ];

                for (let i = 0; i < Math.min(searchResult.results.length, 10); i++) {
                    const { url, title, content } = searchResult.results[i];
                    messageDeep.push({ role: "system", content: `URL: ${url}, Title: ${title}, Content: ${content}` });
                }

                messageDeep.push({ role: "user", content: `${deepInput}` });

                message.channel.sendTyping();

                const gptResponse = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: messageDeep,
                    temperature: 0.4,
                    max_tokens: 256,
                });

                if (!userConversations[message.author.id]) {
                    userConversations[message.author.id] = [];
                }
                userConversations[message.author.id].push({ role: "user", content: deepInput });
                userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

                const promptTokens = gptResponse.usage.prompt_tokens;
                const completionTokens = gptResponse.usage.completion_tokens;
                const totalTokens = gptResponse.usage.total_tokens;
                const cost = ((promptTokens * 0.000005) + (completionTokens * 0.000015)).toFixed(6);
                message.reply(
                    `${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
                );
                return;
            } catch (error) {
                console.error(error);
                message.reply(`There was an error processing your request.`);
                return;
            }
        }

        if(message.mentions.has(client.user) && message.content.toLowerCase().includes("search")){ 
            try {
                const searchInput = input.replace("search", "").trim();
                const searchResult = await searchQuery(`${searchInput}`);
                const results = searchResult.results.slice(0, 2);
                const messages = [
                    {
                        role: "system",
                        content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. Keep your answer as short as possible.`,
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
                messages.push(
                    { role: "user", content: `${searchInput}` }
                );
                message.channel.sendTyping();
                // console.log(messages);
                const gptResponse = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages,
                    temperature: 0.4,
                    max_tokens: 256,
                });

                if (!userConversations[message.author.id]) {
                    userConversations[message.author.id] = [];
                }
                userConversations[message.author.id].push({ role: "user", content: searchInput });
                userConversations[message.author.id].push({ role: "assistant", content: gptResponse.choices[0].message.content });

                const promptTokens = gptResponse.usage.prompt_tokens;
                const completionTokens = gptResponse.usage.completion_tokens;
                const totalTokens = gptResponse.usage.total_tokens;
                const cost = ((promptTokens * 0.000005) + (completionTokens * 0.000015)).toFixed(6);
                message.reply(
                    `${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
                );
            } catch (error) {
                console.error(error);
                message.reply(`There was an error processing your request.`);
                return;
            }
        }

        if(message.mentions.has(client.user) && !message.content.toLowerCase().includes("search") && !message.content.toLowerCase().includes("deepsearch")){ 
            try {
                const messages = [
                    { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. Keep your answer as short as possible.` },
                    ...userConversations[message.author.id] || [],
                    { role: "user", content: `${input}` }
                ];
                message.channel.sendTyping();
                // console.log(messages);
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

                message.reply(
                    `${gptResponse.choices[0].message.content}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
                );
            } catch (error) {
                console.error(error);
                message.reply(`There was an error processing your request.`);
                return;
            }
        }
    } catch (err) {
        console.log(err);
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
