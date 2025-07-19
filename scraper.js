const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// **UPDATED**: A comprehensive list of airlines serving Beirut (BEY).
// Sorted alphabetically for easier maintenance.
const airlineNames = {
    "A3": "Aegean Airlines",
    "G9": "Air Arabia",
    "JU": "Air Serbia",
    "AF": "Air France",
    "AZ": "ITA Airways",
    "VF": "AnadoluJet",
    "JI": "Armenian Airlines",
    "BA": "British Airways",
    "SN": "Brussels Airlines",
    "CY": "Cyprus Airways",
    "MS": "EgyptAir",
    "EK": "Emirates",
    "ET": "Ethiopian Airlines",
    "EY": "Etihad Airways",
    "FZ": "flydubai",
    "XY": "flynas",
    "GF": "Gulf Air",
    "IA": "Iraqi Airways",
    "J9": "Jazeera Airways",
    "KL": "KLM",
    "KU": "Kuwait Airways",
    "LO": "LOT Polish Airlines",
    "LH": "Lufthansa",
    "ME": "Middle East Airlines",
    "WY": "Oman Air",
    "PC": "Pegasus Airlines",
    "QR": "Qatar Airways",
    "AT": "Royal Air Maroc",
    "RJ": "Royal Jordanian",
    "SK": "Scandinavian Airlines",
    "SV": "Saudia",
    "XQ": "SunExpress",
    "LX": "SWISS",
    "RO": "TAROM",
    "HV": "Transavia",
    "TU": "Tunisair",
    "TK": "Turkish Airlines",
    "W6": "Wizz Air"
};

// **UPDATED**: This list is now generated automatically from the keys of airlineNames
// to ensure it's always in sync. The special "all_flights" tag is added at the end.
const allKnownTags = [...Object.keys(airlineNames), "all_flights"];


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

// --- 2. NOTIFICATION LOGIC (Unchanged) ---
async function sendAirlineNotification(airlineCode, changes) {
    if (changes.length === 0) {
        return;
    }

    const departureCount = changes.filter(c => c.type === 'dprtr').length;
    const isMostlyDepartures = departureCount >= changes.length / 2;
    const title = isMostlyDepartures ? '✈️ Departure Updates' : '✈️ Arrival Updates';
    const soundFile = isMostlyDepartures ? 'departure_sound.aiff' : 'arrival_sound.aiff';
    
    let body;
    if (changes.length === 1) {
        body = changes[0].message; 
    } else {
        body = `${changes.length} updates for ${airlineNames[airlineCode] || airlineCode}. First: ${changes[0].message}`;
    }

    const filters = [
        { "field": "tag", "key": airlineCode, "relation": "=", "value": "1" },
        { "operator": "OR" },
        { "field": "tag", "key": "all_flights", "relation": "=", "value": "1" }
    ];
    
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

// --- 3. MAIN WORKFLOW (Unchanged) ---
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
                const airlineName = airlineNames[newFlight.airlineCode] || newFlight.airlineCode;
                allChanges.push({
                    message: `${airlineName}: ${newFlight.flightNumber} status is now ${newFlight.status}`,
                    airlineCode: newFlight.airlineCode,
                    type: newFlight.type,
                });
            } else {
                console.log(`Skipping notification for ${newFlight.flightNumber} because new status is empty.`);
            }
        }
    }

    if (allChanges.length > 0) {
        const changesByAirline = allChanges.reduce((acc, change) => {
            const code = change.airlineCode;
            if (!acc[code]) {
                acc[code] = [];
            }
            acc[code].push(change);
            return acc;
        }, {});

        for (const airlineCode in changesByAirline) {
            // Ensure we only process airlines we have defined as tags.
            if (allKnownTags.includes(airlineCode)) {
                const specificChanges = changesByAirline[airlineCode];
                await sendAirlineNotification(airlineCode, specificChanges);
            }
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
