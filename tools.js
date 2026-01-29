const { searchQuery } = require('./searchlogic.js');
const { scrapeUrl, scrapeMultipleUrls } = require('./scraper.js');
const { getTweets, getTweetByUrl, isTwitterUrl } = require('./nitter_tool.js');
const scheduler = require('./scheduler.js');
const fs = require('fs');
const path = require('path');

/**
 * Tools implementation for Claude API integration
 * Based on https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
 */

const MAX_SEARCH_RESULTS = 6;

// Notes system constants
const NOTES_DIR = path.join(__dirname, 'notes');
const USERS_DIR = path.join(NOTES_DIR, 'users');
const GUILDS_DIR = path.join(NOTES_DIR, 'guilds');

/**
 * Helper function to get note file path
 * @param {string} userId - User ID for user notes
 * @param {string} guildId - Guild ID for guild notes (optional)
 * @returns {string} File path for the note data
 */
function getNoteFilePath(userId, guildId = null) {
  if (guildId) {
    return path.join(GUILDS_DIR, `${guildId}.json`);
  } else {
    return path.join(USERS_DIR, `${userId}.json`);
  }
}

/**
 * Helper function to load notes from file
 * @param {string} filePath - Path to the note file
 * @returns {Object} Note data or empty object if file doesn't exist
 */
function loadNotes(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`Error loading notes from ${filePath}:`, error);
  }
  return {};
}

/**
 * Helper function to save notes to file
 * @param {string} filePath - Path to the note file
 * @param {Object} notes - Note data to save
 */
function saveNotes(filePath, notes) {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(notes, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error saving notes to ${filePath}:`, error);
    throw error;
  }
}

/**
 * Helper function to validate note data
 * @param {string} key - Note key
 * @param {string} content - Note content
 * @param {Array} tags - Note tags (optional)
 * @returns {Object} Validation result with isValid and error message
 */
function validateNote(key, content, tags = []) {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return { isValid: false, error: 'Note key cannot be empty' };
  }

  if (key.length > 100) {
    return { isValid: false, error: 'Note key cannot exceed 100 characters' };
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { isValid: false, error: 'Note content cannot be empty' };
  }

  if (content.length > 10000) {
    return { isValid: false, error: 'Note content cannot exceed 10,000 characters' };
  }

  // Check for invalid characters in key
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return { isValid: false, error: 'Note key can only contain letters, numbers, underscores, and hyphens' };
  }

  // Validate tags if provided
  if (tags && Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0) {
        return { isValid: false, error: 'Tags must be non-empty strings' };
      }
      if (tag.length > 50) {
        return { isValid: false, error: 'Each tag cannot exceed 50 characters' };
      }
    }
  }

  return { isValid: true };
}

/**
 * Helper function to ensure notes directories exist
 */
function ensureNotesDirectories() {
  try {
    if (!fs.existsSync(NOTES_DIR)) {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
    }
    if (!fs.existsSync(USERS_DIR)) {
      fs.mkdirSync(USERS_DIR, { recursive: true });
    }
    if (!fs.existsSync(GUILDS_DIR)) {
      fs.mkdirSync(GUILDS_DIR, { recursive: true });
    }
  } catch (error) {
    console.error('Error creating notes directories:', error);
  }
}

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
  },
  {
    name: "note",
    description: "Manage personal or guild notes as a persistent knowledge base. CRITICAL SCOPING RULES: 'user' scope ONLY works in DMs (private messages), 'guild' scope ONLY works in the specific guild where the command is used. User notes are completely isolated from guild contexts and vice versa.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "get", "list", "search", "delete", "delete_all"],
          description: "Action to perform: save (create/update note), get (retrieve note), list (show all notes), search (find notes by content/tags), delete (remove note), delete_all (remove all notes)"
        },
        key: {
          type: "string",
          description: "Note identifier (required for save, get, delete). Max 100 chars, alphanumeric + underscore/hyphen only."
        },
        content: {
          type: "string",
          description: "Note content (required for save). Can include rich text, links, and structured information. Max 10,000 characters."
        },
        tags: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Optional tags for organizing notes (array of strings)"
        },
        query: {
          type: "string",
          description: "Search query (required for search action). Searches note keys, content, and tags."
        },
        scope: {
          type: "string",
          enum: ["user", "guild"],
          description: "SCOPE RESTRICTIONS: 'user' = personal notes accessible ONLY in DMs/private messages. 'guild' = server notes accessible ONLY in the specific guild where saved. Cross-context access is NOT allowed."
        }
      },
      required: ["action", "scope"]
    }
  },
  {
    name: "schedule",
    description: "Create timers (one-shot delayed tasks) or cron jobs (recurring scheduled tasks). Use for reminders, scheduled messages, or recurring AI-generated content. SCOPE RULES: 'user' scope for DMs only, 'guild' scope for server channels only. Guild scope requires 'Manage Server' permission.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "delete", "toggle"],
          description: "Action to perform: create (new timer/cron), list (show all schedules), delete (remove schedule), toggle (enable/disable)"
        },
        taskType: {
          type: "string",
          enum: ["timer", "cron"],
          description: "Task type: 'timer' for one-shot delayed execution (auto-deletes after running), 'cron' for recurring scheduled tasks"
        },
        name: {
          type: "string",
          description: "Optional name/description for the task (e.g., 'Morning Weather', 'Daily Reminder')"
        },
        schedule: {
          type: "string",
          description: "For timer: duration like '1 minute', '30 minutes', '2 hours'. For cron: cron expression like '0 8 * * *' (every day at 8 AM), '0 9 * * 1-5' (weekdays at 9 AM), '0 10 * * 0,6' (weekends at 10 AM)"
        },
        actionType: {
          type: "string",
          enum: ["preset", "ai"],
          description: "What to do when triggered: 'preset' sends a fixed message, 'ai' generates an AI response from a prompt"
        },
        content: {
          type: "string",
          description: "Message to send (required for actionType 'preset')"
        },
        prompt: {
          type: "string",
          description: "Prompt for AI to generate response (required for actionType 'ai'). Example: 'Give me today\\'s weather for Jakarta'"
        },
        taskId: {
          type: "string",
          description: "Task ID (required for delete and toggle actions)"
        },
        scope: {
          type: "string",
          enum: ["user", "guild"],
          description: "SCOPE RESTRICTIONS: 'user' = personal schedules in DMs only. 'guild' = server schedules in guild channels only (requires Manage Server permission)."
        }
      },
      required: ["action", "scope"]
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
          // Limit results maximum
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
      else if (name === "note") {
        try {
          const { action, key, content, tags, scope } = input;

          // Validate scope
          if (!['user', 'guild'].includes(scope)) {
            result = {
              error: "Invalid scope. Must be 'user' or 'guild'",
              action,
              scope
            };
          } else {
            // Get context from the tool input (passed from main handler)
            const userId = input.userId;
            const guildId = scope === 'guild' ? input.guildId : null;

            // Validate that we have the required context
            if (!userId) {
              result = {
                error: "Missing user context. Cannot access notes without user information.",
                action,
                scope
              };
            } else if (scope === 'guild' && !guildId) {
              // Do NOT fallback to user notes when guild scope is requested
              result = {
                error: "Guild scope requires a valid guildId. Note was not saved.",
                action,
                scope
              };
            } else if (scope === 'user' && input.guildId) {
              // Prevent user notes in guild context
              result = {
                error: "User notes can only be accessed in DMs (private messages). Use scope 'guild' for server notes.",
                action,
                scope,
                hint: "User notes are private and only accessible in direct messages. For server-wide notes, use scope 'guild'."
              };
            } else if (scope === 'guild' && !input.guildId) {
              // Prevent guild notes in DM context  
              result = {
                error: "Guild notes can only be accessed within a server. Use scope 'user' for personal notes in DMs.",
                action,
                scope,
                hint: "Guild notes are server-specific and only accessible within that server. For personal notes in DMs, use scope 'user'."
              };
            } else {
              // Ensure directories exist
              ensureNotesDirectories();

              const filePath = getNoteFilePath(userId, guildId);
              let notes = loadNotes(filePath);

              switch (action) {
                case 'save':
                  if (!key || !content) {
                    result = {
                      error: "Both 'key' and 'content' are required for save action",
                      action,
                      scope
                    };
                  } else {
                    const validation = validateNote(key, content, tags);
                    if (!validation.isValid) {
                      result = {
                        error: validation.error,
                        action,
                        scope,
                        key
                      };
                    } else {
                      notes[key] = {
                        content: content.trim(),
                        tags: tags || [],
                        created_at: notes[key]?.created_at || new Date().toISOString(),
                        updated_at: new Date().toISOString()
                      };
                      saveNotes(filePath, notes);
                      result = {
                        success: true,
                        action: 'save',
                        scope,
                        key,
                        message: `Note '${key}' saved successfully`
                      };
                    }
                  }
                  break;

                case 'get':
                  if (!key) {
                    result = {
                      error: "'key' is required for get action",
                      action,
                      scope
                    };
                  } else if (!notes[key]) {
                    result = {
                      error: `Note '${key}' not found`,
                      action,
                      scope,
                      key,
                      available_keys: Object.keys(notes)
                    };
                  } else {
                    result = {
                      success: true,
                      action: 'get',
                      scope,
                      key,
                      content: notes[key].content,
                      tags: notes[key].tags || [],
                      created_at: notes[key].created_at,
                      updated_at: notes[key].updated_at
                    };
                  }
                  break;

                case 'list':
                  const noteKeys = Object.keys(notes);
                  if (noteKeys.length === 0) {
                    result = {
                      success: true,
                      action: 'list',
                      scope,
                      count: 0,
                      notes: [],
                      message: `No ${scope} notes found`
                    };
                  } else {
                    const noteList = noteKeys.map(key => ({
                      key,
                      content: notes[key].content, // Show full content instead of truncated preview
                      tags: notes[key].tags || [],
                      created_at: notes[key].created_at,
                      updated_at: notes[key].updated_at
                    }));
                    result = {
                      success: true,
                      action: 'list',
                      scope,
                      count: noteKeys.length,
                      notes: noteList
                    };
                  }
                  break;

                case 'search':
                  const query = input.query || '';
                  if (!query.trim()) {
                    result = {
                      error: "Search query is required for search action",
                      action,
                      scope
                    };
                  } else {
                    const noteKeys = Object.keys(notes);
                    const searchResults = [];

                    for (const noteKey of noteKeys) {
                      const note = notes[noteKey];
                      const searchableText = `${noteKey} ${note.content} ${note.tags?.join(' ') || ''}`.toLowerCase();
                      const searchQuery = query.toLowerCase();

                      if (searchableText.includes(searchQuery)) {
                        searchResults.push({
                          key: noteKey,
                          content: note.content, // Show full content instead of truncated preview
                          tags: note.tags || [],
                          created_at: note.created_at,
                          updated_at: note.updated_at
                        });
                      }
                    }

                    result = {
                      success: true,
                      action: 'search',
                      scope,
                      query,
                      count: searchResults.length,
                      notes: searchResults
                    };
                  }
                  break;

                case 'delete':
                  if (!key) {
                    result = {
                      error: "'key' is required for delete action",
                      action,
                      scope
                    };
                  } else if (!notes[key]) {
                    result = {
                      error: `Note '${key}' not found`,
                      action,
                      scope,
                      key,
                      available_keys: Object.keys(notes)
                    };
                  } else {
                    delete notes[key];
                    saveNotes(filePath, notes);
                    result = {
                      success: true,
                      action: 'delete',
                      scope,
                      key,
                      message: `Note '${key}' deleted successfully`
                    };
                  }
                  break;

                case 'delete_all':
                  const noteCount = Object.keys(notes).length;
                  if (noteCount === 0) {
                    result = {
                      error: `No ${scope} notes to delete`,
                      action,
                      scope
                    };
                  } else {
                    // Clear all notes
                    const emptyNotes = {};
                    saveNotes(filePath, emptyNotes);
                    result = {
                      success: true,
                      action: 'delete_all',
                      scope,
                      deleted_count: noteCount,
                      message: `All ${noteCount} ${scope} notes deleted successfully`
                    };
                  }
                  break;

                default:
                  result = {
                    error: `Unknown action: ${action}`,
                    action,
                    scope,
                    available_actions: ['save', 'get', 'list', 'search', 'delete', 'delete_all']
                  };
              }
            }
          }
        } catch (noteError) {
          console.error(`Note tool error:`, noteError);
          result = {
            error: `Note operation failed: ${noteError.message}`,
            action: input.action,
            scope: input.scope,
            suggestion: "There was an issue with the notes system. Please try again."
          };
        }
      }
      else if (name === "schedule") {
        try {
          const { action, taskType, name: taskName, schedule: scheduleExpr, actionType, content, prompt, taskId, scope } = input;

          // Validate scope
          if (!['user', 'guild'].includes(scope)) {
            result = {
              error: "Invalid scope. Must be 'user' or 'guild'",
              action,
              scope
            };
          } else {
            // Get context from the tool input (passed from main handler)
            const userId = input.userId;
            const guildId = scope === 'guild' ? input.guildId : null;
            const channelId = input.channelId;
            const hasManageGuild = input.hasManageGuild;

            // Validate context
            if (!userId) {
              result = {
                error: "Missing user context. Cannot access schedules without user information.",
                action,
                scope
              };
            } else if (scope === 'guild' && !guildId) {
              result = {
                error: "Guild scope requires a valid guildId. Schedules can only be created in server channels.",
                action,
                scope
              };
            } else if (scope === 'user' && input.guildId) {
              result = {
                error: "User schedules can only be created in DMs (private messages). Use scope 'guild' for server schedules.",
                action,
                scope,
                hint: "User schedules are private and only work in direct messages. For server-wide schedules, use scope 'guild'."
              };
            } else if (scope === 'guild' && !input.guildId) {
              result = {
                error: "Guild schedules can only be created within a server. Use scope 'user' for personal schedules in DMs.",
                action,
                scope,
                hint: "Guild schedules are server-specific. For personal schedules in DMs, use scope 'user'."
              };
            } else if (scope === 'guild' && !hasManageGuild) {
              result = {
                error: "You need 'Manage Server' permission to create guild schedules.",
                action,
                scope
              };
            } else {
              const scopeId = scope === 'guild' ? guildId : userId;

              switch (action) {
                case 'create':
                  if (!taskType) {
                    result = {
                      error: "'taskType' is required (timer or cron)",
                      action,
                      scope
                    };
                  } else if (!scheduleExpr) {
                    result = {
                      error: "'schedule' is required. For timers: '1 minute', '30 minutes'. For cron: '0 8 * * *'",
                      action,
                      scope
                    };
                  } else if (!actionType) {
                    result = {
                      error: "'actionType' is required (preset or ai)",
                      action,
                      scope
                    };
                  } else if (!channelId) {
                    result = {
                      error: "Channel ID is required for scheduling",
                      action,
                      scope
                    };
                  } else {
                    const createResult = scheduler.createSchedule(scope, scopeId, {
                      taskType,
                      name: taskName,
                      schedule: scheduleExpr,
                      duration: scheduleExpr,
                      actionType,
                      content,
                      prompt,
                      channelId,
                      createdBy: userId
                    });

                    if (createResult.error) {
                      result = {
                        error: createResult.error,
                        action,
                        scope,
                        current: createResult.current,
                        max: createResult.max
                      };
                    } else {
                      result = {
                        success: true,
                        action: 'create',
                        scope,
                        task: {
                          id: createResult.task.id,
                          name: createResult.task.name,
                          taskType: createResult.task.taskType,
                          scheduleDescription: createResult.task.scheduleDescription,
                          actionType: createResult.task.actionType,
                          enabled: createResult.task.enabled
                        },
                        message: `${taskType === 'timer' ? 'Timer' : 'Cron job'} "${createResult.task.name}" created successfully. ${createResult.task.scheduleDescription}.`
                      };
                    }
                  }
                  break;

                case 'list':
                  const schedules = scheduler.getSchedules(scope, scopeId);
                  if (schedules.length === 0) {
                    result = {
                      success: true,
                      action: 'list',
                      scope,
                      count: 0,
                      schedules: [],
                      message: `No ${scope} schedules found`
                    };
                  } else {
                    const scheduleList = schedules.map(t => ({
                      id: t.id,
                      name: t.name,
                      taskType: t.taskType,
                      scheduleDescription: t.scheduleDescription,
                      actionType: t.actionType,
                      enabled: t.enabled,
                      lastRun: t.lastRun,
                      runCount: t.runCount
                    }));
                    result = {
                      success: true,
                      action: 'list',
                      scope,
                      count: schedules.length,
                      schedules: scheduleList
                    };
                  }
                  break;

                case 'delete':
                  if (!taskId) {
                    result = {
                      error: "'taskId' is required for delete action",
                      action,
                      scope
                    };
                  } else {
                    const deleteResult = scheduler.deleteSchedule(scope, scopeId, taskId);
                    if (deleteResult.error) {
                      result = {
                        error: deleteResult.error,
                        action,
                        scope,
                        taskId
                      };
                    } else {
                      result = {
                        success: true,
                        action: 'delete',
                        scope,
                        taskId,
                        deletedTask: {
                          name: deleteResult.deletedTask.name,
                          taskType: deleteResult.deletedTask.taskType
                        },
                        message: `Schedule "${deleteResult.deletedTask.name}" deleted successfully`
                      };
                    }
                  }
                  break;

                case 'toggle':
                  if (!taskId) {
                    result = {
                      error: "'taskId' is required for toggle action",
                      action,
                      scope
                    };
                  } else {
                    const toggleResult = scheduler.toggleSchedule(scope, scopeId, taskId);
                    if (toggleResult.error) {
                      result = {
                        error: toggleResult.error,
                        action,
                        scope,
                        taskId
                      };
                    } else {
                      result = {
                        success: true,
                        action: 'toggle',
                        scope,
                        taskId,
                        enabled: toggleResult.enabled,
                        message: `Schedule "${toggleResult.task.name}" is now ${toggleResult.enabled ? 'enabled' : 'disabled'}`
                      };
                    }
                  }
                  break;

                default:
                  result = {
                    error: `Unknown action: ${action}`,
                    action,
                    scope,
                    available_actions: ['create', 'list', 'delete', 'toggle']
                  };
              }
            }
          }
        } catch (scheduleError) {
          console.error(`Schedule tool error:`, scheduleError);
          result = {
            error: `Schedule operation failed: ${scheduleError.message}`,
            action: input.action,
            scope: input.scope,
            suggestion: "There was an issue with the scheduler. Please try again."
          };
        }
      }
      else {
        result = {
          error: `Unknown tool: ${name}`,
          suggestion: "Please use one of the available tools: web_search, web_scrape, multi_scrape, nitter_tweets, tweet_url_scrape, note, or schedule."
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

module.exports = {
  TOOL_SCHEMAS,
  executeToolCalls
}; 