# AiChanBot
A Discord bot integrated with Anthropic's Claude AI models featuring automatic complexity detection, extended thinking capabilities, and comprehensive tool integration.

## Features

### 🤖 **Intelligent Model Selection**
- **Haiku Model** (`claude-3-5-haiku-20241022`): Fast responses for simple queries
- **Sonnet Model** (`claude-sonnet-4-20250514`): Advanced reasoning for complex problems
- **Automatic Complexity Detection**: Bot automatically chooses the right model based on your query complexity

### 🧠 **Extended Thinking Mode**
- Automatically activated for very complex queries
- Shows step-by-step reasoning process (optional)
- Configurable thinking token budget
- Deep analysis capabilities for complex problems

### 🛠️ **Tool Integration**
Claude automatically determines when to use tools - no special commands needed:
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
  "discord.js": "^14.x",
  "@anthropic-ai/sdk": "latest",
  "node-fetch": "^2.x",
  "dotenv": "latest",
  "axios": "latest",
  "cheerio": "latest"
}
```

## Environment Configuration

Create a `.env` file in the root directory:

```env
DISCORD_TOKEN=your_discord_bot_token
ANTHROPIC_API_KEY=your_anthropic_api_key
BOT_CREATOR_ID=your_discord_user_id
```

**Environment Variables:**
- `DISCORD_TOKEN`: Your Discord bot token from the Discord Developer Portal
- `ANTHROPIC_API_KEY`: Your Anthropic API key for Claude access
- `BOT_CREATOR_ID`: (Optional) Your Discord user ID for admin features. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click your username and select "Copy ID"

## Installation

### Prerequisites
- Node.js 20 or higher
- npm
- SearxNG instance (recommended for web search functionality)

### SearxNG Setup
Refer to [SearxNG docker GitHub page](https://github.com/searxng/searxng-docker) for easy Docker installation.

### Bot Installation

```bash
git clone https://github.com/nawka12/AiChanBot
cd AiChanBot
git checkout claude
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
- `/thinking_budget <number>` - Set thinking token budget (min 1024)
- `/reset` - Reset conversation history
- `/status` - View bot configuration and usage statistics
- `/reset_tokens` - Reset token statistics (creator only)

### Examples

**Simple Query:**
```
@Ai-chan What's the weather like today?
```
*Uses Haiku model for fast response*

**Complex Query:**
```
@Ai-chan Write a detailed business plan for a tech startup focusing on AI-powered education tools
```
*Automatically switches to Sonnet model with extended thinking*

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
- Automatic cost calculation based on current Anthropic pricing
- Cache performance monitoring
- Separate tracking for thinking tokens and tool usage tokens

### Model Costs (per million tokens)
- **Sonnet**: $3.00 input / $15.00 output
- **Haiku**: $0.80 input / $4.00 output

### Security Features
- Bot creator privilege system
- Safe content handling
- Error recovery and graceful degradation
- Automatic token data persistence

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
- Usage costs are based on Anthropic's current pricing model

## Developer

Created by **kayfahaarukku**

---

*Last updated: June 2025*
