const axios = require('axios');
const cheerio = require('cheerio');

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
        
        // Set a user agent to mimic a browser
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 10000, // 10 second timeout
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
    
    try {
        // Use Promise.allSettled instead of Promise.all to handle individual failures
        const results = await Promise.allSettled(
            urlsToScrape.map(url => scrapeUrl(url))
        );
        
        // Process the results to handle both fulfilled and rejected promises
        return results.map((result, index) => {
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
    } catch (error) {
        console.error('Error in batch scraping:', error);
        return [];
    }
}

module.exports = {
    scrapeUrl,
    scrapeMultipleUrls
}; 