const format = '&format=json';
const baseUrl = 'http://127.0.0.1:8080/search?q=';

module.exports.searchQuery = function(query) {
  const url = `${baseUrl}${encodeURIComponent(query)}${format}`;
  return import('node-fetch')
    .then(fetch => fetch.default(url))
    .then(response => response.json())
    .then(searchResult => {
      console.log(`Fetched data for query "${query}"`);
      return searchResult;
    })
    .catch(error => {
      console.error(error);
      throw error;
    });
};
