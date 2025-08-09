# AiChanBot
A Discord bot using OpenRouter to access LLM models, featuring automatic complexity detection and comprehensive tool integration.

## Features

### 🤖 **Intelligent Model Selection**
- **Smaller Model** (default to `openai/gpt-5-nano`): Fast responses for simple queries
- **Bigger Model** (default to `openai/gpt-5-mini`): Advanced reasoning for complex problems
- **Automatic Complexity Detection**: Bot automatically chooses the right model based on your query complexity (configurable separate complexity model via `OPENROUTER_MODEL_COMPLEXITY`)

### 🧠 **Reasoning Tokens & Thinking Mode**
- Unified reasoning control via OpenRouter `reasoning` parameter (effort/budget/exclusion)
- Toggle visibility with `/thinking_process on|off`
- Configure reasoning budget with `/thinking_budget <tokens>` (min 1024, capped to 32000)
- Reasoning text is shown when enabled and the model provides it
  - Some models may not return reasoning tokens
  - Reasoning tokens count towards output usage and billing

### 🛠️ **Tool Integration**
The model can call tools automatically - no special commands needed:
- `web_search` - Searches the web for real-time information
- `web_scrape` - Scrapes content from specific URLs
- `multi_scrape` - Scrapes content from multiple URLs simultaneously
- `nitter_tweets` - Fetches tweets from specific users
- `tweet_url_scrape` - Scrapes individual tweet URLs

### 🖼️ **Image Processing**
- Upload images and ask questions about them
- Automatic image description and analysis
- Supports multiple image formats
- Combines image analysis with text queries

### 💬 **Advanced Conversation Management**
- Separate conversation history for DMs and servers
- User recognition in server conversations
- Reply context handling - responds intelligently to message replies
- Conversation reset functionality

### 📊 **Comprehensive Analytics**
- Detailed token usage tracking per model
- Real-time cost calculation
- Cache performance monitoring (hits/misses)
- Thinking and tool usage token tracking
- Average token usage per message statistics

### ⚙️ **User Customization**
- `/thinking_process` - Toggle display of thinking process
- `/thinking_budget` - Set custom thinking token budget
- `/reset` - Reset conversation history
- `/status` - View bot configuration and statistics
- `/reset_tokens` - Reset token statistics (bot creator only)

## Dependencies

```json
{
  "dependencies": {
    "discord.js": "^14.8.0",
    "node-fetch": "^2.7.0",
    "dotenv": "^16.0.3",
    "axios": "^1.8.1",
    "cheerio": "^1.0.0"
  }
}
```

## Environment Configuration

Create a `.env` file in the root directory:

```env
DISCORD_TOKEN=your_discord_bot_token
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL_SMALLER=openai/gpt-5-nano
OPENROUTER_MODEL_BIGGER=your_chosen
OPENROUTER_MODEL_COMPLEXITY=openai/gpt-5-mini  # optional model dedicated for complexity checks
BOT_CREATOR_ID=your_discord_user_id
```

**Environment Variables:**
- `DISCORD_TOKEN`: Your Discord bot token from the Discord Developer Portal
- `OPENROUTER_API_KEY`: Your OpenRouter API key
- `BOT_CREATOR_ID`: (Optional) Your Discord user ID for admin features. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click your username and select "Copy ID"

## Installation

### Prerequisites
- Node.js 20 or higher
- npm
- SearxNG instance (recommended for web search functionality)

### SearxNG Setup
Refer to [SearxNG docker GitHub page](https://github.com/searxng/searxng-docker) for easy Docker installation.

### Web Search Configuration
- The `web_search` tool requires a running SearxNG instance.
- Default endpoint is `http://127.0.0.1:8080` configured in `searchlogic.js` (`baseUrl`). Change it if your SearxNG runs elsewhere.

```js
// searchlogic.js
const baseUrl = 'http://127.0.0.1:8080/search?q=';
```

### Twitter/X Support
- Twitter/X links are handled via public Nitter mirrors in `nitter_tool.js` (no API keys needed).
- Availability depends on working Nitter instances and CORS proxies; occasional failures are expected.

### Bot Installation

```bash
git clone https://github.com/nawka12/AiChanBot
cd AiChanBot
git checkout openrouter
npm install
node index.js
```

**Production Deployment (recommended):**
```bash
npm install -g pm2
pm2 start index.js --name "ai-chan"
pm2 startup
pm2 save
```

## Usage

### Basic Interaction
- **Servers**: Mention the bot (`@Ai-chan`) followed by your question
- **DMs**: Simply send messages directly to the bot
- **Reset**: Mention with `reset` (`@Ai-chan reset`) to clear conversation history

### Slash Commands
- `/thinking_process on|off` - Toggle thinking process display
- `/thinking_budget <tokens|effort>`
  - For OpenAI models: use `effort` = `low`, `medium`, or `high`
  - For non-OpenAI models: set token budget (min 1024, max 32000)
- `/reset` - Reset conversation history
- `/status` - View bot configuration and usage statistics
- `/reset_tokens` - Reset token statistics (creator only)

### Examples

**Simple Query:**
```
@Ai-chan What's the weather like today?
```
*Uses smaller model for fast response*

**Complex Query:**
```
@Ai-chan Write a detailed business plan for a tech startup focusing on AI-powered education tools
```
*Automatically switches to bigger model with extended thinking*

**Image Analysis:**
```
@Ai-chan What's happening in this image? [attach image]
```
*Processes and analyzes the uploaded image*

**Web Research:**
```
@Ai-chan What are the latest developments in quantum computing this year?
```
*Automatically uses web search tools to get current information*

## Technical Details

### Token Management
- Real-time token usage tracking per model
- Automatic cost calculation (pricing values in code)

### Model Costs (per million tokens)
- Note: Values are examples used for cost display and may not reflect real-time pricing.
- **Bigger**: $0.25 input / $2.00 output
- **Smaller**: $0.05 input / $0.40 output

### Security Features
- Bot creator privilege system
- Safe content handling
- Error recovery and graceful degradation
- Automatic token data persistence (stored in `token_data.json`)

### Time & Locale
- All dates/times displayed by the bot use Asia/Jakarta (GMT+7).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Disclaimers

- You are expected to properly set up the Discord bot at https://discord.com/developers/applications
- Issues related to Discord bot setup will not be addressed
- The bot can provide NSFW responses when appropriate
- Usage costs are based on pricing values defined in code

## Developer

Created by **kayfahaarukku**

---

*Last updated: Aug 2025*
