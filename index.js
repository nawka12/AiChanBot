require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const { scrapeUrl, scrapeMultipleUrls } = require('./scraper.js');
const { getTweets, getTweetByUrl, isTwitterUrl } = require('./nitter_tool.js');
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Constants
const AI_MODEL = "o4-mini";
const MAX_TOKENS = 16384;
const MAX_SEARCH_RESULTS = 3;
const MAX_MESSAGE_LENGTH = 2000;
const DATE_OPTIONS = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
const TIME_OPTIONS = { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta'  // GMT+7 timezone (Indonesia)
};

// Price per million tokens
const PROMPT_TOKEN_PRICE = 1.10;     // $1.10 per million tokens
const COMPLETION_TOKEN_PRICE = 4.40; // $4.40 per million tokens

// Add new variable to store startup time
const startupTime = new Date();

// Define token data file path
const TOKEN_DATA_FILE = path.join(__dirname, 'token_data.json');

// Add token tracking variables
let tokenTracking = {
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    trackingSince: new Date().toISOString() // Add tracking start date
};

// Load token tracking data if it exists
try {
    if (fs.existsSync(TOKEN_DATA_FILE)) {
        const data = fs.readFileSync(TOKEN_DATA_FILE, 'utf8');
        tokenTracking = JSON.parse(data);
        console.log('Loaded token tracking data from file');
    } else {
        console.log('No token tracking data file found, starting with zero counts');
    }
} catch (error) {
    console.error('Error loading token tracking data:', error);
}

// Function to save token tracking data
const saveTokenData = () => {
    try {
        fs.writeFileSync(TOKEN_DATA_FILE, JSON.stringify(tokenTracking, null, 2), 'utf8');
        console.log('Token tracking data saved to file');
    } catch (error) {
        console.error('Error saving token tracking data:', error);
    }
};

// Configuration
const config = {
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of Discord bot. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)} and the current time is ${new Date().toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7). If user is asking about time, always answer with the current time. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible. You have access to web search and web scraping tools. You can only use web scraping tools once. If it possible to answer the user's question with only web search, do not use web scraping tools. If the user's question needs web scraping, but not too complex, use web scrape instead of multi scrape. You cannot scrape files, only websites. You're currently talking to ${username}.`,
    querySystemMessage: (username) => `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    queryDeepSystemMessage: (username) => `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`,
};

// Tool definitions for function calling
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for information on a specific query. One time use.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_scrape",
      description: "Scrape content from a specific URL. DO NOT USE FOR X/TWITTER LINKS. One time use.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to scrape"
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "multi_scrape",
      description: "Scrape content from multiple URLs. DO NOT USE FOR X/TWITTER LINKS. One time use.",
      parameters: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: {
              type: "string"
            },
            description: "Array of URLs to scrape"
          }
        },
        required: ["urls"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "nitter_tweets",
      description: "Fetch recent tweets from a Twitter user via Nitter instances (does not require authentication). One time use.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Twitter username (with or without @)"
          },
          include_replies: {
            type: "boolean",
            description: "Whether to include replies by the user (default: false)"
          }
        },
        required: ["username"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tweet_url_scrape",
      description: "Scrape a specific tweet from Twitter/X via Nitter. Use this for direct tweet URLs instead of web_scrape. One time use.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the tweet (twitter.com or x.com)"
          }
        },
        required: ["url"]
      }
    }
  }
];

// Initialize clients
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.DirectMessageReactions
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User
    ]
});

const openai = new OpenAI({
    organization: process.env.OPENAI_ORG,
    apiKey: process.env.OPENAI_KEY,
});

// State management
const userConversations = {}; // For DM conversations
const guildConversations = {}; // For guild/server conversations
const userContexts = {};

// Helper functions
const processImages = async (attachments, userId, input) => {
    let imageDescriptions = [];

    for (const [, attachment] of attachments) {
        if (attachment.contentType.startsWith('image/')) {
            const imageResponse = await fetch(attachment.url);
            const imageBuffer = await imageResponse.buffer();
            const base64Image = imageBuffer.toString('base64');

            const imageAI = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: input || "What's in this image?" },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${attachment.contentType};base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_completion_tokens: MAX_TOKENS
            });

            const imageDescription = imageAI.choices[0].message.content;
            imageDescriptions.push(imageDescription);

            // Add image description to the conversation history
            if (!userConversations[userId]) {
                userConversations[userId] = [];
            }
            userConversations[userId].push({ role: "user", content: `[Image] ${input}` });
            userConversations[userId].push({ role: "assistant", content: imageDescription });
        }
    }

    return imageDescriptions.join('\n\n');
};

/**
 * Executes a specific tool call from OpenAI
 * @param {Object} toolCall - The tool call object from OpenAI
 * @returns {Promise<Object>} - The result of the tool execution
 */
async function executeToolCall(toolCall) {
    const functionName = toolCall.function.name;
    const functionArgs = JSON.parse(toolCall.function.arguments);
    let result;

    try {
        console.log(`Executing tool call: ${functionName} with arguments:`, functionArgs);
        
        if (functionName === "web_search") {
            try {
                // Execute search
                const searchData = await searchQuery(functionArgs.query);
                // Limit to MAX_SEARCH_RESULTS results
                const limitedResults = searchData.results ? searchData.results.slice(0, MAX_SEARCH_RESULTS) : [];
                result = {
                    results: limitedResults,
                    query: functionArgs.query,
                    total_count: limitedResults.length,
                    original_count: searchData.results?.length || 0
                };
            } catch (searchError) {
                console.error(`Search error for query "${functionArgs.query}":`, searchError);
                result = { 
                    error: `Search failed: ${searchError.message}`, 
                    errorCode: searchError.code || 'UNKNOWN',
                    query: functionArgs.query,
                    suggestion: "The search service might be unavailable. You can try again later or ask a different question."
                };
            }
        } 
        else if (functionName === "web_scrape") {
            try {
                const url = functionArgs.url;
                
                // Check if the URL is a Twitter/X URL
                if (isTwitterUrl(url)) {
                    console.log(`Detected Twitter/X URL, redirecting to tweet_url_scrape: ${url}`);
                    // Handle as a tweet URL scrape
                    const tweetData = await getTweetByUrl(url);
                    
                    if (tweetData.error) {
                        result = { 
                            error: tweetData.message,
                            url: url,
                            suggestion: "The Twitter/X content could not be retrieved via Nitter. You can try viewing it directly on Twitter."
                        };
                    } else {
                        // Format tweet data as a web scrape result
                        const tweet = tweetData.tweet;
                        const content = `Tweet by ${tweet.author} (@${tweet.username.replace('@', '')}):\n\n${tweet.text}\n\n` +
                                `Posted: ${tweet.dateText}\n` +
                                `Stats: ${tweet.stats.likes} likes, ${tweet.stats.retweets} retweets, ${tweet.stats.replies} replies\n` +
                                (tweet.media.length > 0 ? `Media: ${tweet.media.length} items\n` : '') +
                                (tweet.isReply ? `Reply to: ${tweet.replyTo}\n` : '') +
                                (tweet.isQuote ? `Quote of: ${tweet.quotedFrom}\n` : '') +
                                (tweet.conversationTweets && tweet.conversationTweets.length > 0 ? 
                                    `\nConversation (${tweet.conversationTweets.length} related tweets):\n` + 
                                    tweet.conversationTweets.map(t => `- ${t.username}: ${t.text}`).join('\n') : '');
                        
                        result = {
                            url: url,
                            content: content,
                            title: `Tweet by ${tweet.author}`,
                            tweet_data: tweet,
                            source: tweetData.source,
                            nitter_url: tweetData.url
                        };
                    }
                } else {
                    // Execute regular URL scrape
                    const scrapeData = await scrapeUrl(url);
                    result = {
                        url: url,
                        content: scrapeData.content || "No content found",
                        title: scrapeData.title || "Unknown title"
                    };
                }
            } catch (scrapeError) {
                console.error(`Scraping error for URL "${functionArgs.url}":`, scrapeError);
                result = { 
                    error: `Web scraping failed: ${scrapeError.message}`,
                    errorCode: scrapeError.code || 'UNKNOWN',
                    url: functionArgs.url,
                    suggestion: "The website might be unavailable or blocking access. You can try a different website or a general search query instead."
                };
            }
        }
        else if (functionName === "multi_scrape") {
            try {
                // Execute multiple URL scrapes
                const urls = functionArgs.urls;
                
                // Check each URL to see if it's a Twitter/X URL
                const results = await Promise.all(
                    urls.map(async (url) => {
                        try {
                            if (isTwitterUrl(url)) {
                                // Handle as a tweet URL scrape
                                const tweetData = await getTweetByUrl(url);
                                
                                if (tweetData.error) {
                                    return {
                                        url,
                                        error: tweetData.message,
                                        content: null,
                                        title: "Twitter Content"
                                    };
                                } else {
                                    // Format tweet data as a web scrape result
                                    const tweet = tweetData.tweet;
                                    const content = `Tweet by ${tweet.author} (@${tweet.username.replace('@', '')}):\n\n${tweet.text}\n\n` +
                                            `Posted: ${tweet.dateText}\n` +
                                            `Stats: ${tweet.stats.likes} likes, ${tweet.stats.retweets} retweets, ${tweet.stats.replies} replies\n` +
                                            (tweet.media.length > 0 ? `Media: ${tweet.media.length} items\n` : '') +
                                            (tweet.isReply ? `Reply to: ${tweet.replyTo}\n` : '') +
                                            (tweet.isQuote ? `Quote of: ${tweet.quotedFrom}\n` : '');
                                    
                                    return {
                                        url,
                                        content,
                                        title: `Tweet by ${tweet.author}`,
                                        tweet_data: tweet,
                                        source: tweetData.source,
                                        nitter_url: tweetData.url
                                    };
                                }
                            } else {
                                // Regular URL scraping
                                const scrapeData = await scrapeUrl(url);
                                return {
                                    url,
                                    content: scrapeData.content || "No content found",
                                    title: scrapeData.title || "Unknown title"
                                };
                            }
                        } catch (error) {
                            return {
                                url,
                                error: `Failed to scrape: ${error.message}`,
                                content: null,
                                title: "Error"
                            };
                        }
                    })
                );
                
                // Check if we got any successful scrapes
                const successfulScrapes = results.filter(item => 
                    !item.error && item.content && item.content.length > 100
                );
                
                if (successfulScrapes.length > 0) {
                    result = results;
                } else {
                    // All scrapes failed
                    result = { 
                        error: "All URL scraping attempts failed",
                        urls,
                        suggestion: "The websites might be unavailable or blocking access. You can try different websites or a general search query instead."
                    };
                }
            } catch (multiScrapeError) {
                console.error(`Multi-scraping error:`, multiScrapeError);
                result = { 
                    error: `Multi-scraping failed: ${multiScrapeError.message}`,
                    errorCode: multiScrapeError.code || 'UNKNOWN',
                    urls: functionArgs.urls,
                    suggestion: "The scraping service might be unavailable. You can try again later or ask a different question."
                };
            }
        }
        else if (functionName === "nitter_tweets") {
            try {
                // Execute Nitter tweets fetch
                const username = functionArgs.username;
                const includeReplies = functionArgs.include_replies || false;
                
                console.log(`Fetching tweets for user @${username}, include replies: ${includeReplies}`);
                
                const tweetsData = await getTweets(username, includeReplies);
                
                if (tweetsData.error) {
                    result = { 
                        error: tweetsData.message,
                        username: tweetsData.username,
                        suggestion: "The Nitter service might be unavailable. You can try again later or consider using the Twitter web interface directly."
                    };
                } else {
                    // Limit to 10 tweets to keep the response size reasonable
                    const limitedTweets = tweetsData.tweets.slice(0, 10);
                    
                    result = {
                        username: tweetsData.username,
                        tweets: limitedTweets,
                        count: limitedTweets.length,
                        total_count: tweetsData.count,
                        source: tweetsData.source,
                        includes_replies: tweetsData.includesReplies
                    };
                }
            } catch (nitterError) {
                console.error(`Nitter error for username "${functionArgs.username}":`, nitterError);
                result = { 
                    error: `Nitter tweets fetch failed: ${nitterError.message}`,
                    errorCode: nitterError.code || 'UNKNOWN',
                    username: functionArgs.username,
                    suggestion: "The Nitter service might be unavailable. You can try again later or consider using the Twitter web interface directly."
                };
            }
        }
        else if (functionName === "tweet_url_scrape") {
            try {
                // Execute tweet URL scrape
                const url = functionArgs.url;
                
                if (!isTwitterUrl(url)) {
                    throw new Error("The provided URL is not a Twitter/X URL");
                }
                
                console.log(`Scraping tweet from URL: ${url}`);
                
                const tweetData = await getTweetByUrl(url);
                
                if (tweetData.error) {
                    result = { 
                        error: tweetData.message,
                        url: url,
                        suggestion: "The Twitter/X content could not be retrieved via Nitter. You can try viewing it directly on Twitter."
                    };
                } else {
                    // Extract tweet data
                    const tweet = tweetData.tweet;
                    
                    result = {
                        tweet: tweet,
                        url: url,
                        nitter_url: tweetData.url,
                        source: tweetData.source
                    };
                }
            } catch (tweetError) {
                console.error(`Tweet scraping error for URL "${functionArgs.url}":`, tweetError);
                result = { 
                    error: `Tweet scraping failed: ${tweetError.message}`,
                    errorCode: tweetError.code || 'UNKNOWN',
                    url: functionArgs.url,
                    suggestion: "The tweet might be unavailable or the URL is invalid. Please check the URL and try again."
                };
            }
        }
        else {
            result = { 
                error: `Unknown tool: ${functionName}`,
                suggestion: "Please use one of the available tools: web_search, web_scrape, multi_scrape, nitter_tweets, or tweet_url_scrape." 
            };
        }
    } catch (error) {
        console.error(`Error executing tool ${functionName}:`, error);
        result = { 
            error: `Failed to execute tool ${functionName}: ${error.message}`,
            errorCode: error.code || 'UNKNOWN',
            details: error.toString(),
            suggestion: "There was a technical issue. You can try again later or ask a different question."
        };
    }

    return result;
}

const processContext = async (userId, guildId, messageCount = 10) => {
    const conversationHistory = guildId ? 
        guildConversations[guildId] : 
        userConversations[userId];
    
    if (!conversationHistory || conversationHistory.length < 2) return '';

    // Take last N messages instead of just 2
    const recentConversations = conversationHistory
        .slice(-messageCount)
        .map(conv => {
            if (typeof conv.content === 'string') {
                return conv.content;
            } else if (Array.isArray(conv.content)) {
                return conv.content.map(item => 
                    item.type === 'text' ? item.text : '[Image]'
                ).join(' ');
            }
            return JSON.stringify(conv.content);
        })
        .join('\n');

    const contextResponse = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
            { role: "system", content: config.contextSystemMessage },
            { role: "user", content: recentConversations }
        ],
        max_completion_tokens: 8192
    });
    
    const contextSummary = contextResponse.choices[0].message.content;
    console.log(`Generated context for ${userId}:`, contextSummary);
    return contextSummary;
};

const performSearch = async (command, queryResponse, commandContent, message) => {
    if (command === 'search') {
        let finalQuery = queryResponse.choices[0].message.content.trim();
        
        // Fallback: if no query generated, use the original commandContent
        if (!finalQuery) {
            console.warn("Query generation returned empty. Falling back to commandContent as query.");
            finalQuery = commandContent;
        }
        
        console.log('Search query:', finalQuery);
        await message.channel.send(`Searching the web for \`${finalQuery}\``);
        const searchResult = await searchQuery(finalQuery);
        
        if (!searchResult || !searchResult.results) {
            throw new Error('Invalid search results structure');
        }
        
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        let queriesRaw = queryResponse.choices[0].message.content;
        if (!queriesRaw.trim()) {
            console.warn("Query generation returned empty for deepsearch. Falling back to commandContent.");
            queriesRaw = commandContent;
        }
        const queries = queriesRaw.split(',').map(q => q.trim()).filter(q => q);
        
        if (!queries.length) {
            throw new Error('Empty search queries generated');
        }
        
        let allResults = [];
        
        for (let query of queries) {
            console.log('Deep search query:', query);
            await message.channel.send(`Searching the web for \`${query}\``);
            const searchResult = await searchQuery(query);
            
            if (!searchResult || !searchResult.results) {
                throw new Error('Invalid search results structure');
            }
            
            allResults = allResults.concat(searchResult.results.slice(0, MAX_SEARCH_RESULTS));
        }
        
        return formatSearchResults(allResults, commandContent);
    }
};

const formatSearchResults = (results, commandContent) => {
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
};

const splitMessage = (content) => {
    if (content.length <= MAX_MESSAGE_LENGTH) {
        return [content];
    }

    const parts = [];
    let currentPart = '';

    content.split('\n').forEach((line) => {
        if ((currentPart + line).length > MAX_MESSAGE_LENGTH) {
            parts.push(currentPart);
            currentPart = '';
        }
        currentPart += `${line}\n`;
    });

    if (currentPart.length > 0) {
        parts.push(currentPart);
    }

    return parts;
};

// Main message handler
client.on('messageCreate', async function(message) {
    try {
        if (message.author.bot || message.content.includes('@everyone') || message.content.includes('@here')) return;

        // Allow both DMs and mentions in servers
        if (message.channel.type !== 1 && !message.mentions.has(client.user)) return;

        const isDM = message.channel.type === 1;
        const guildId = isDM ? null : message.guild.id;

        // Modify the input to include username for guild messages
        const processedInput = isDM ? 
            message.content : 
            `[${message.author.username}]: ${message.content}`;

        // Initialize conversations if they don't exist
        if (isDM) {
            if (!userConversations[message.author.id]) {
                userConversations[message.author.id] = [];
            }
        } else {
            if (!guildConversations[guildId]) {
                guildConversations[guildId] = [];
            }
        }

        message.channel.sendTyping();

        const input = processedInput
            .replace(`<@${client.user.id}>`, '')
            .replace(/<@&\d+>/g, '')
            .trim();
        const [rawCommand, ...contentParts] = input.split(' ');
        const command = rawCommand.toLowerCase();
        const commandContent = contentParts.join(' ');

        if (command === 'reset') {
            if (isDM) {
                userConversations[message.author.id] = [];
                await message.reply("Ai-chan's personal conversations with you have been reset.");
            } else {
                guildConversations[guildId] = [];
                await message.reply("Ai-chan's server conversations have been reset.");
            }
            return;
        }

        let imageDescriptions = '';
        if (message.attachments.size > 0) {
            try {
                imageDescriptions = await processImages(message.attachments, message.author.id, input);
                console.log(`Images processed. Descriptions: ${imageDescriptions}`);
                
                // If it's offline mode, send the image descriptions as the response
                if (command !== 'search' && command !== 'deepsearch') {
                    const messageParts = splitMessage(imageDescriptions);
                    for (let i = 0; i < messageParts.length; i++) {
                        if (i === 0) {
                            await message.reply({
                                content: messageParts[i],
                                allowedMentions: { repliedUser: true },
                            });
                        } else {
                            await message.channel.send(messageParts[i]);
                        }
                    }
                    return; // Exit the function here for offline mode with images
                }
            } catch (error) {
                console.error("Error processing images:", error);
                await message.reply("Sorry, there was an error processing the images.");
                return;
            }
        }

        // Initialize user data if it doesn't exist
        if (!userContexts[message.author.id]) userContexts[message.author.id] = '';
        if (!userConversations[message.author.id]) userConversations[message.author.id] = [];

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                const context = await processContext(message.author.id, guildId, 10);
                
                // Build query context using any existing conversation context and/or image descriptions
                const queryContext = `${context ? `Context: ${context}\n` : ''}${
                    imageDescriptions ? `Image descriptions: ${imageDescriptions}\n` : ''
                }Question: ${commandContent}`;

                console.log('Query Context:', queryContext);

                const queryResponse = await openai.chat.completions.create({
                    model: AI_MODEL,
                    messages: [
                        {
                            role: "developer",
                            content: command === 'search'
                                ? config.querySystemMessage(message.author.username)
                                : config.queryDeepSystemMessage(message.author.username)
                        },
                        { role: "user", content: queryContext }
                    ],
                    max_completion_tokens: 8192
                });
                
                console.log('Query Response:', queryResponse.choices[0].message.content);

                searchContent = await performSearch(command, queryResponse, commandContent, message);
                messages.push({ role: "user", content: searchContent });
            } catch (error) {
                console.error("Search Error:", error);
                await message.reply(`There was an error processing your search request: ${error.message}`);
                return;
            }
        } else {
            messages.push({ role: "user", content: input });
            if (imageDescriptions) {
                messages.push({ role: "assistant", content: imageDescriptions });
            }
            if (userConversations[message.author.id].length >= 2) {
                userContexts[message.author.id] = await processContext(message.author.id, guildId, 10);
            }
        }

        messages = [...userConversations[message.author.id], ...messages];
        messages = messages.filter((message, index, self) =>
            index === self.findIndex((t) => t.role === message.role && t.content === message.content)
        );

        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

        try {
            // First API call with tools
            const gptResponse = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: [
                    { role: "developer", content: config.systemMessage(command, message.author.username) },
                    ...messages
                ],
                max_completion_tokens: MAX_TOKENS,
                reasoning_effort: "high",
                tools: TOOL_SCHEMAS
            });

            let finalResponse = gptResponse.choices[0].message;
            let responseContent = finalResponse.content;
            
            // Check if the model wants to use a tool
            if (finalResponse.tool_calls && finalResponse.tool_calls.length > 0) {
                // Send notification that tools are being used
                await message.channel.send("Ai-chan is using tools to find information...");
                
                // Process tool calls
                const toolCalls = finalResponse.tool_calls;
                const toolResults = [];
                
                for (const toolCall of toolCalls) {
                    const result = await executeToolCall(toolCall);
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: toolCall.function.name,
                        content: JSON.stringify(result)
                    });
                }
                
                // Add tool results to the conversation
                const secondResponse = await openai.chat.completions.create({
                    model: AI_MODEL,
                    messages: [
                        { role: "developer", content: config.systemMessage(command, message.author.username) },
                        ...messages,
                        finalResponse,
                        ...toolResults
                    ],
                    max_completion_tokens: MAX_TOKENS,
                    reasoning_effort: "high",
                });
                
                finalResponse = secondResponse.choices[0].message;
                responseContent = finalResponse.content;
                
                // Update token usage tracking
                if (secondResponse.usage) {
                    tokenTracking.lifetimeInputTokens += secondResponse.usage.prompt_tokens || 0;
                    tokenTracking.lifetimeOutputTokens += secondResponse.usage.completion_tokens || 0;
                    saveTokenData();
                }
            }

            // Update conversation history
            userConversations[message.author.id].push({ role: "user", content: input });
            userConversations[message.author.id].push({ role: "assistant", content: responseContent });

            const messageParts = splitMessage(responseContent);

            // Calculate token usage and cost
            const promptTokens = gptResponse.usage.prompt_tokens;
            const completionTokens = gptResponse.usage.completion_tokens;
            const totalTokens = gptResponse.usage.total_tokens;
            const cost = (
                (promptTokens * (PROMPT_TOKEN_PRICE / 1000000)) + 
                (completionTokens * (COMPLETION_TOKEN_PRICE / 1000000))
            ).toFixed(6);
            const usageInfo = `\`\`\`Token Used: ${totalTokens}\nCost: $${cost}\`\`\``;

            for (let i = 0; i < messageParts.length; i++) {
                const content = i === messageParts.length - 1 
                    ? `${messageParts[i]}\n\n${usageInfo}`
                    : messageParts[i];

                if (i === 0) {
                    await message.reply({
                        content,
                        allowedMentions: { repliedUser: true },
                    });
                } else {
                    await message.channel.send(content);
                }
            }
            
            // Update token tracking
            tokenTracking.lifetimeInputTokens += promptTokens;
            tokenTracking.lifetimeOutputTokens += completionTokens;
            saveTokenData();
        } catch (error) {
            console.error("API Error:", error);
            await message.reply(`There was an error processing your request.`);
        }
    } catch (err) {
        console.error("General Error:", err);
    }
});

// Add a ready event handler to verify intents
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Set the bot's status message
    client.user.setPresence({
        activities: [{
            name: `Last reset: ${startupTime.toLocaleDateString('en-US', DATE_OPTIONS)} ${startupTime.toLocaleTimeString('en-US', TIME_OPTIONS)} (GMT+7)`,
            type: ActivityType.Custom
        }],
        status: 'online'
    });
});

client.login(process.env.DISCORD_TOKEN);
console.log("Ai-chan is Online");
