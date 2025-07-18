const axios = require('axios');
const cheerio = require('cheerio');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase using the secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// A reusable function to scrape a flight type and save to Firestore
async function scrapeAndSave(flightType) {
    const url = `https://www.beirutairport.gov.lb/_flight.php?type=${flightType}`;
    const docId = flightType === 'dprtr' ? 'departures' : 'arrivals';

    console.log(`Scraping ${docId}...`);

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const flightsData = {};

    $('table.flight_table tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length === 9) {
            const flightNumber = $(cells).eq(2).text().trim();
            const date = $(row).closest('table').find('tr.date_row').text().trim();
            if (!flightNumber || !date) return;
            
            const id = `${flightNumber}-${date}`;
            flightsData[id] = {
                id,
                flightNumber,
                status: $(cells).eq(7).text().trim(),
                actualTime: $(cells).eq(8).text().trim(),
            };
        }
    });

    // Save the scraped data to the correct Firestore document
    const docRef = db.collection('flight-data').doc(docId);
    await docRef.set({ flights: flightsData, lastUpdated: new Date() });
    console.log(`Successfully saved ${Object.keys(flightsData).length} ${docId} to Firestore.`);
}

// Run the scraper for both flight types
async function runScraper() {
    await scrapeAndSave('dprtr');
    await scrapeAndSave('arivl');
}

runScraper().catch(console.error);
