const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// All tags a user can subscribe to.
const allKnownTags = [
    "ME", "TK", "AF", "EK", "QR", "RJ", "PC", "all_flights"
];

// --- 1. SCRAPING LOGIC (FIXED) ---
async function scrapeFlights() {
    const flightData = {};
    for (const type of ['dprtr', 'arivl']) {
        const url = `https://www.beirutairport.gov.lb/_flight.php?type=${type}`;
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        $('table.flight_table tbody tr').each((i, row) => {
            const cells = $(row).find('td');
            const airlineCode = $(cells).eq(0).find('img').attr('alt')?.toUpperCase().trim();

            if (cells.length === 9 && airlineCode) {
                const flightNumber = $(cells).eq(2).text().trim();
                const date = $(row).closest('table').find('tr.date_row').text().trim();
                if (!flightNumber || !date) return;
                
                // **FIX**: Replaces multiple whitespace/&nbsp; with a single space to preserve word separation.
                const statusText = $(cells).eq(7).text().replace(/(&nbsp;|\s)+/g, ' ').trim();

                const id = `${flightNumber}-${date}`;
                flightData[id] = {
                    flightNumber,
                    status: statusText,
                    actualTime: $(cells).eq(8).text().trim(),
                    type: type,
                    airlineCode: airlineCode,
                };
            }
        });
    }
    return flightData;
}

// --- 2. NOTIFICATION LOGIC (FIXED) ---
async function sendGroupedNotification(allChanges) {
    if (allChanges.length === 0) {
        console.log('No changes to notify.');
        return;
    }

    console.log(`Grouping ${allChanges.length} changes into one notification.`);
    const body = allChanges.map(c => c.message).slice(0, 3).join('\n');
    const departureCount = allChanges.filter(c => c.type === 'dprtr').length;
    const isMostlyDepartures = departureCount >= allChanges.length / 2;
    const title = isMostlyDepartures ? '✈️ Departure Updates' : '✈️ Arrival Updates';
    const soundFile = isMostlyDepartures ? 'departure_sound.aiff' : 'arrival_sound.aiff';
    const changedAirlineCodes = [...new Set(allChanges.map(c => c.airlineCode))];
    
    // **FIX**: Explicitly and correctly build the filter logic to handle all user subscription cases.
    const filters = [];

    // Group 1: Target users subscribed to "all_flights".
    filters.push({ "field": "tag", "key": "all_flights", "relation": "=", "value": "1" });

    // Group 2: Target users subscribed to one of the specific airlines that changed.
    changedAirlineCodes.forEach(code => {
        filters.push({ "operator": "OR" });
        filters.push({ "field": "tag", "key": code, "relation": "=", "value": "1" });
    });

    // Group 3: Target new users who have NOT set any airline preference tags.
    // This creates a block like: (tag ME !exists AND tag TK !exists AND ...).
    const newUserConditions = allKnownTags
        .filter(tag => tag !== 'all_flights') // Exclude the general tag from this check.
        .flatMap((code, index) => {
            const condition = { field: 'tag', key: code, relation: 'not_exists' };
            // Add 'AND' operator before all but the first condition in this block.
            return index > 0 ? [{ operator: 'AND' }, condition] : [condition];
        });

    // Combine Group 3 with the others using an OR.
    if (newUserConditions.length > 0) {
        filters.push({ "operator": "OR" });
        filters.push(...newUserConditions);
    }
    
    await axios.post('https://onesignal.com/api/v1/notifications', 
        {
            app_id: process.env.ONESIGNAL_APP_ID,
            filters: filters,
            headings: { en: title },
            contents: { en: body },
            ios_sound: soundFile,
        },
        {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
            },
        }
    ).catch(err => console.error("OneSignal API Error:", err.response?.data));
}

// --- 3. MAIN WORKFLOW ---
async function main() {
    let oldData = {};
    try {
        oldData = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (error) {
        console.log('No previous data file found.');
    }

    const newData = await scrapeFlights();
    const allChanges = [];

    for (const id in newData) {
        const oldFlight = oldData[id];
        const newFlight = newData[id];

        if (oldFlight && oldFlight.status !== newFlight.status) {
            if (newFlight.status && newFlight.status.trim() !== '') {
                allChanges.push({
                    message: `${newFlight.flightNumber} status: ${newFlight.status}`,
                    airlineCode: newFlight.airlineCode,
                    type: newFlight.type,
                });
            } else {
                console.log(`Skipping notification for ${newFlight.flightNumber} because the new status is empty.`);
            }
        }
    }

    await sendGroupedNotification(allChanges);

    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));
    
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
    execSync('git add flight_data.json');
    execSync('git commit -m "Update flight data" || exit 0');
    execSync('git push');
    console.log('Workflow finished.');
}

main().catch(console.error);
