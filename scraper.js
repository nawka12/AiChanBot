const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Gets a randomized user agent string to avoid detection
 * @returns {string} A realistic browser user agent
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Determines if a site requires special handling
 * @param {string} url - The URL to check
 * @returns {string|null} - The site type or null if no special handling
 */
function getSiteType(url) {
    if (url.includes('reddit.com')) return 'reddit';
    if (url.includes('fandom.com') || url.includes('wikia.com')) return 'fandom';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
    return null;
}

/**
 * Gets site-specific configuration for scraping
 * @param {string} url - The URL to configure for
 * @returns {Object} - Configuration object with headers and options
 */
function getSiteConfig(url) {
    const siteType = getSiteType(url);
    const userAgent = getRandomUserAgent();
    
    // Base configuration used for all sites
    const config = {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'Sec-Ch-Ua': '"Chromium";v="118", "Google Chrome";v="118"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        },
        timeout: 15000, // 15 second timeout
        maxContentLength: 10 * 1024 * 1024, // 10MB max content size
        validateStatus: function (status) {
            return status >= 200 && status < 300; // Only accept valid status codes
        }
    };
    
    // Site-specific configurations
    switch (siteType) {
        case 'reddit':
            // For Reddit, we use a special JSON endpoint that's more reliable than HTML scraping
            const jsonUrl = url.endsWith('.json') ? url : `${url.replace(/\/$/, '')}.json`;
            return {
                ...config,
                url: jsonUrl,
                isJson: true
            };
            
        case 'fandom':
            // For Fandom, we add some specific headers they expect
            config.headers['Cookie'] = 'euConsent=0; sessionId=' + Math.random().toString(36).substring(2);
            return config;
            
        case 'twitter':
            // For Twitter, we could use something like nitter, but for now, just modify headers
            config.headers['Referer'] = 'https://www.google.com/';
            return config;
            
        default:
            // For other sites, use the default config
            return config;
    }
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
        
        // Get site-specific configuration
        const config = getSiteConfig(url);
        
        // For Reddit, we need special handling
        if (config.isJson) {
            return await scrapeRedditJson(config.url);
        }
        
        // Add a random delay to avoid rate limiting (between 1-3 seconds)
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        
        // Make the request
        const response = await axios.get(url, config);
        
        // Check if content type is HTML
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
            return {
                url,
                content: `This is not an HTML or JSON page. Content type: ${contentType}`,
                title: 'Non-HTML Content'
            };
        }
        
        // Load the HTML into cheerio
        const $ = cheerio.load(response.data);
        
        // Remove unwanted elements that typically contain navigation, ads, etc.
        $('nav, header, footer, script, style, iframe, [id*="nav"], [id*="header"], [id*="footer"], [id*="menu"], [class*="nav"], [class*="header"], [class*="footer"], [class*="menu"], [class*="sidebar"], [class*="ad"], [class*="banner"]').remove();
        
        // Extract text from the main content areas
        let mainContent = '';
        
        // Site-specific content extraction
        const siteType = getSiteType(url);
        if (siteType === 'fandom') {
            const content = $('.page-content, .wds-tab__content, .mw-parser-output').text().trim();
            if (content) {
                mainContent = content;
            }
        }
        
        // If no site-specific content found, try generic methods
        if (!mainContent) {
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
                '.page-content',
                '#bodyContent',
                '.mw-body'
            ];
            
            // Check each selector and use the first one that has content
            for (const selector of contentSelectors) {
                const content = $(selector).text().trim();
                if (content && content.length > 100) { // Only use if it has meaningful content
                    mainContent = content;
                    break;
                }
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
 * @param {string} query - The user's original query
 * @returns {Promise<Array>} - Promise resolving to array of scraped content
 */
async function scrapeMultipleUrls(urls, query = '') {
    // Limit to max 3 URLs to avoid overwhelming the system
    const urlsToScrape = urls.slice(0, 3);
    
    try {
        // Use Promise.allSettled instead of Promise.all to handle individual failures
        const results = await Promise.allSettled(
            urlsToScrape.map(url => scrapeUrl(url))
        );
        
        // Process the results to handle both fulfilled and rejected promises
        const scrapedResults = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                // For rejected promises, return an error object
                return {
                    url: urlsToScrape[index],
                    content: `Failed to scrape content: ${result.reason?.message || 'Unknown error'}`,
                    title: 'Scraping Error'
                };
            }
        });
        
        // Check if all results failed and query is about a VTuber
        const allFailed = scrapedResults.every(result => result.title.includes('Error'));
        const isVTuberQuery = query.toLowerCase().includes('vtuber') || 
                             query.toLowerCase().includes('hololive') ||
                             query.toLowerCase().includes('moona') ||
                             query.toLowerCase().includes('hoshinova');
        
        if (allFailed && isVTuberQuery) {
            // Extract VTuber name from query
            let vtuberName = '';
            if (query.toLowerCase().includes('moona')) {
                vtuberName = 'Moona Hoshinova';
            } else {
                // Try to extract name from the query
                const nameMatcher = /(?:about|info|career)\s+([a-zA-Z\s]+)/i;
                const match = query.match(nameMatcher);
                vtuberName = match ? match[1] : query;
            }
            
            const alternativeInfo = await getVTuberInfoFromAlternativeSource(vtuberName);
            return [...scrapedResults, alternativeInfo];
        }
        
        return scrapedResults;
    } catch (error) {
        console.error('Error in batch scraping:', error);
        return [];
    }
}

module.exports = {
    scrapeUrl,
    scrapeMultipleUrls,
    getVTuberInfoFromAlternativeSource
}; 