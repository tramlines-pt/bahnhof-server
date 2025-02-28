const express = require('express');
const axios = require('axios');
const router = express.Router();

const port = process.env.PORT || 3000;

// special endpoint for the pebble tramlines app, it can show less information so we can send a smaller payload :)
router.get('/', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 5000;

    if (!lat || !lon) {
        return res.status(400).send('Missing lat or lon parameter');
    }

    try {
        const planResponse = await axios.get(`http://localhost:${port}/stations?lat=${lat}&lon=${lon}&radius=${radius}`);
        const planData = planResponse.data;
        
        // First check if planData is an array or an object
        let stationsArray;
        
            stationsArray = Object.values(planData).map(station => ([
                station.name,
                convertMetersToKilometers(station.distance),
                station.evaNumbers[0].number,
            ]));

            stationsArray.sort((a, b) => a[1] - b[1]);

        return res.json(stationsArray);
    } catch (error) {
        console.error(error);
        return res.status(500).send('Error fetching plan');
    }
});

function convertMetersToKilometers(meters) {
    return Math.round(meters / 10) / 100;
}

module.exports = router;