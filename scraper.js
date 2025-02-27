const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Rotates through multiple user agents to avoid detection
 * @returns {string} A random user agent string
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
 * Specialized method to scrape Reddit using JSON API
 * @param {string} url - The Reddit URL to scrape
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeReddit(url) {
    try {
        console.log(`Scraping Reddit URL: ${url}`);
        
        // Convert Reddit URL to JSON API URL
        // Remove trailing slash if present
        const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        // Add .json extension
        const jsonUrl = cleanUrl.endsWith('.json') ? cleanUrl : `${cleanUrl}.json`;
        
        // Use the old.reddit.com domain which is more scraper friendly
        const oldRedditUrl = jsonUrl.replace('www.reddit.com', 'old.reddit.com');
        
        console.log(`Fetching Reddit JSON from: ${oldRedditUrl}`);
        
        // Make the request with appropriate headers
        const response = await axios.get(oldRedditUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://old.reddit.com/',
                'Origin': 'https://old.reddit.com',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000,
            // Add this to fix SSL issues
            httpsAgent: new (require('https').Agent)({
                rejectUnauthorized: false
            })
        });
        
        // Reddit API returns an array with post data and comments
        const data = response.data;
        
        // Extract the post title and content
        let title = '';
        let content = '';
        let postAuthor = '';
        
        if (Array.isArray(data) && data.length > 0 && data[0].data && data[0].data.children && data[0].data.children.length > 0) {
            const post = data[0].data.children[0].data;
            title = post.title || '';
            postAuthor = post.author || 'Unknown';
            
            // Content could be in selftext or body_html
            content = post.selftext || '';
            
            // If there's post content, add it
            if (content) {
                content = `[Post by u/${postAuthor}] ${content}\n\n`;
            } else {
                // Check if it's a link post
                if (post.url && !post.url.includes('reddit.com')) {
                    content = `[Link post by u/${postAuthor}] URL: ${post.url}\n\n`;
                }
            }
            
            // Include post flair if available
            if (post.link_flair_text) {
                content = `[Flair: ${post.link_flair_text}] ${content}`;
            }
        }
        
        // Extract comments if they exist
        if (Array.isArray(data) && data.length > 1 && data[1].data && data[1].data.children) {
            content += "===COMMENTS===\n\n";
            
            // Get top level comments
            const comments = data[1].data.children;
            
            comments.forEach((commentObj, index) => {
                if (commentObj.kind !== 't1' || !commentObj.data) return; // Skip non-comments
                
                const comment = commentObj.data;
                if (comment.body && !comment.stickied) { // Skip stickied comments (usually mod comments)
                    content += `[Comment by u/${comment.author}] ${comment.body}\n\n`;
                    
                    // Only include up to 10 top comments to keep size reasonable
                    if (index >= 9) return;
                }
            });
        }
        
        return {
            url,
            content: content || 'No content extracted from Reddit',
            title: title || 'Reddit Post'
        };
    } catch (error) {
        console.error(`Error scraping Reddit ${url}:`, error.message);
        
        // Try alternative method using an unofficial Reddit API proxy
        try {
            console.log("Trying alternative method to get Reddit content...");
            const postId = extractRedditPostId(url);
            if (!postId) throw new Error("Could not extract post ID");
            
            // Use another URL format that sometimes works better
            const apiUrl = `https://api.reddit.com/comments/${postId}`;
            
            console.log(`Fetching from alternate URL: ${apiUrl}`);
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
                },
                timeout: 15000
            });
            
            const data = response.data;
            let title = '';
            let content = '';
            
            if (Array.isArray(data) && data.length > 0 && data[0].data && data[0].data.children && data[0].data.children.length > 0) {
                const post = data[0].data.children[0].data;
                title = post.title || '';
                const postAuthor = post.author || 'Unknown';
                
                content = post.selftext || '';
                
                if (content) {
                    content = `[Post by u/${postAuthor}] ${content}\n\n`;
                } else if (post.url && !post.url.includes('reddit.com')) {
                    content = `[Link post by u/${postAuthor}] URL: ${post.url}\n\n`;
                }
                
                if (post.link_flair_text) {
                    content = `[Flair: ${post.link_flair_text}] ${content}`;
                }
                
                // Extract comments
                if (data.length > 1 && data[1].data && data[1].data.children) {
                    content += "===COMMENTS===\n\n";
                    
                    const comments = data[1].data.children;
                    
                    comments.forEach((commentObj, index) => {
                        if (commentObj.kind !== 't1' || !commentObj.data) return;
                        
                        const comment = commentObj.data;
                        if (comment.body && !comment.stickied) {
                            content += `[Comment by u/${comment.author}] ${comment.body}\n\n`;
                            
                            if (index >= 9) return;
                        }
                    });
                }
                
                return {
                    url,
                    content: content || 'No content extracted from Reddit',
                    title: title || 'Reddit Post'
                };
            }
        } catch (alternativeError) {
            console.error("Alternative method also failed:", alternativeError.message);
        }
        
        // If both methods fail, return error message
        return {
            url,
            content: `Failed to scrape Reddit content: ${error.message}`,
            title: 'Reddit Scraping Error'
        };
    }
}

/**
 * Extract Reddit post ID from URL
 * @param {string} url - Reddit URL
 * @returns {string|null} - Post ID or null if not found
 */
function extractRedditPostId(url) {
    try {
        const regex = /\/comments\/([a-z0-9]+)\//i;
        const match = url.match(regex);
        return match ? match[1] : null;
    } catch (error) {
        console.error("Error extracting Reddit post ID:", error);
        return null;
    }
}

/**
 * Specialized method to scrape Fandom wikis
 * @param {string} url - The Fandom URL to scrape
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeFandom(url) {
    try {
        console.log(`Scraping Fandom URL: ${url}`);
        
        // Make the request with appropriate headers for Fandom
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
                'Referer': 'https://www.google.com/'
            },
            timeout: 15000
        });
        
        // Load the HTML into cheerio
        const $ = cheerio.load(response.data);
        
        // Get the title
        const title = $('h1.page-header__title').text().trim() || $('title').text().trim();
        
        // Get the content - Fandom wikis usually have the main content in specific containers
        let content = '';
        
        // Try to find the main content by Fandom-specific selectors
        const contentSelectors = [
            '.mw-parser-output',
            '#mw-content-text',
            '.WikiaArticle',
            '.page-content'
        ];
        
        // Check each selector and use the first one that has content
        for (const selector of contentSelectors) {
            const element = $(selector);
            if (element.length) {
                // Remove unnecessary elements within the content
                element.find('.wikia-gallery, .toc, .navbox, .infobox, table, .reference, script, style, .navigation-menu').remove();
                
                // Extract text from paragraphs and headings
                content = '';
                element.find('p, h1, h2, h3, h4, h5, h6, li').each((i, el) => {
                    const text = $(el).text().trim();
                    if (text) {
                        // Add heading format for better structure
                        if (el.name.startsWith('h')) {
                            content += `\n## ${text}\n\n`;
                        } else {
                            content += `${text}\n\n`;
                        }
                    }
                });
                
                break;
            }
        }
        
        // Clean up the content
        content = content
            .replace(/\[\d+\]/g, '') // Remove citation numbers
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n\n')
            .trim();
        
        return {
            url,
            content: content || 'No content extracted from Fandom',
            title: title || 'Fandom Wiki Page'
        };
    } catch (error) {
        console.error(`Error scraping Fandom ${url}:`, error.message);
        return {
            url,
            content: `Failed to scrape Fandom content: ${error.message}`,
            title: 'Fandom Scraping Error'
        };
    }
}

/**
 * Delay execution for a specified time
 * @param {number} ms - The number of milliseconds to delay
 * @returns {Promise} - A promise that resolves after the delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scrapes content from a URL and cleans it to extract main content
 * @param {string} url - The URL to scrape
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeUrl(url) {
    try {
        console.log(`Scraping URL: ${url}`);
        
        // Handle invalid URLs gracefully
        if (!url || !url.startsWith('http')) {
            return {
                url,
                content: 'Invalid URL format',
                title: 'Invalid URL'
            };
        }
        
        // Check if it's Reddit
        if (url.includes('reddit.com')) {
            return scrapeReddit(url);
        }
        
        // Check if it's Fandom
        if (url.includes('fandom.com') || url.includes('wikia.com') || url.includes('wiki')) {
            return scrapeFandom(url);
        }
        
        // For other websites, use the general scraping method
        // Set a user agent to mimic a browser
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0',
                'Referer': 'https://www.google.com/',
                'DNT': '1'
            },
            timeout: 15000, // 15 second timeout
            maxContentLength: 10 * 1024 * 1024, // 10MB max content size
            validateStatus: function (status) {
                return status >= 200 && status < 300; // Only accept valid status codes
            }
        });
        
        // Check if content type is HTML
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html')) {
            return {
                url,
                content: `This is not an HTML page. Content type: ${contentType}`,
                title: 'Non-HTML Content'
            };
        }
        
        // Load the HTML into cheerio
        const $ = cheerio.load(response.data);
        
        // Remove unwanted elements that typically contain navigation, ads, etc.
        $('nav, header, footer, script, style, iframe, [id*="nav"], [id*="header"], [id*="footer"], [id*="menu"], [class*="nav"], [class*="header"], [class*="footer"], [class*="menu"], [class*="sidebar"], [class*="ad"], [class*="banner"]').remove();
        
        // Extract text from the main content areas
        let mainContent = '';
        
        // Try to find the main content by common selectors
        const contentSelectors = [
            'main', 
            'article', 
            '[role="main"]', 
            '.content', 
            '#content', 
            '.main', 
            '#main', 
            '.post', 
            '.article',
            '.post-content',
            '.entry-content',
            '.page-content'
        ];
        
        // Check each selector and use the first one that has content
        for (const selector of contentSelectors) {
            const content = $(selector).text().trim();
            if (content && content.length > 100) { // Only use if it has meaningful content
                mainContent = content;
                break;
            }
        }
        
        // If no content found with specific selectors, extract from body
        if (!mainContent) {
            // Extract text from paragraphs and headings
            $('p, h1, h2, h3, h4, h5, h6').each((i, el) => {
                const text = $(el).text().trim();
                if (text) {
                    mainContent += text + '\n\n';
                }
            });
        }
        
        // Clean the text
        let cleanedContent = mainContent
            .replace(/\s+/g, ' ')        // Replace multiple spaces with a single space
            .replace(/\n\s*\n/g, '\n\n') // Replace multiple newlines with double newlines
            .trim();
        
        // If still no content, use the body text as a fallback
        if (!cleanedContent || cleanedContent.length < 100) {
            cleanedContent = $('body').text()
                .replace(/\s+/g, ' ')
                .trim();
        }
        
        // Limit content length to avoid overwhelming the AI
        const maxContentLength = 10000;
        if (cleanedContent.length > maxContentLength) {
            cleanedContent = cleanedContent.substring(0, maxContentLength) + '... [content truncated]';
        }
        
        return {
            url,
            content: cleanedContent || 'No content extracted',
            title: $('title').text().trim() || 'No title'
        };
    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        
        // Provide more specific error messages based on error type
        let errorMessage = 'Failed to scrape content';
        
        if (error.code === 'ECONNABORTED') {
            errorMessage = 'Request timed out';
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = 'Domain not found';
        } else if (error.response) {
            errorMessage = `Server responded with status ${error.response.status}`;
        } else if (error.request) {
            errorMessage = 'No response received from server';
        }
        
        return {
            url,
            content: `${errorMessage}: ${error.message}`,
            title: 'Scraping Error'
        };
    }
}

/**
 * Scrapes multiple URLs and returns their content
 * @param {Array<string>} urls - Array of URLs to scrape
 * @returns {Promise<Array>} - Promise resolving to array of scraped content
 */
async function scrapeMultipleUrls(urls) {
    // Limit to max 3 URLs to avoid overwhelming the system
    const urlsToScrape = urls.slice(0, 3);
    const results = [];
    
    try {
        // Process URLs sequentially with delays to avoid triggering anti-scraping measures
        for (const url of urlsToScrape) {
            try {
                const result = await scrapeUrl(url);
                results.push(result);
                
                // Add a random delay between requests (1-3 seconds)
                const randomDelay = 1000 + Math.floor(Math.random() * 2000);
                await delay(randomDelay);
            } catch (error) {
                console.error(`Error scraping ${url}:`, error);
                results.push({
                    url,
                    content: `Failed to scrape content: ${error.message || 'Unknown error'}`,
                    title: 'Scraping Error'
                });
            }
        }
        
        return results;
    } catch (error) {
        console.error('Error in batch scraping:', error);
        return results;
    }
}

module.exports = {
    scrapeUrl,
    scrapeMultipleUrls
}; 