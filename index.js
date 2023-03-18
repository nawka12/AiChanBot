import dotenv from 'dotenv';
dotenv.config();
import { searchQuery } from './searchlogic.js';
import whitelist from './whitelist.json' assert { type: 'json' };

import { Client } from 'discord.js';
import Discord from 'discord.js';
const { GatewayIntentBits } = Discord;
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
]})

import { Configuration , OpenAIApi } from 'openai';
const configuration = new Configuration({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);
const date = new Date();
const options = { day: 'numeric', month: 'long', year: 'numeric' };
const currentDate = date.toLocaleDateString('en-US', options);
var lastResponse = "";

client.on('messageCreate', async function(message){
    try {
        if(lastResponse.length > 1000){
            lastResponse = "";
            console.log("Ai-chan's last respond has been reset.");
            return;
        }

        if(message.content.toLowerCase() == "aireset!"){
            lastResponse = "";
            message.reply("Ai-chan's last respond has been reset.");
            return;
        }

        if(message.author.bot || !message.content.toLowerCase().startsWith("ai!") || message.content.toLowerCase() == ("ai!")) return;
        if(!whitelist.list.includes(message.author.id)){
            message.reply(`You're not authorized to use me.`);
            return;
        }

        const input = message.content.slice(3);
        const moderation = await openai.createModeration({
            input: `${input}`
        });
        if(moderation.data.results[0].flagged == true){
            message.reply(`Your input is inappropriate. I will not respond to that.`);
            return;
        }


        try {
            const hasil = await searchQuery(`${input}`);
            const title = hasil.results[0].title;
            const url = hasil.results[0].url;
            const content = hasil.results[0].content;

            console.log(content);

            const gptResponse = await openai.createChatCompletion({
                model: "gpt-3.5-turbo",
                messages: [
                  { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${currentDate}.` },
                  { role: "system", content: `Here's more data from the web about the user's question. URL: ${url}, Title: ${title}, Content: ${content}` },
                  { role: "assistant", content: `${lastResponse}` },
                  { role: "user", content: `${input}` }
                ],
                temperature: 0.4,
                max_tokens: 256,
              });

            lastResponse = gptResponse.data.choices[0].message.content;
            message.reply(`${lastResponse}\n\n\`\`\`Token Used: ${gptResponse.data.usage.total_tokens}\nCost: $${gptResponse.data.usage.total_tokens * 0.000002}\`\`\``);
        } catch (error) {
            console.error(error);
        }
} catch (err) {
  console.log(err)
}
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
