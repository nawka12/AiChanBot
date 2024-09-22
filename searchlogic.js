const format = '&format=json';
const baseUrl = 'http://127.0.0.1:8080/search?q=';

module.exports.searchQuery = function(query) {
  const url = `${baseUrl}${encodeURIComponent(query)}${format}`;
  return import('node-fetch')
    .then(fetch => fetch.default(url))
    .then(response => response.json())
    .then(searchResult => {
      console.log(`Fetched data for query "${query}"`);
      
      let skippedCount = 0;
      
      // Filter out results where engines is only "qwant"
      searchResult.results = searchResult.results.filter(result => {
        if (result.engines.length === 1 && result.engines[0] === 'qwant') {
          skippedCount++;
          return false;
        }
        return true;
      });
      
      if (skippedCount > 0) {
        console.log(`Skipped ${skippedCount} search result(s) from Qwant.`);
      }
      
      return searchResult;
    })
    .catch(error => {
      console.error(error);
      throw error;
    });
};
