# AiChanBot
A Discord bot integrated with OpenAI's gpt-3.5-turbo language model (ChatGPT)

### This bot is still under construction and lacking a lot of features.

Dependencies:
- Node.js 18
- npm
- Discord.js
- dotenv

Don't forget to grab your own OpenAI API key, OpenAI Organization key, and your Discord bot key and put it in `.env` file.
For easy setup, set the bot permission as `Administrator` in the Discord Developer Portal. (It's safe, supposedly).

## How to use
**Don't forget** to add your user ID to `whitelist.json`.

To "summon" Ai-chan, use `ai!`, `aisearch!` and `aideep!` prefix. (`aisearch!` is using 2 search results, `aideep!` using up to 10+ search results).

**Experimental:** use `aireset!` to reset last response, cut context, and save token!

## Features
- Showing how much token is used
- Showing calculated cost of the API request.
- Whitelist using user ID, **NOT** Discord tag. (Because you pay for the API, I think this is a good thing to have a little protection preventing random people from using the bot).
- **NEW!** Use SearXNG to grab results from the web! (~basically a cheap copy of Bing Chat~)

## Some disclaimers
- The bot can only follow the context of your last chat, not the chat before that.
- I expect you can set up Discord bot properly at https://discord.com/developers/applications. I will not respond to any issue with setting up the bot.
