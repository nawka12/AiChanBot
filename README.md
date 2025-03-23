# AiChanBot
A Discord bot integrated with Anthropic's Claude 3 API

Dependencies:
- Node.js 20
- npm
- Discord.js
- dotenv
- @anthropic-ai/sdk
- axios
- cheerio
- node-fetch

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
To "summon" Ai-chan, mention the bot (eg. @Ai-chan). Claude will automatically determine if it needs to use tools to answer your questions.

Mention the bot with `reset` (eg. `@Ai-chan reset`) to reset your conversation and save tokens!

## Features
- Saving user's conversation separately on DMs.
- Saving server conversations with the bot ability to recognize different users so the bot did not get confused.
- Automatic tool use detection - Claude determines when to search the web or scrape content.
- Showing how much token is used.
- Showing calculated cost of the API request.
- Tools integration:
  - `web_search` - Searches the web for information
  - `web_scrape` - Scrapes content from a specific URL
  - `multi_scrape` - Scrapes content from multiple URLs
- Enhanced deepsearch with full webpage content scraping.
- User notifications when Claude is using tools.

## Advanced Features

### Claude Tools Integration
The bot automatically detects when Claude needs to search the web or access external information. No special commands are needed - just ask your questions naturally, and Claude will use the appropriate tools when necessary.

## Some disclaimers
- I expect you can set up Discord bot properly at https://discord.com/developers/applications. I will not respond to any issue with setting up the bot.
