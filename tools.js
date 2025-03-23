const { searchQuery } = require('./searchlogic.js');
const { scrapeUrl, scrapeMultipleUrls } = require('./scraper.js');

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
    description: "Scrape content from a specific URL. One time use.",
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
    description: "Scrape content from multiple URLs. One time use.",
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
          // Execute single URL scrape
          const scrapeData = await scrapeUrl(input.url);
          result = {
            url: input.url,
            content: scrapeData.content || "No content found",
            title: scrapeData.title || "Unknown title"
          };
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
          const scrapeData = await scrapeMultipleUrls(input.urls);
          
          // Check if we got any successful scrapes
          const successfulScrapes = scrapeData.filter(item => 
            !item.error && item.content && item.content.length > 100
          );
          
          if (successfulScrapes.length > 0) {
            result = scrapeData.map(item => ({
              url: item.url,
              content: item.content || "No content found",
              title: item.title || "Unknown title",
              error: item.error || null
            }));
          } else {
            // All scrapes failed
            result = { 
              error: "All URL scraping attempts failed",
              urls: input.urls,
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
      else {
        result = { 
          error: `Unknown tool: ${name}`,
          suggestion: "Please use one of the available tools: web_search, web_scrape, or multi_scrape." 
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

module.exports = {
  TOOL_SCHEMAS,
  executeToolCalls
}; 