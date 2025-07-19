const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

const allKnownTags = [
    "ME", "TK", "AF", "EK", "QR", "RJ", "PC", "all_flights"
    // Add all other codes you have in your app
];

// --- 1. SCRAPING LOGIC (No changes here) ---
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
                
                const id = `${flightNumber}-${date}`;
                flightData[id] = {
                    flightNumber,
                    status: $(cells).eq(7).text().trim(),
                    actualTime: $(cells).eq(8).text().trim(),
                    type: type,
                    airlineCode: airlineCode,
                };
            }
        });
    }
    return flightData;
}

// --- 2. NOTIFICATION LOGIC (Rewritten for Grouping) ---
async function sendGroupedNotification(allChanges) {
    if (allChanges.length === 0) {
        console.log('No changes to notify.');
        return;
    }

    console.log(`Grouping ${allChanges.length} changes into one notification.`);
    
    // Create a summary body from all the change messages
    const body = allChanges.map(c => c.message).slice(0, 3).join('\n'); // Show first 3 changes
    
    // Determine if it's mostly departures or arrivals for the title and sound
    const departureCount = allChanges.filter(c => c.type === 'dprtr').length;
    const isMostlyDepartures = departureCount >= allChanges.length / 2;
    const title = isMostlyDepartures ? '✈️ Departure Updates' : '✈️ Arrival Updates';
    const soundFile = isMostlyDepartures ? 'departure_sound.aiff' : 'arrival_sound.aiff';

    // Get a unique list of all airline codes that have changed
    const changedAirlineCodes = [...new Set(allChanges.map(c => c.airlineCode))];
    
    // Build the filters for targeting users
    const filters = [];

    // GROUP 1: Users subscribed to "All Flights"
    filters.push({ "field": "tag", "key": "all_flights", "relation": "=", "value": "1" });

    // GROUP 2: Users subscribed to ANY of the changed airlines
    changedAirlineCodes.forEach(code => {
        filters.push({ "operator": "OR" });
        filters.push({ "field": "tag", "key": code, "relation": "=", "value": "1" });
    });

    // GROUP 3: Unconfigured users (backward compatibility)
    filters.push({ "operator": "OR" });
    filters.push(...allKnownTags.map(code => ({ "field": "tag", "key": code, "relation": "not_exists" })));
    
    // Send the single, targeted notification
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

// --- 3. MAIN WORKFLOW (Updated to collect changes first) ---
async function main() {
    let oldData = {};
    try {
        oldData = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (error) {
        console.log('No previous data file found.');
    }

    const newData = await scrapeFlights();
    
    // **CHANGE**: Create a single list to collect all changes
    const allChanges = [];

    for (const id in newData) {
        const oldFlight = oldData[id];
        const newFlight = newData[id];

        // If a status change is found, add it to our collection
        if (oldFlight && oldFlight.status !== newFlight.status) {
            allChanges.push({
                message: `${newFlight.flightNumber} status: ${newFlight.status}`,
                airlineCode: newFlight.airlineCode,
                type: newFlight.type,
            });
        }
    }

    // **CHANGE**: After checking all flights, send all collected changes at once
    await sendGroupedNotification(allChanges);

    // Save and commit the new data
    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));
    
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
    execSync('git add flight_data.json');
    execSync('git commit -m "Update flight data" || exit 0');
    execSync('git push');
    console.log('Workflow finished.');
}

main().catch(console.error);
