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

const options = { day: 'numeric', month: 'long', year: 'numeric' };
const userConversations = {};

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

            let messages = [];

            const systemMessage = `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible.`;

            if (command === 'deepsearch' || command === 'search') {
                try {
                    const searchResult = await searchQuery(commandContent);
                    const results = command === 'deepsearch' ? searchResult.results.slice(0, 10) : searchResult.results.slice(0, 3);
                    
                    const searchContent = `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
                    messages.push({ role: "user", content: searchContent });
                } catch (error) {
                    console.error(error);
                    message.reply(`There was an error processing your search request.`);
                    return;
                }
            } else {
                messages.push({ role: "user", content: input });
            }

            // Add conversation history, ensuring alternating roles
            if (userConversations[message.author.id]) {
                messages = [...userConversations[message.author.id], ...messages];
            }

            console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

            try {
                const response = await anthropic.messages.create({
                    model: "claude-3-5-sonnet-20240620",
                    max_tokens: 4096,
                    system: systemMessage,
                    messages: messages,
                });

                if (!userConversations[message.author.id]) {
                    userConversations[message.author.id] = [];
                }
                userConversations[message.author.id].push({ role: "user", content: input });
                userConversations[message.author.id].push({ role: "assistant", content: response.content[0].text });

                message.reply(response.content[0].text);
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
