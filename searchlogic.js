import fetch from 'node-fetch';

const baseUrl = 'https://ametukam.dedyn.io/search?q=';
const format = '&format=json';

export const searchQuery = (query) => {
  const url = `${baseUrl}${query.replace(/ /g, '+')}${format}`;
  return fetch(url)
    .then(response => response.json())
    .then(hasil => {
      console.log(`Fetched data for query "${query}"`);
      return hasil;
    })
    .catch(error => {
      console.error(error);
      throw error;
    });
};
