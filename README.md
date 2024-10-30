# AiChanBot
A Discord bot integrated with Anthropic's Claude

### This bot is still under construction and lacking features.

Dependencies:
- Node.js 20
- npm
- Discord.js
- dotenv

Don't forget to grab your own Anthropic key, and your Discord bot key and put it in `.env` file.
For easy setup, set the bot permission as `Administrator` in the Discord Developer Portal. (It's safe, supposedly).

## Installation

Assuming you're running this on Ubuntu.

### SearxNG

Refer to [SearxNG docker GitHub page](https://github.com/searxng/searxng-docker) to install SearxNG easily.

### Ai-chan

```sh
git clone https://github.com/nawka12/AiChanBot
cd AiChanBot
git checkout claude
npm install
node index.js # I recommend you to use pm2, npm install -g pm2, then pm2 start index.js
```

## How to use
To "summon" Ai-chan, mention the bot (eg. @Ai-chan). To use search feature, add `search` or `deepsearch` after mentioning the bot (eg. `@Ai-chan search When is the next hololiveMeet?`) (`search` is using up to 3 search results, `deepsearch` is using multiple queries, with 3 search results per query).

Mention the bot `reset` (eg. `@Ai-chan reset`) to reset your conversation and save token!

## Features
- Saving user's conversation separately so you can chat about something while your friend chat about something else without confusing the bot.
- Showing how much token is used
- Showing calculated cost of the API request.
- Using SearXNG to grab results from the web!

## Some disclaimers
- I expect you can set up Discord bot properly at https://discord.com/developers/applications. I will not respond to any issue with setting up the bot.
