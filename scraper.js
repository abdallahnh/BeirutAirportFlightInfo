const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// A map to translate airline codes into full names for notifications.
const airlineNames = {
    "ME": "Middle East Airlines",
    "TK": "Turkish Airlines",
    "AF": "Air France",
    "EK": "Emirates",
    "QR": "Qatar Airways",
    "RJ": "Royal Jordanian",
    "PC": "Pegasus Airlines",
    "IA": "Iraqi Airways"
};

// All tags a user can subscribe to.
const allKnownTags = [
    "ME", "TK", "AF", "EK", "QR", "RJ", "PC", "IA", "all_flights"
];

// --- 1. SCRAPING LOGIC (Unchanged) ---
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

// --- 2. NOTIFICATION LOGIC (NEW: Per-Airline) ---
async function sendAirlineNotification(airlineCode, changes) {
    if (changes.length === 0) {
        return;
    }

    // Use the full airline name, or default to the code if not found.
    const airlineName = airlineNames[airlineCode] || airlineCode;
    const title = `✈️ ${airlineName} Update`;
    
    let body;
    if (changes.length === 1) {
        // If only one flight for this airline changed, be specific.
        body = changes[0].message; // e.g., "ME266 status: On Time"
    } else {
        // If multiple flights changed, summarize.
        body = `${changes.length} flight updates. First update: ${changes[0].message}`;
    }

    // Filter is now much simpler: send to users subscribed to this specific
    // airline OR to "all_flights".
    const filters = [
        { "field": "tag", "key": airlineCode, "relation": "=", "value": "1" },
        { "operator": "OR" },
        { "field": "tag", "key": "all_flights", "relation": "=", "value": "1" }
    ];

    const departureCount = changes.filter(c => c.type === 'dprtr').length;
    const soundFile = (departureCount >= changes.length / 2) ? 'departure_sound.aiff' : 'arrival_sound.aiff';
    
    console.log(`Sending notification for ${airlineCode}: "${body}"`);

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
    ).catch(err => console.error(`OneSignal API Error for ${airlineCode}:`, err.response?.data));
}

// --- 3. MAIN WORKFLOW (NEW: Grouping Logic) ---
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
                    message: `${newFlight.flightNumber} (${newFlight.airlineCode}) status: ${newFlight.status}`,
                    airlineCode: newFlight.airlineCode,
                    type: newFlight.type,
                });
            } else {
                console.log(`Skipping notification for ${newFlight.flightNumber} because new status is empty.`);
            }
        }
    }

    if (allChanges.length > 0) {
        // **NEW**: Group all changes by their airline code.
        const changesByAirline = allChanges.reduce((acc, change) => {
            const code = change.airlineCode;
            if (!acc[code]) {
                acc[code] = [];
            }
            acc[code].push(change);
            return acc;
        }, {});

        // **NEW**: Loop through each airline that had changes and send a
        // dedicated notification for it.
        for (const airlineCode in changesByAirline) {
            const specificChanges = changesByAirline[airlineCode];
            await sendAirlineNotification(airlineCode, specificChanges);
        }
    } else {
        console.log('No changes to notify.');
    }


    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));
    
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
    execSync('git add flight_data.json');
    execSync('git commit -m "Update flight data" || exit 0');
    execSync('git push');
    console.log('Workflow finished.');
}

main().catch(console.error);
