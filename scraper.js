const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// --- 1. SCRAPING LOGIC ---
async function scrapeFlights() {
    const flightData = {};
    for (const type of ['dprtr', 'arivl']) {
        const url = `https://www.beirutairport.gov.lb/_flight.php?type=${type}`;
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        $('table.flight_table tbody tr').each((i, row) => {
            const cells = $(row).find('td');
            if (cells.length === 9) {
                const flightNumber = $(cells).eq(2).text().trim();
                const date = $(row).closest('table').find('tr.date_row').text().trim();
                if (!flightNumber || !date) return;

                const id = `${flightNumber}-${date}`;
                flightData[id] = {
                    flightNumber,
                    status: $(cells).eq(7).text().trim(),
                    actualTime: $(cells).eq(8).text().trim(),
                };
            }
        });
    }
    return flightData;
}

// --- 2. NOTIFICATION LOGIC ---
async function sendNotification(changes) {
    if (changes.length === 0) {
        console.log('No changes to notify.');
        return;
    }

    console.log(`Sending notification for ${changes.length} changes...`);
    const body = changes.slice(0, 2).join('\n'); // Show first 2 changes

    const response = await axios.post('https://onesignal.com/api/v1/notifications', 
        {
            app_id: process.env.ONESIGNAL_APP_ID,
            included_segments: ['All'],
            headings: { en: '✈️ Flight Status Update' },
            contents: { en: body },
        },
        {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
            },
        }
    );
    console.log('OneSignal response:', response.status, response.data);
}

// --- 3. MAIN WORKFLOW ---
async function main() {
    // Read old data from the file
    let oldData = {};
    try {
        oldData = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        console.log(`Loaded ${Object.keys(oldData).length} flights from previous run.`);
    } catch (error) {
        console.log('No previous data file found. Starting fresh.');
    }

    // Scrape new data
    const newData = await scrapeFlights();
    console.log(`Scraped ${Object.keys(newData).length} new flights.`);

    // Compare and find changes
    const changes = [];
    for (const id in newData) {
        if (oldData[id] && JSON.stringify(newData[id]) !== JSON.stringify(oldData[id])) {
            changes.push(`${newData[id].flightNumber} status: ${newData[id].status}`);
        }
    }

    // Send notification if there are changes
    await sendNotification(changes);

    // Save new data to the file and commit it
    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));
    console.log('Wrote new data to file.');

    // Commit the updated data file back to the repository
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
    execSync('git add flight_data.json');
    execSync('git commit -m "Update flight data" || exit 0'); // exit 0 if no changes to commit
    execSync('git push');
    console.log('Committed and pushed updated data.');
}

main().catch(console.error);
