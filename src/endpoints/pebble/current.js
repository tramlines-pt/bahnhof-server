const express = require('express');
const axios = require('axios');
const router = express.Router();

const port = process.env.PORT || 3000;

router.get('/:evaNo', async (req, res) => {
    const evaNo = req.params.evaNo;

    try {
        const planResponse = await axios.get(`http://localhost:${port}/current/${evaNo}?duration=120`);
        // First filter out unwanted entries
        let filteredEntries = planResponse.data.entries.filter(entry => {
            // Keep only if it's a departure AND not cancelled AND not BUS AND not TRAM
            return entry[0].direction == "departure" && 
                   !entry[0].cancelled &&
                   entry[0].type != "BUS"
        });
        
        // Then map the filtered entries to your desired format
        let response = filteredEntries.map(entry => ([
            entry[0].journeyID,
            entry[0].type,
            entry[0].lineName,
            formatDestination(entry[0].destination),
            entry[0].timeDelayed,
            entry[0].platform,
        ]));

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