const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Rotates through multiple user agents to avoid detection
 * Updated with 2025 browser versions
 * @returns {string} A random user agent string
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Sleep function for delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} 
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Specialized method to scrape Reddit using JSON API with retry logic and fallbacks
 * @param {string} url - The Reddit URL to scrape
 * @param {number} retryCount - Current retry attempt (for internal use)
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeReddit(url, retryCount = 0) {
    const MAX_RETRIES = 3;
    
    try {
        console.log(`Scraping Reddit URL: ${url} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
        
        // Add random delay to mimic human behavior (2-5 seconds)
        const delay = 2000 + Math.floor(Math.random() * 3000);
        await sleep(delay);
        
        // Try old.reddit.com first as it's less restrictive
        // Be careful not to double-replace (avoid old.old.reddit.com)
        let targetUrl = url;
        if (!targetUrl.includes('old.reddit.com')) {
            targetUrl = targetUrl.replace('www.reddit.com', 'old.reddit.com')
                                 .replace('://reddit.com', '://old.reddit.com');
        }
        
        // Convert Reddit URL to JSON API URL
        const jsonUrl = targetUrl.endsWith('.json') ? targetUrl : `${targetUrl}.json`;
        
        // Generate realistic browser headers
        const userAgent = getRandomUserAgent();
        const isChrome = userAgent.includes('Chrome');
        const isFirefox = userAgent.includes('Firefox');
        
        const headers = {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };
        
        // Add browser-specific headers
        if (isChrome) {
            headers['sec-ch-ua'] = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
        }
        
        // Make the request with appropriate headers
        const response = await axios.get(jsonUrl, {
            headers: headers,
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Accept 4xx to handle them specially
            }
        });
        
        // Handle rate limiting or blocking
        if (response.status === 429 || response.status === 403) {
            if (retryCount < MAX_RETRIES) {
                const backoffDelay = Math.pow(2, retryCount) * 3000 + Math.random() * 2000;
                console.log(`Rate limited or blocked. Retrying after ${Math.floor(backoffDelay/1000)}s...`);
                await sleep(backoffDelay);
                return scrapeReddit(url, retryCount + 1);
            }
            throw new Error(`Reddit blocked request with status ${response.status}`);
        }
        
        if (response.status !== 200) {
            throw new Error(`Unexpected status code: ${response.status}`);
        }
        
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
            let commentCount = 0;
            
            for (const commentObj of comments) {
                if (commentObj.kind !== 't1' || !commentObj.data) continue; // Skip non-comments
                
                const comment = commentObj.data;
                if (comment.body && !comment.stickied) { // Skip stickied comments (usually mod comments)
                    content += `[Comment by u/${comment.author}] ${comment.body}\n\n`;
                    commentCount++;
                    
                    // Only include up to 10 top comments to keep size reasonable
                    if (commentCount >= 10) break;
                }
            }
        }
        
        return {
            url,
            content: content || 'No content extracted from Reddit',
            title: title || 'Reddit Post'
        };
    } catch (error) {
        console.error(`Error scraping Reddit ${url}:`, error.message);
        
        // Retry on network errors
        if (retryCount < MAX_RETRIES && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET')) {
            const backoffDelay = Math.pow(2, retryCount) * 2000 + Math.random() * 1000;
            console.log(`Network error. Retrying after ${Math.floor(backoffDelay/1000)}s...`);
            await sleep(backoffDelay);
            return scrapeReddit(url, retryCount + 1);
        }
        
        return {
            url,
            content: `Failed to scrape Reddit content: ${error.message}. Reddit may be blocking automated requests. Try using the official Reddit API with authentication for reliable access.`,
            title: 'Reddit Scraping Error'
        };
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
        
        // Generate realistic browser headers
        const userAgent = getRandomUserAgent();
        const isChrome = userAgent.includes('Chrome');
        
        const headers = {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': 'https://www.google.com/'
        };
        
        // Add browser-specific headers
        if (isChrome) {
            headers['sec-ch-ua'] = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
        }
        
        // Make the request with appropriate headers for Fandom
        const response = await axios.get(url, {
            headers: headers,
            timeout: 20000,
            maxRedirects: 5
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
 * Check if a hostname resolves to a private/internal IP address
 * Prevents SSRF attacks by blocking requests to internal networks
 * @param {string} hostname - The hostname to check
 * @returns {boolean} - True if the hostname is private/internal
 */
function isPrivateHost(hostname) {
  // Block localhost variations
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Block private IPv4 ranges
  const privateIPv4Patterns = [
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,          // 127.0.0.0/8 (loopback)
    /^169\.254\.\d{1,3}\.\d{1,3}$/,              // 169.254.0.0/16 (link-local)
    /^0\.0\.0\.0$/,                              // 0.0.0.0
  ];

  for (const pattern of privateIPv4Patterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  // Block private IPv6 ranges
  const privateIPv6Patterns = [
    /^::1$/,                    // Loopback
    /^fe80:/i,                  // Link-local
    /^fc00:/i,                  // Unique local
    /^fd00:/i,                  // Unique local
  ];

  for (const pattern of privateIPv6Patterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  // Block common internal hostnames
  const internalHostnames = ['localhost', 'internal', 'intranet', 'corp', 'local'];
  const lowerHostname = hostname.toLowerCase();
  for (const internal of internalHostnames) {
    if (lowerHostname === internal || lowerHostname.endsWith('.' + internal)) {
      return true;
    }
  }

  return false;
}

/**
 * Scrape a single URL and return its content
 * Routes to specialized scrapers based on domain
 * @param {string} url - The URL to scrape
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeUrl(url) {
  console.log(`Scraping single URL: ${url}`);

  // Validate URL format
  if (!url || !url.startsWith('http')) {
    return {
      url,
      content: 'Invalid URL format',
      title: 'Invalid URL'
    };
  }

  // SSRF protection: Block requests to private/internal hosts
  try {
    const parsedUrl = new URL(url);
    if (isPrivateHost(parsedUrl.hostname)) {
      console.warn(`Blocked SSRF attempt to private host: ${parsedUrl.hostname}`);
      return {
        url,
        content: 'Access to internal/private hosts is not allowed',
        title: 'Blocked Request'
      };
    }
  } catch (parseError) {
    return {
      url,
      content: 'Invalid URL format',
      title: 'Invalid URL'
    };
  }
  
  // Check if it's a Reddit URL
  if (url.includes('reddit.com') || url.includes('redd.it')) {
    return await scrapeReddit(url);
  }
  
  // Check if it's a Fandom URL
  if (url.includes('fandom.com') || url.includes('wikia.com')) {
    return await scrapeFandom(url);
  }
  
  // Default scraper for other websites
  return await scrapeGeneric(url);
}

/**
 * Scrape multiple URLs and return their contents
 * Processes URLs sequentially with delays to avoid rate limiting
 * @param {Array<string>} urls - The URLs to scrape
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of objects with url, content, and title
 */
async function scrapeMultipleUrls(urls) {
  console.log(`Scraping multiple URLs: ${urls.length} URLs`);
  
  const results = [];
  const MAX_URLS = 5; // Limit to 5 URLs to avoid excessive scraping
  const urlsToScrape = urls.slice(0, MAX_URLS);
  
  // Process URLs sequentially with delays to mimic human behavior
  for (let i = 0; i < urlsToScrape.length; i++) {
    const url = urlsToScrape[i];
    console.log(`Scraping ${i + 1}/${urlsToScrape.length}: ${url}`);
    
    try {
      const result = await scrapeUrl(url);
      results.push(result);
    } catch (err) {
      console.error(`Error scraping ${url}:`, err.message);
      results.push({ 
        url: url, 
        content: `Error: ${err.message}`, 
        title: 'Error scraping URL' 
      });
    }
    
    // Add delay between URLs (scrapeReddit already has delays, so only add for non-Reddit)
    if (i < urlsToScrape.length - 1 && !url.includes('reddit.com')) {
      const delayMs = 1000 + Math.floor(Math.random() * 2000); // 1-3 seconds
      console.log(`Waiting ${Math.floor(delayMs/1000)}s before next scrape...`);
      await sleep(delayMs);
    }
  }
  
  console.log(`Completed scraping ${results.length} URLs`);
  return results;
}

/**
 * Generic scraper for websites other than Reddit and Fandom
 * @param {string} url - The URL to scrape
 * @returns {Promise<Object>} - A promise that resolves to an object with url, content, and title
 */
async function scrapeGeneric(url) {
  try {
    console.log(`Generic scraping for URL: ${url}`);
    
    // Generate realistic browser headers
    const userAgent = getRandomUserAgent();
    const isChrome = userAgent.includes('Chrome');
    
    const headers = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://www.google.com/'
    };
    
    // Add browser-specific headers
    if (isChrome) {
      headers['sec-ch-ua'] = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
    }
    
    // Make the request with appropriate headers
    const response = await axios.get(url, {
      headers: headers,
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 500; // Accept 4xx to handle them specially
      }
    });
    
    // Check response status
    if (response.status !== 200) {
      throw new Error(`Server responded with status ${response.status}`);
    }
    
    // Check content type
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
    
    // Remove noisy/non-content elements
    $('script, style, nav, footer, header, aside, iframe, noscript, svg, form, input, button, [role="banner"], [role="navigation"], [role="search"], [aria-hidden="true"], .sidebar, .comments, .ad, .advertisement, .cookie, .cookie-banner, .consent, .modal, .tooltip, .toast, .banner').remove();

    // Extract the title
    const title = $('title').text().trim() || 'No title found';
    
    // Extract the main content
    // This is a heuristic approach that looks for common content containers
    const contentSelectors = [
      'article', 'main', '.content', '#content', '.article', 
      '.post', '.entry', '[role="main"]', '.main-content',
      '.article-content', '.entry-content', '.post-content'
    ];
    
    let content = '';
    
    // Try each selector to find content
    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        // Extract text from the first matching element
        content = element.text().trim();
        if (content.length > 100) {  // If we found substantial content, use it
          break;
        }
      }
    }
    
    // If no content was found with selectors, grab the body text
    if (!content || content.length < 100) {
      // Remove common chrome before extracting text
      $('script, style, nav, footer, header, aside, .sidebar, .comments, .ad, .advertisement').remove();
      content = $('body').text().trim();
      
      // Clean up the content - remove extra whitespace
      content = content
        .replace(/\r/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // Final normalization pass
    content = content
      .replace(/\r/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+\n/g, '\n')
      .trim();
    
    return {
      url,
      content: content || 'No content extracted from page',
      title
    };
  } catch (error) {
    console.error(`Error in generic scraping for ${url}:`, error.message);
    return {
      url,
      content: `Failed to scrape content: ${error.message}`,
      title: 'Scraping Error'
    };
  }
}

// Export functions
module.exports = {
  scrapeUrl,
  scrapeMultipleUrls,
  scrapeReddit,
  scrapeFandom,
  scrapeGeneric
};