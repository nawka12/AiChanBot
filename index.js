require('dotenv').config();

const whitelist = require('./whitelist.json');

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
]})

const { Configuration , OpenAIApi } = require('openai');
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
        if(message.content == "aireset!"){
            lastResponse = "";
            message.reply("Ai-chan last respond has been reset.");
            return;
        }

        if(message.author.bot || !message.content.startsWith("ai!") && !message.content.startsWith("Ai!") && !message.content.startsWith("AI!") || message.content == ("ai!")) return;
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
        const gptResponse = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [
                {role:"system", content:`You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${currentDate}.`},
                {role: "assistant", content: `${lastResponse}`},
                {role:"user", content:`${input}`}
            ],
            temperature: 0.4,
            max_tokens: 256,
        })
        
        lastResponse = gptResponse.data.choices[0].message.content;
        message.reply(`${lastResponse}\n\n\`\`\`Token Used: ${gptResponse.data.usage.total_tokens}\nCost: $${gptResponse.data.usage.total_tokens * 0.000002}\`\`\``);
        return;
    } catch (err) {
        console.log(err)
    }
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
