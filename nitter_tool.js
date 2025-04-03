const axios = require('axios');
const cheerio = require('cheerio');

// Core functionality adapted from tweets.js
function parseTwitterDate(dateStr) {
    try {
        // Remove UTC and dot from the string
        const cleanDateStr = dateStr.replace(' UTC', '').replace(' · ', ' ');
        
        // Parse the UTC date
        const utcDate = new Date(cleanDateStr + ' UTC');
        
        // Convert to local timestamp
        const localTimestamp = utcDate.getTime();
        
        // Create new date object in local timezone
        const localDate = new Date(localTimestamp);
        
        console.log('Date conversion:', {
            original: dateStr,
            cleaned: cleanDateStr,
            utc: utcDate.toISOString(),
            local: localDate.toLocaleString()
        });
        
        return localDate;
    } catch (error) {
        console.warn('Error parsing date:', dateStr, error);
        return null;
    }
}

/**
 * Get random user agent to avoid blocks
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.2045.47',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/118.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Parse a number that might include "k" or "M" abbreviations
 * @param {string} text - Text containing a number, potentially with abbreviations
 * @returns {number} - Parsed number
 */
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

/**
 * CORS proxies to use when making requests
 */
const corsProxies = [
    'https://api.codetabs.com/v1/proxy?quest='
];

/**
 * Nitter instances to try in order
 */
const NITTER_INSTANCES = [
    'https://nitter.moonaroh.com',
    'https://nitter.privacydev.net',
    'https://nitter.1d4.us',
    'https://nitter.kavin.rocks',
    'https://nitter.unixfox.eu'
];

/**
 * Convert a Twitter/X URL to a Nitter URL
 * @param {string} url - The Twitter/X URL to convert
 * @param {string} nitterBase - The Nitter instance to use
 * @returns {string} - The converted Nitter URL
 */
function convertToNitterUrl(url, nitterBase) {
    try {
        // Check if it's already a Nitter URL
        if (url.includes('nitter.')) {
            return url;
        }
        
        // Replace twitter.com or x.com with the Nitter instance
        let nitterUrl = url.replace(/https?:\/\/(www\.)?(twitter\.com|x\.com)/, nitterBase);
        
        // Clean up any query parameters
        nitterUrl = nitterUrl.split('?')[0];
        
        return nitterUrl;
    } catch (error) {
        console.warn('Error converting URL:', error);
        return url;
    }
}

/**
 * Check if a URL is a Twitter/X URL
 * @param {string} url - The URL to check
 * @returns {boolean} - Whether the URL is a Twitter/X URL
 */
function isTwitterUrl(url) {
    return url && (url.includes('twitter.com') || url.includes('x.com'));
}

/**
 * Process tweet HTML content and extract structured data
 * @param {string} html - The HTML content of the Nitter page
 * @param {string} nitterBase - Base URL of the Nitter instance used
 * @returns {Array} - Array of parsed tweets
 */
function processTweetsHtml(html, nitterBase) {
    // Use cheerio instead of DOMParser for Node.js environment
    const $ = cheerio.load(html);
    
    // Find all timeline items within the timeline container
    const timelineItems = $('.timeline .timeline-item');
    console.log(`Found timeline items:`, timelineItems.length);
    
    const tweets = [];
    
    timelineItems.each((index, item) => {
        try {
            // Skip pinned tweets
            const isPinned = $(item).find('.pinned').length > 0;
            if (isPinned) {
                console.log('Skipping pinned tweet');
                return; // continue in jQuery each
            }

            // Check for reply
            const replyHeader = $(item).find('.replying-to');
            const isReply = replyHeader.length > 0;
            let replyTo = '';
            if (isReply) {
                const replyUsername = replyHeader.find('a').text().trim();
                if (replyUsername) {
                    replyTo = replyUsername;
                }
            }

            // Check for retweet
            const retweetHeader = $(item).find('.retweet-header');
            const isRetweet = retweetHeader.length > 0;
            let retweetedFrom = '';
            if (isRetweet) {
                // Get the original tweet's author
                const originalAuthor = $(item).find('.fullname').text().trim();
                const originalUsername = $(item).find('.username').text().trim();
                if (originalUsername) {
                    retweetedFrom = originalUsername;
                }
            }

            // Check for quote tweet
            const quoteTweet = $(item).find('.quote');
            const isQuote = quoteTweet.length > 0;
            let quotedFrom = '';
            let quotedTweetId = '';
            if (isQuote) {
                const quoteUsername = quoteTweet.find('.username').text().trim();
                const quoteLink = quoteTweet.find('a.quote-link').attr('href');
                if (quoteUsername) {
                    quotedFrom = quoteUsername;
                    quotedTweetId = quoteLink ? quoteLink.split('/status/')[1]?.split('#')[0] : '';
                }
            }

            // Get tweet content
            const contentElement = $(item).find('.tweet-content');
            if (contentElement.length === 0) {
                console.log('No content element found');
                return; // continue
            }
            let content = contentElement.text().trim();

            // Get tweet ID from the link
            const tweetLink = $(item).find('a.tweet-link');
            const tweetLinkHref = tweetLink.attr('href');
            const tweetId = tweetLinkHref ? tweetLinkHref.split('/status/')[1]?.split('#')[0] : null;
            if (!tweetId) {
                console.log('No tweet ID found');
                return; // continue
            }

            // Get timestamp from tweet-date
            const dateElement = $(item).find('.tweet-date a');
            const dateText = dateElement.attr('title'); // This contains the full date format
            if (!dateText) {
                console.log('No date found');
                return; // continue
            }

            // Parse the date
            const date = parseTwitterDate(dateText);
            if (!date) {
                console.log('Invalid date:', dateText);
                return; // continue
            }

            // Get tweet stats
            const stats = {
                replies: parseNumber($(item).find('.icon-comment').closest('.tweet-stat').text().trim() || '0'),
                retweets: parseNumber($(item).find('.icon-retweet').closest('.tweet-stat').text().trim() || '0'),
                likes: parseNumber($(item).find('.icon-heart').closest('.tweet-stat').text().trim() || '0')
            };

            // Get media attachments
            const media = [];
            
            // Check for images
            $(item).find('.attachments .attachment.image img, .gallery-row img').each((i, img) => {
                let url = $(img).attr('src');
                if (url && url.startsWith('/')) {
                    url = nitterBase + url;
                }
                if (url) {
                    media.push({
                        type: 'image',
                        url: url
                    });
                }
            });

            // Check for videos
            $(item).find('.attachments .gallery-video video source, .gallery-video video source').each((i, source) => {
                let url = $(source).attr('src');
                if (url && url.startsWith('/')) {
                    url = nitterBase + url;
                }
                if (url) {
                    media.push({
                        type: 'video',
                        url: url
                    });
                }
            });

            // Get author info
            const fullname = $(item).find('.fullname').text().trim() || '';
            const username = $(item).find('.username').text().trim() || '';

            tweets.push({
                id: tweetId,
                text: content,
                author: fullname,
                username: username,
                timestamp: Math.floor(date.getTime() / 1000),
                stats,
                media,
                isReply,
                isRetweet,
                isQuote,
                replyTo,
                retweetedFrom,
                quotedFrom,
                quotedTweetId
            });

        } catch (error) {
            console.warn('Error parsing tweet:', error);
        }
    });

    return tweets;
}

/**
 * Process a single tweet page and extract data
 * @param {string} html - The HTML content of the Nitter tweet page
 * @param {string} nitterBase - Base URL of the Nitter instance used
 * @returns {Object} - Parsed tweet data
 */
function processSingleTweetHtml(html, nitterBase) {
    try {
        // Use cheerio to parse the HTML
        const $ = cheerio.load(html);
        
        // Main tweet container
        const mainTweet = $('.main-tweet');
        if (!mainTweet.length) {
            throw new Error('Tweet container not found');
        }
        
        // Get basic tweet info
        const fullname = mainTweet.find('.fullname').text().trim();
        const username = mainTweet.find('.username').text().trim();
        
        // Get tweet content
        const contentElement = mainTweet.find('.tweet-content');
        if (!contentElement.length) {
            throw new Error('Tweet content not found');
        }
        const content = contentElement.text().trim();
        
        // Get tweet ID from URL or other means
        const tweetLinkHref = mainTweet.find('a.tweet-link').attr('href');
        const tweetId = tweetLinkHref ? tweetLinkHref.split('/status/')[1]?.split('#')[0] : 
                        mainTweet.attr('data-tweet-id') || '';
        
        // Get timestamp
        const dateElement = mainTweet.find('.tweet-date a');
        const dateText = dateElement.attr('title'); // Full date format
        
        // Parse the date
        let timestamp = 0;
        let dateObj = null;
        if (dateText) {
            dateObj = parseTwitterDate(dateText);
            if (dateObj) {
                timestamp = Math.floor(dateObj.getTime() / 1000);
            }
        }
        
        // Check for reply
        const replyHeader = mainTweet.find('.replying-to');
        const isReply = replyHeader.length > 0;
        let replyTo = '';
        if (isReply) {
            replyTo = replyHeader.find('a').text().trim();
        }
        
        // Check for quote tweet
        const quoteTweet = mainTweet.find('.quote');
        const isQuote = quoteTweet.length > 0;
        let quotedFrom = '';
        let quotedTweetId = '';
        if (isQuote) {
            quotedFrom = quoteTweet.find('.username').text().trim();
            const quoteLink = quoteTweet.find('a.quote-link').attr('href');
            quotedTweetId = quoteLink ? quoteLink.split('/status/')[1]?.split('#')[0] : '';
        }
        
        // Get tweet stats
        const stats = {
            replies: parseNumber(mainTweet.find('.icon-comment').closest('.tweet-stat').text().trim() || '0'),
            retweets: parseNumber(mainTweet.find('.icon-retweet').closest('.tweet-stat').text().trim() || '0'),
            likes: parseNumber(mainTweet.find('.icon-heart').closest('.tweet-stat').text().trim() || '0')
        };
        
        // Get media attachments
        const media = [];
        
        // Check for images
        mainTweet.find('.attachments .attachment.image img, .gallery-row img').each((i, img) => {
            let url = $(img).attr('src');
            if (url && url.startsWith('/')) {
                url = nitterBase + url;
            }
            if (url) {
                media.push({
                    type: 'image',
                    url: url
                });
            }
        });

        // Check for videos
        mainTweet.find('.attachments .gallery-video video source, .gallery-video video source').each((i, source) => {
            let url = $(source).attr('src');
            if (url && url.startsWith('/')) {
                url = nitterBase + url;
            }
            if (url) {
                media.push({
                    type: 'video',
                    url: url
                });
            }
        });
        
        // Get conversation/thread context
        const conversationTweets = [];
        $('.timeline-item:not(.main-tweet)').each((i, item) => {
            try {
                const tweetUsername = $(item).find('.username').text().trim();
                const tweetContent = $(item).find('.tweet-content').text().trim();
                const tweetLink = $(item).find('a.tweet-link').attr('href');
                const tweetId = tweetLink ? tweetLink.split('/status/')[1]?.split('#')[0] : null;
                
                if (tweetId && tweetContent) {
                    conversationTweets.push({
                        id: tweetId,
                        username: tweetUsername,
                        text: tweetContent
                    });
                }
            } catch (error) {
                console.warn('Error parsing conversation tweet:', error);
            }
        });
        
        // Construct the full tweet object
        return {
            id: tweetId,
            text: content,
            author: fullname,
            username: username,
            timestamp: timestamp,
            stats: stats,
            media: media,
            isReply: isReply,
            isQuote: isQuote,
            replyTo: replyTo,
            quotedFrom: quotedFrom,
            quotedTweetId: quotedTweetId,
            dateText: dateText,
            conversationTweets: conversationTweets.length > 0 ? conversationTweets : undefined,
            // Original URL
            originalUrl: `https://twitter.com/${username.replace('@', '')}/status/${tweetId}`
        };
    } catch (error) {
        console.error('Error processing single tweet HTML:', error);
        throw error;
    }
}

/**
 * Fetch and parse tweets from a Nitter instance
 * @param {string} username - Twitter username to fetch tweets for
 * @param {boolean} includeReplies - Whether to include replies (default: false)
 * @returns {Promise<Object>} - A promise that resolves to an object with tweets and source
 */
async function fetchNitterTweets(username, includeReplies = false) {
    console.log(`Fetching tweets for @${username}, includeReplies: ${includeReplies}`);
    
    if (!username) {
        throw new Error('Twitter username is required');
    }
    
    // Normalize username - remove @ if present
    const normalizedUsername = username.startsWith('@') ? username.slice(1) : username;
    
    // Try each Nitter instance
    for (const nitterBase of NITTER_INSTANCES) {
        console.log(`Trying Nitter instance: ${nitterBase}`);
        
        // Try with CORS proxies first
        for (const proxy of corsProxies) {
            try {
                // Define URLs to fetch
                const urls = [
                    `${nitterBase}/${normalizedUsername}`
                ];
                
                // Add replies URL if includeReplies is true
                if (includeReplies) {
                    urls.push(`${nitterBase}/${normalizedUsername}/with_replies`);
                }
                
                // Make the requests to each URL
                const responses = await Promise.all(
                    urls.map(url => 
                        axios.get(`${proxy}${encodeURIComponent(url)}`, {
                            headers: {
                                'User-Agent': getRandomUserAgent(),
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                'DNT': '1'
                            },
                            timeout: 15000
                        })
                    )
                );
                
                // Process HTML responses
                const allTweets = [];
                
                for (let i = 0; i < responses.length; i++) {
                    if (!responses[i].data) continue;
                    
                    // Handle node.js environment (server-side) which doesn't have DOMParser
                    const tweetsFromPage = processTweetsHtml(responses[i].data, nitterBase);
                    allTweets.push(...tweetsFromPage);
                }
                
                // Deduplicate tweets
                const seenIds = new Set();
                const uniqueTweets = [];
                
                for (const tweet of allTweets) {
                    if (!seenIds.has(tweet.id)) {
                        seenIds.add(tweet.id);
                        uniqueTweets.push(tweet);
                    }
                }
                
                // Sort by timestamp (newest first)
                const sortedTweets = uniqueTweets.sort((a, b) => b.timestamp - a.timestamp);
                
                return {
                    tweets: sortedTweets,
                    source: nitterBase,
                    username: normalizedUsername
                };
            } catch (error) {
                console.warn(`Proxy ${proxy} with ${nitterBase} failed:`, error.message);
                continue;
            }
        }
        
        // If all proxies fail, try direct fetch
        try {
            console.log(`All proxies failed for ${nitterBase}, attempting direct fetch...`);
            
            // Define URLs to fetch
            const urls = [
                `${nitterBase}/${normalizedUsername}`
            ];
            
            // Add replies URL if includeReplies is true
            if (includeReplies) {
                urls.push(`${nitterBase}/${normalizedUsername}/with_replies`);
            }
            
            // Make the requests to each URL
            const responses = await Promise.all(
                urls.map(url => 
                    axios.get(url, {
                        headers: {
                            'User-Agent': getRandomUserAgent(),
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'DNT': '1'
                        },
                        timeout: 15000
                    })
                )
            );
            
            // Process HTML responses
            const allTweets = [];
            
            for (let i = 0; i < responses.length; i++) {
                if (!responses[i].data) continue;
                
                // Process the HTML with Cheerio for server-side
                const tweetsFromPage = processTweetsHtml(responses[i].data, nitterBase);
                allTweets.push(...tweetsFromPage);
            }
            
            // Deduplicate tweets
            const seenIds = new Set();
            const uniqueTweets = [];
            
            for (const tweet of allTweets) {
                if (!seenIds.has(tweet.id)) {
                    seenIds.add(tweet.id);
                    uniqueTweets.push(tweet);
                }
            }
            
            // Sort by timestamp (newest first)
            const sortedTweets = uniqueTweets.sort((a, b) => b.timestamp - a.timestamp);
            
            return {
                tweets: sortedTweets,
                source: nitterBase,
                username: normalizedUsername
            };
            
        } catch (error) {
            console.warn(`Direct fetch from ${nitterBase} failed:`, error.message);
            // Continue to the next instance
        }
    }
    
    // If all instances and methods fail, throw an error
    throw new Error('NITTER_UNAVAILABLE');
}

/**
 * Fetch a single tweet by URL
 * @param {string} tweetUrl - URL of the tweet (twitter.com, x.com, or nitter)
 * @returns {Promise<Object>} - A promise that resolves to the tweet data
 */
async function fetchSingleTweet(tweetUrl) {
    console.log(`Fetching single tweet: ${tweetUrl}`);
    
    if (!tweetUrl) {
        throw new Error('Tweet URL is required');
    }
    
    // Check if it's a Twitter/X URL and extract path
    const isTwitter = isTwitterUrl(tweetUrl);
    let tweetPath = '';
    
    try {
        const url = new URL(tweetUrl);
        // Get the path without the leading slash
        tweetPath = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
    } catch (error) {
        console.error('Invalid URL:', error);
        throw new Error('Invalid tweet URL');
    }

    // Try each Nitter instance
    for (const nitterBase of NITTER_INSTANCES) {
        console.log(`Trying Nitter instance: ${nitterBase} for tweet`);
        
        // Construct the Nitter URL
        const nitterUrl = isTwitter ? `${nitterBase}/${tweetPath}` : tweetUrl;
        
        // Try with CORS proxies first
        for (const proxy of corsProxies) {
            try {
                // Make the request with proxy
                const response = await axios.get(`${proxy}${encodeURIComponent(nitterUrl)}`, {
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'DNT': '1'
                    },
                    timeout: 15000
                });
                
                if (!response.data) {
                    throw new Error('Empty response');
                }
                
                // Process the tweet
                const tweet = processSingleTweetHtml(response.data, nitterBase);
                
                return {
                    tweet,
                    source: nitterBase,
                    url: nitterUrl
                };
            } catch (error) {
                console.warn(`Proxy ${proxy} with ${nitterBase} failed for tweet:`, error.message);
                continue;
            }
        }
        
        // If all proxies fail, try direct fetch
        try {
            console.log(`All proxies failed for ${nitterBase}, attempting direct fetch of tweet...`);
            
            // Make the direct request
            const response = await axios.get(nitterUrl, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'DNT': '1'
                },
                timeout: 15000
            });
            
            if (!response.data) {
                throw new Error('Empty response');
            }
            
            // Process the tweet
            const tweet = processSingleTweetHtml(response.data, nitterBase);
            
            return {
                tweet,
                source: nitterBase,
                url: nitterUrl
            };
        } catch (error) {
            console.warn(`Direct fetch from ${nitterBase} failed for tweet:`, error.message);
            // Continue to the next instance
        }
    }
    
    // If all instances and methods fail, throw an error
    throw new Error('NITTER_UNAVAILABLE');
}

/**
 * Main function to be exported - gets tweets for a user
 * @param {string} username - Twitter username to fetch tweets for
 * @param {boolean} includeReplies - Whether to include replies
 * @returns {Promise<Object>} - A promise that resolves to an object with tweets and source
 */
async function getTweets(username, includeReplies = false) {
    try {
        const result = await fetchNitterTweets(username, includeReplies);
        
        return {
            tweets: result.tweets,
            source: result.source,
            username: result.username,
            count: result.tweets.length,
            includesReplies: includeReplies
        };
    } catch (error) {
        console.error('Error fetching tweets:', error);
        
        return {
            error: true,
            message: error.message === 'NITTER_UNAVAILABLE' 
                ? 'Unable to access Nitter instances at the moment, please try again later.'
                : `An error occurred while fetching tweets: ${error.message}`,
            username: username
        };
    }
}

/**
 * Get a single tweet by its URL
 * @param {string} url - The Twitter/X URL of the tweet
 * @returns {Promise<Object>} - A promise that resolves to the tweet data
 */
async function getTweetByUrl(url) {
    try {
        const result = await fetchSingleTweet(url);
        
        return {
            tweet: result.tweet,
            source: result.source,
            url: result.url
        };
    } catch (error) {
        console.error('Error fetching tweet by URL:', error);
        
        return {
            error: true,
            message: error.message === 'NITTER_UNAVAILABLE' 
                ? 'Unable to access Nitter instances at the moment, please try again later.'
                : `An error occurred while fetching tweet: ${error.message}`,
            url: url
        };
    }
}

// Export the main functions
module.exports = {
    getTweets,
    getTweetByUrl,
    isTwitterUrl,
    convertToNitterUrl,
    parseNumber
}; 