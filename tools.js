const { searchQuery } = require('./searchlogic.js');
const { scrapeUrl, scrapeMultipleUrls } = require('./scraper.js');
const { getTweets, getTweetByUrl, isTwitterUrl } = require('./nitter_tool.js');

/**
 * Tools implementation for Claude API integration
 * Based on https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
 */

const MAX_SEARCH_RESULTS = 3;

// Tool schemas
const TOOL_SCHEMAS = [
  {
    name: "web_search",
    description: "Search the web for information on a specific query. One time use.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "web_scrape",
    description: "Scrape content from a specific URL. DO NOT USE FOR X/TWITTER LINKS. One time use.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to scrape"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "multi_scrape",
    description: "Scrape content from multiple URLs. DO NOT USE FOR X/TWITTER LINKS. One time use.",
    input_schema: {
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
  },
  {
    name: "nitter_tweets",
    description: "Fetch recent tweets from a Twitter user via Nitter instances (does not require authentication). One time use.",
    input_schema: {
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
  },
  {
    name: "tweet_url_scrape",
    description: "Scrape a specific tweet from Twitter/X via Nitter. Use this for direct tweet URLs instead of web_scrape. One time use.",
    input_schema: {
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
];

/**
 * Handles execution of tool calls from Claude
 * @param {Array} toolCalls - The tool calls from Claude's response
 * @returns {Promise<Array>} - A promise that resolves to an array of tool results
 */
async function executeToolCalls(toolCalls) {
  const toolResults = [];

  for (const call of toolCalls) {
    const { id, name, input } = call;
    let result;

    try {
      console.log(`Executing tool call: ${name} with input:`, input);
      
      if (name === "web_search") {
        try {
          // Execute search
          const searchData = await searchQuery(input.query);
          // Limit to 6 results maximum
          const limitedResults = searchData.results ? searchData.results.slice(0, MAX_SEARCH_RESULTS) : [];
          result = {
            results: limitedResults,
            query: input.query,
            total_count: limitedResults.length,
            original_count: searchData.results?.length || 0
          };
        } catch (searchError) {
          console.error(`Search error for query "${input.query}":`, searchError);
          result = { 
            error: `Search failed: ${searchError.message}`, 
            errorCode: searchError.code || 'UNKNOWN',
            query: input.query,
            suggestion: "The search service might be unavailable. You can try again later or ask a different question."
          };
        }
      } 
      else if (name === "web_scrape") {
        try {
          const url = input.url;
          
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
          console.error(`Scraping error for URL "${input.url}":`, scrapeError);
          result = { 
            error: `Web scraping failed: ${scrapeError.message}`,
            errorCode: scrapeError.code || 'UNKNOWN',
            url: input.url,
            suggestion: "The website might be unavailable or blocking access. You can try a different website or a general search query instead."
          };
        }
      }
      else if (name === "multi_scrape") {
        try {
          // Execute multiple URL scrapes
          const urls = input.urls;
          
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
            urls: input.urls,
            suggestion: "The scraping service might be unavailable. You can try again later or ask a different question."
          };
        }
      }
      else if (name === "nitter_tweets") {
        try {
          // Execute Nitter tweets fetch
          const username = input.username;
          const includeReplies = input.include_replies || false;
          
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
          console.error(`Nitter error for username "${input.username}":`, nitterError);
          result = { 
            error: `Nitter tweets fetch failed: ${nitterError.message}`,
            errorCode: nitterError.code || 'UNKNOWN',
            username: input.username,
            suggestion: "The Nitter service might be unavailable. You can try again later or consider using the Twitter web interface directly."
          };
        }
      }
      else if (name === "tweet_url_scrape") {
        try {
          // Execute tweet URL scrape
          const url = input.url;
          
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
          console.error(`Tweet scraping error for URL "${input.url}":`, tweetError);
          result = { 
            error: `Tweet scraping failed: ${tweetError.message}`,
            errorCode: tweetError.code || 'UNKNOWN',
            url: input.url,
            suggestion: "The tweet might be unavailable or the URL is invalid. Please check the URL and try again."
          };
        }
      }
      else {
        result = { 
          error: `Unknown tool: ${name}`,
          suggestion: "Please use one of the available tools: web_search, web_scrape, multi_scrape, nitter_tweets, or tweet_url_scrape." 
        };
      }
    } catch (error) {
      console.error(`Error executing tool ${name}:`, error);
      result = { 
        error: `Failed to execute tool ${name}: ${error.message}`,
        errorCode: error.code || 'UNKNOWN',
        details: error.toString(),
        suggestion: "There was a technical issue. You can try again later or ask a different question."
      };
    }

    toolResults.push({
      tool_call_id: id,
      output: JSON.stringify(result)
    });
  }

  return toolResults;
}

// Add mock functions if scrapeUrl doesn't exist
if (typeof scrapeUrl === 'undefined') {
  console.log("Warning: Using mock implementation for scrapeUrl");
  // Create mock implementation for testing
  module.exports.scrapeUrl = async function(url) {
    return {
      url,
      content: `Mock content for ${url}`,
      title: `Mock Page Title for ${url}`
    };
  };
}

if (typeof scrapeMultipleUrls === 'undefined') {
  console.log("Warning: Using mock implementation for scrapeMultipleUrls");
  // Create mock implementation for testing
  module.exports.scrapeMultipleUrls = async function(urls) {
    return urls.map(url => ({
      url,
      content: `Mock content for ${url}`,
      title: `Mock Page Title for ${url}`
    }));
  };
}

function parseNumber(text) {
  if (!text || text.trim() === '') return 0;
  text = text.trim();
  
  // Check if it's an abbreviated number
  if (text.endsWith('k') || text.endsWith('K')) {
    return Math.round(parseFloat(text.slice(0, -1)) * 1000);
  }
  if (text.endsWith('m') || text.endsWith('M')) {
    return Math.round(parseFloat(text.slice(0, -1)) * 1000000);
  }
  
  return parseInt(text, 10) || 0;
}

module.exports = {
  TOOL_SCHEMAS,
  executeToolCalls
}; 