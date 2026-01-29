# AiChanBot
A Discord bot using OpenRouter to access LLM models, featuring automatic complexity detection and comprehensive tool integration.

## Announcement
Due to the fastly moving breakthrough in LLMs, and sometimes achieved by different providers, I have made the OpenRouter branch as the main branch. This to ensure moving to different models as smooth as possible.

I'm also declaring that the other branches are deprecated.

## Features

### 🤖 **Intelligent Model Selection**
- **Smaller Model** (default to `openai/gpt-5-nano`): Fast responses for simple queries. Thinking mode optional via `MODEL_SMALLER_THINKING`.
- **Bigger Model** (default to `openai/gpt-5-mini`): Advanced reasoning for complex problems. Thinking mode optional via `MODEL_BIGGER_THINKING`.
- **Automatic Complexity Detection**: Bot automatically chooses the right model based on your query complexity.
  - 'simple' -> Smaller Model
  - 'complex' -> Bigger Model
  - 'very_complex' -> Bigger Model with Extended Thinking (forced on)

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
- `note` - Manages personal or guild notes as a persistent knowledge base (scoped)
- `schedule` - Creates timers and cron jobs for scheduled messages/reminders

### ⏰ **Scheduled Tasks (Timers & Cron Jobs)**
- **Timers**: One-shot delayed tasks that auto-delete after execution
  - Example: "remind me in 30 minutes to check the oven"
- **Cron Jobs**: Recurring scheduled tasks using cron expressions
  - Example: "send weather for Jakarta every weekday at 8 AM"
- **Action Types**:
  - `preset`: Send a fixed message
  - `ai`: Generate an AI response (with full tool support for web search, etc.)
- **Scoping**:
  - User schedules: Only in DMs, any user can create
  - Guild schedules: Only in servers, requires "Manage Server" permission
- **Limits**: 5 cron + 10 timers per user, 10 cron + 20 timers per guild
- **Persistence**: Schedules survive bot restarts
- **Timezone**: Asia/Jakarta (GMT+7)

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

- Built-in notes system with strict scoping (personal notes in DMs; guild notes in servers)

### 📊 **Comprehensive Analytics**
- Detailed token usage tracking per model
- Real-time cost calculation with configurable pricing
- Cache performance monitoring (hits/misses)
- Thinking and tool usage token tracking
- Average token usage per message statistics
- Environment variable cost overrides for accurate billing

### ⚙️ **User Customization**
- `/thinking_process` - Toggle display of thinking process
- `/thinking_budget` - Set custom thinking token budget
- `/reset` - Reset conversation history
- `/status` - View bot configuration and statistics
- `/reset_tokens` - Reset token statistics (bot creator only)
- `/schedule create` - Create a new timer or cron job
- `/schedule list` - List all your scheduled tasks
- `/schedule delete <id>` - Delete a scheduled task
- `/schedule toggle <id>` - Enable/disable a scheduled task

## Dependencies

```json
{
  "dependencies": {
    "discord.js": "^14.8.0",
    "node-fetch": "^2.7.0",
    "dotenv": "^16.0.3",
    "axios": "^1.8.1",
    "cheerio": "^1.0.0",
    "node-cron": "^4.2.1"
  }
}
```

## Environment Configuration

Create a `.env` file in the root directory:

```env
# Required Configuration
DISCORD_TOKEN=your_discord_bot_token
OPENROUTER_API_KEY=your_openrouter_api_key

# Model Selection (Optional - defaults shown; complexity model is independent)
OPENROUTER_MODEL_SMALLER=openai/gpt-5-nano
OPENROUTER_MODEL_BIGGER=openai/gpt-5-mini
# Optional alias for bigger model used by older configs
OPENROUTER_MODEL_HYBRID=
OPENROUTER_MODEL_COMPLEXITY=openai/gpt-4.1-nano  # dedicated model for complexity checks

# Thinking Configuration (Optional - defaults to false)
# If set to true, enables thinking/reasoning even for simple/complex queries respectively
MODEL_SMALLER_THINKING=false
MODEL_BIGGER_THINKING=false

# Model Cost Overrides (Optional - per million tokens)
MODEL_SMALLER_COST_IN=0.05      # Smaller model input cost
MODEL_SMALLER_COST_OUT=0.4      # Smaller model output cost
MODEL_BIGGER_COST_IN=0.25       # Bigger model input cost
MODEL_BIGGER_COST_OUT=2.0       # Bigger model output cost
MODEL_COMPLEXITY_IN=0.10        # Complexity model input cost
MODEL_COMPLEXITY_OUT=0.4        # Complexity model output cost

# Admin Configuration (Optional)
BOT_CREATOR_ID=your_discord_user_id
```

**Environment Variables:**

**Required:**
- `DISCORD_TOKEN`: Your Discord bot token from the Discord Developer Portal
- `OPENROUTER_API_KEY`: Your OpenRouter API key

**Model Configuration:**
- `OPENROUTER_MODEL_SMALLER`: Model used for simple queries (default: `openai/gpt-5-nano`)
- `OPENROUTER_MODEL_BIGGER`: Model used for complex queries (default: `openai/gpt-5-mini`)
- `OPENROUTER_MODEL_HYBRID`: Optional alias that can provide the bigger model (fallback used by code)
- `OPENROUTER_MODEL_COMPLEXITY`: Model used for complexity detection (default: `openai/gpt-4.1-nano`)
- `MODEL_SMALLER_THINKING`: Set to `true` to enable thinking/reasoning for simple queries (default: `false`)
- `MODEL_BIGGER_THINKING`: Set to `true` to enable thinking/reasoning for complex queries (default: `false`)

**Cost Configuration:**
- `MODEL_SMALLER_COST_IN/OUT`: Override costs for smaller model (per million tokens)
- `MODEL_BIGGER_COST_IN/OUT`: Override costs for bigger model (per million tokens)
- `MODEL_COMPLEXITY_IN/OUT`: Override costs for complexity model (per million tokens)

**Admin Features:**
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

- For Twitter links, scraping is routed through the `tweet_url_scrape` or `nitter_tweets` tools automatically. Do not use `web_scrape` for twitter.com/x.com.

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

### Notes (Built-in Knowledge Base)
- The model can save and retrieve notes on your behalf using the `note` tool.
- Scoping is strict by design:
  - In DMs, only personal (`user`) notes are accessible
  - In servers, only server (`guild`) notes for that specific guild are accessible
- Storage is persisted under `notes/users/` and `notes/guilds/`.

Examples:
```
@Ai-chan Remember that my editor is Cursor (personal note)
```
```
@Ai-chan In this server, our build command is `npm run build` (guild note)
```
```
@Ai-chan What notes do you have about our build? (retrieves relevant notes in context)
```

### Scheduled Tasks (Timers & Cron Jobs)
Create timers and recurring tasks via natural language or slash commands.

**Via @mention (natural language):**
```
@Ai-chan set a timer for 5 minutes
@Ai-chan remind me in 1 hour to take a break
@Ai-chan send weather for Jakarta every weekday at 8 AM
@Ai-chan post a motivational quote every Monday at 9 AM
```

**Via slash commands:**
```
/schedule create type:Timer schedule:30 minutes action:Send message content:Time to stretch!
/schedule create type:Cron schedule:0 8 * * 1-5 action:AI response prompt:Give me today's weather for Jakarta
/schedule list
/schedule delete id:abc123
/schedule toggle id:abc123
```

**Common cron expressions:**
| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 8 * * *` | Every day at 8 AM |
| `0 9 * * 1-5` | Weekdays at 9 AM |
| `0 10 * * 0,6` | Weekends at 10 AM |
| `0 0 * * 1` | Every Monday at midnight |

**Note:** AI-generated scheduled responses have full tool access (web search, scraping, etc.) to provide up-to-date information.

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
- Automatic cost calculation with configurable pricing
- Cost tracking includes thinking tokens and tool usage

### Model Costs (per million tokens)
- **Configurable via environment variables** - see Model Cost Overrides above
- **Default costs:**
  - **Bigger Model**: $0.25 input / $2.00 output
  - **Smaller Model**: $0.05 input / $0.40 output
  - **Complexity Model**: $0.10 input / $0.40 output
- Note: Update these values in your `.env` file to match current OpenRouter pricing

### Security Features
- Bot creator privilege system
- Safe content handling
- Error recovery and graceful degradation
- Automatic token data persistence (stored in `token_data.json`)
- Notes persistence per user/guild (stored in `notes/users/*.json` and `notes/guilds/*.json`)
- Scheduled tasks persistence (stored in `cronjobs/users/*.json` and `cronjobs/guilds/*.json`)

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

- The model may use web search multiple times but will only use scraping tools once per request when needed

## Developer

Created by **kayfahaarukku**

---

*Last updated: Jan 2026*
