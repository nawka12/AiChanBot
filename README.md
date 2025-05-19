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

## Environment Configuration

Create a `.env` file in the root directory with the following variables:

```
DISCORD_TOKEN=your_discord_bot_token
ANTHROPIC_API_KEY=your_anthropic_api_key
BOT_CREATOR_ID=your_discord_user_id
```

- `DISCORD_TOKEN`: Your Discord bot token from the Discord Developer Portal
- `ANTHROPIC_API_KEY`: Your Anthropic API key for Claude
- `BOT_CREATOR_ID`: (Optional) Your Discord user ID for admin features. To get this, enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click your username and select "Copy ID"

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
