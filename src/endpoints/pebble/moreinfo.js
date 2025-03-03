const express = require('express');
const axios = require('axios');
const router = express.Router();

const port = process.env.PORT || 3000;

router.get('/:evaNo/:journeyId', async (req, res) => {
    const evaNo = req.params.evaNo;
    const journeyId = req.params.journeyId;

    try {
        const planResponse = await axios.get(`http://localhost:${port}/current/${evaNo}`);
        //search for object with matching journeyId
        let entry = planResponse.data.entries.find(entry => entry[0].journeyID == journeyId);

        if (!entry) {
            return res.status(404).send('Journey not found');
        }

        let stops = entry[0].viaStops.map(stop => ([
            stop.evaNumber,
            stop.name,
        ]));

        stops.push([
            entry[0].destination.evaNumber,
            entry[0].destination.name
        ])

        let response = {
            lineName: entry[0].lineName,
            destination: formatDestination(entry[0].destination),
            timeSchedule: entry[0].timeSchedule,
            timeDelayed: entry[0].timeDelayed,
            platform: entry[0].platform,
            type: entry[0].type,
            stops: stops,
        };

        res.json(response);
    } catch (error) {
        console.error(error);
        return res.status(500).send('Error fetching plan');
    }
});

function formatDestination(destination) {
    if (!destination || !destination.nameParts) {
      return destination?.name || 'Unknown'; // Fallback if structure isn't as expected
    }
    
    // Filter out airport parts and join their values
    return destination.nameParts
      .filter(part => part.type !== "airport")
      .map(part => part.value)
      .join("");
  }

module.exports = router;