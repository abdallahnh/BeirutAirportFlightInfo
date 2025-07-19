const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// **CHANGE**: Add a list of all possible airline codes here.
// This must match the list in your iOS app's AirlineData.swift file.
const allAirlineCodes = [
    "ME", "TK", "AF", "EK", "QR", "RJ", 
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

// --- 2. NOTIFICATION LOGIC (Updated to include unconfigured users) ---
async function sendNotification(change) {
    console.log(`Sending notification for ${change.flightNumber} of airline ${change.airlineCode}...`);
    const body = `${change.flightNumber} status: ${change.newStatus}`;
    const title = change.type === 'dprtr' ? '✈️ Departure Update' : '✈️ Arrival Update';
    const soundFile = change.type === 'dprtr' ? 'departure_sound.aiff' : 'arrival_sound.aiff';
    
    // **CHANGE**: Build a complex filter to target two groups of users.
    const filters = [
        // GROUP 1: Users who are explicitly subscribed to this airline.
        { "field": "tag", "key": change.airlineCode, "relation": "=", "value": "1" },
        
        // OR
        { "operator": "OR" },

        // GROUP 2: Users who have NOT set ANY airline preference yet.
        // We do this by checking that all possible airline tags "do not exist".
        ...allAirlineCodes.map(code => ({ "field": "tag", "key": code, "relation": "not_exists" }))
    ];

    await axios.post('https://onesignal.com/api/v1/notifications', 
        {
            app_id: process.env.ONESIGNAL_APP_ID,
            filters: filters, // Use the new advanced filter
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

// --- 3. MAIN WORKFLOW (No changes here) ---
async function main() {
    let oldData = {};
    try {
        oldData = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (error) {
        console.log('No previous data file found.');
    }

    const newData = await scrapeFlights();

    for (const id in newData) {
        const oldFlight = oldData[id];
        const newFlight = newData[id];

        if (oldFlight && oldFlight.status !== newFlight.status) {
            await sendNotification({
                flightNumber: newFlight.flightNumber,
                airlineCode: newFlight.airlineCode,
                newStatus: newFlight.status,
                type: newFlight.type,
            });
        }
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
