import fetch from 'node-fetch';

const baseUrl = 'https://ametukam.dedyn.io/search?q=';
const format = '&format=json';

export const searchQuery = (query) => {
  const url = `${baseUrl}${encodeURIComponent(query)}${format}`;
  return fetch(url)
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
