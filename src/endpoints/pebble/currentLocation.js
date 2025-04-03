const express = require('express');
const axios = require('axios');
const router = express.Router();

const port = process.env.PORT || 3000;

// basically current and stations combined, for quick launch
router.get('/', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 5000;

    if (!lat || !lon) {
        return res.status(400).send('Missing lat or lon parameter');
    }

    try {
        const stationsResponse = await axios.get(`http://localhost:${port}/pebble/stations?lat=${lat}&lon=${lon}&radius=${radius}`);
        const stationsData = stationsResponse.data;
        //get the first station
        const station = stationsData[0];
        const evaNo = station[2];
        const planResponse = await axios.get(`http://localhost:${port}/pebble/current/${evaNo}`);
        const planData = planResponse.data;

        //return planData

        return res.json({
            station,
            departures: planData
        });
        
    } catch (error) {
        console.error(error);
        return res.status(500).send('Error fetching plan');
    }
});

function convertMetersToKilometers(meters) {
    return Math.round(meters / 10) / 100;
}

module.exports = router;