const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { execSync } = require('child_process');

const DATA_FILE = 'flight_data.json';

// --- 1. SCRAPING LOGIC (Updated) ---
async function scrapeFlights() {
    const flightData = {};
    // Loop through both flight types
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
                // **CHANGE**: We now save the 'type' with each flight
                flightData[id] = {
                    flightNumber,
                    status: $(cells).eq(7).text().trim(),
                    actualTime: $(cells).eq(8).text().trim(),
                    type: type, // <-- Add this line
                };
            }
        });
    }
    return flightData;
}

// --- 2. NOTIFICATION LOGIC (Updated) ---
async function sendNotification(changes, flightType) {
    if (changes.length === 0) {
        console.log(`No ${flightType} changes to notify.`);
        return;
    }
    
    console.log(`Sending notification for ${changes.length} ${flightType} changes...`);
    const body = changes.slice(0, 2).join('\n');
    
    // **CHANGE**: Create a dynamic title and sound based on the flight type
    const title = flightType === 'dprtr' ? '✈️ Departure Update' : '✈️ Arrival Update';
    const soundFile = flightType === 'dprtr' ? 'departure_sound.aiff' : 'arrival_sound.aiff';
    
    const response = await axios.post('https://onesignal.com/api/v1/notifications', 
        {
            app_id: process.env.ONESIGNAL_APP_ID,
            included_segments: ['All'],
            headings: { en: title },
            contents: { en: body },
            ios_sound: soundFile, // Use the specific sound file
        },
        {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
            },
        }
    );
    console.log('OneSignal response:', response.status);
}

// --- 3. MAIN WORKFLOW (Updated) ---
async function main() {
    let oldData = {};
    try {
        oldData = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        console.log(`Loaded ${Object.keys(oldData).length} flights from previous run.`);
    } catch (error) {
        console.log('No previous data file found. Starting fresh.');
    }

    const newData = await scrapeFlights();
    console.log(`Scraped ${Object.keys(newData).length} new flights.`);

    // **CHANGE**: Create separate lists for arrival and departure changes
    const arrivalChanges = [];
    const departureChanges = [];

    // Loop through new data and sort changes into the correct list
    for (const id in newData) {
        if (oldData[id] && JSON.stringify(newData[id]) !== JSON.stringify(oldData[id])) {
            const changeMessage = `${newData[id].flightNumber} status: ${newData[id].status}`;
            
            // Check the type we saved earlier to sort the change
            if (newData[id].type === 'arivl') {
                arrivalChanges.push(changeMessage);
            } else {
                departureChanges.push(changeMessage);
            }
        }
    }

    // **CHANGE**: Send notifications separately for each type
    await sendNotification(arrivalChanges, 'arivl');
    await sendNotification(departureChanges, 'dprtr');

    // Save new data to the file and commit it for the next run
    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));
    console.log('Wrote new data to file.');
    
    execSync('git config --global user.email "action@github.com"');
    execSync('git config --global user.name "GitHub Action"');
    execSync('git add flight_data.json');
    execSync('git commit -m "Update flight data" || exit 0');
    execSync('git push');
    console.log('Committed and pushed updated data.');
}

main().catch(console.error);
