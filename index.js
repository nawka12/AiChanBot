require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const whitelist = require('./whitelist.json');

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
]});

const { Configuration , OpenAIApi } = require('openai');
const configuration = new Configuration({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);
const options = { day: 'numeric', month: 'long', year: 'numeric' };
var lastResponse = "";

client.on('messageCreate', async function(message){
    try {
        if(lastResponse.length > 1000){
            lastResponse = "";
            console.log("Ai-chan's last respond has been reset.");
            return;
        }

        if(message.content.toLowerCase() == "aireset!"){
            message.channel.sendTyping();
            lastResponse = "";
            message.reply("Ai-chan's last respond has been reset.");
            return;
        }

        if(message.author.bot || !message.content.toLowerCase().startsWith("aisearch!") && !message.content.toLowerCase().startsWith("aideep!") && !message.content.toLowerCase().startsWith("ai!") || message.content.toLowerCase() == ("aisearch!") || message.content.toLowerCase() == ("aideep!") || message.content.toLowerCase() == ("ai!") ) return;
        // if(!whitelist.list.includes(message.author.id)){
        //    message.reply(`You're not authorized to use me.`);
        //    return;
        //}

        const input = message.content.slice(3);
        const moderation = await openai.createModeration({
            input: `${input}`
        });
        if(moderation.data.results[0].flagged == true){
            message.reply(`Your input is inappropriate. I will not respond to that.`);
            return;
        }
        
        if(message.content.toLowerCase().startsWith("aideep!")){
            try {
                const deepInput = input.slice(4);
                const searchResult = await searchQuery(`${deepInput}`);
                const messageDeep = [
                    { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}.` },
                    { role: "system", content: `Here's more data from the web about the user's question:`}
                ];

                for (let i = 0; i < searchResult.results.length; i++) {
                    const { url, title, content } = searchResult.results[i];
                    messageDeep.push({ role: "system", content: `URL: ${url}, Title: ${title}, Content: ${content}` });
                }

                messageDeep.push(
                    { role: "assistant", content: `${lastResponse}` },
                    { role: "user", content: `${deepInput}` }
                  );

                // console.log(messageDeep);
                message.channel.sendTyping();

                const gptResponse = await openai.createChatCompletion({
                    model: "gpt-3.5-turbo",
                    messages: messageDeep,
                    temperature: 0.4,
                    max_tokens: 256,
                  });
    
                  lastResponse = gptResponse.data.choices[0].message.content;
                  const totalTokens = gptResponse.data.usage.total_tokens;
                  const cost = (totalTokens * 0.0015).toFixed(6);
                  message.reply(
                    `${lastResponse}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
                  );
                return;
            } catch (error) {
                console.error(error);
                message.reply(`There was an error processing your request.`);
                return;
            }
        }

        if(message.content.toLowerCase().startsWith("aisearch!")){
          try {
            const searchInput = input.slice(6);
            const searchResult = await searchQuery(`${searchInput}`);
            const results = searchResult.results.slice(0, 2);
            const messages = [
              {
                role: "system",
                content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}.`,
              },
              {
                role: "system",
                content: `Here's more data from the web about the user's question:`,
              },
            ];
            results.forEach((result) => {
              messages.push({
                role: "system",
                content: `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`,
              });
            });
            messages.push(
              { role: "assistant", content: `${lastResponse}` },
              { role: "user", content: `${input}` }
            );
            message.channel.sendTyping();
            // console.log(messages);
            const gptResponse = await openai.createChatCompletion({
              model: "gpt-3.5-turbo",
              messages,
              temperature: 0.4,
              max_tokens: 256,
            });
          
            lastResponse = gptResponse.data.choices[0].message.content;
            const totalTokens = gptResponse.data.usage.total_tokens;
            const cost = (totalTokens * 0.0015).toFixed(6);
            message.reply(
              `${lastResponse}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
            );
          } catch (error) {
            console.error(error);
            message.reply(`There was an error processing your request.`);
            return;
          }
        }
        
        if(message.content.toLowerCase().startsWith("ai!")){
          try {
            const messages = [
              { role: "system", content: `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', options)}.` },
              { role: "assistant", content: `${lastResponse}` },
              { role: "user", content: `${input}` }
            ];
            message.channel.sendTyping();
            // console.log(messages);
            const gptResponse = await openai.createChatCompletion({
              model: "gpt-3.5-turbo",
              messages,
              temperature: 0.4,
              max_tokens: 256,
            });
          
            lastResponse = gptResponse.data.choices[0].message.content;
            const totalTokens = gptResponse.data.usage.total_tokens;
            const cost = (totalTokens * 0.0015).toFixed(6);
            
            message.reply(
              `${lastResponse}\n\n\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``
            );
          } catch (error) {
            console.error(error);
            message.reply(`There was an error processing your request.`);
            return;
          }
        }
} catch (err) {
  console.log(err)
}
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
