const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/:evaNo', async (req, res) => {
    const evaNo = req.params.evaNo;
    const duration = req.query.duration || 360;

    try {
        //example url: https://www.bahnhof.de/api/boards/departures?evaNumbers=8000105&filterTransports=BUS&duration=60&locale=de
        const planResponse = await axios.get(`https://www.bahnhof.de/api/boards/departures?evaNumbers=${evaNo}&duration=${duration}&locale=de`);

        res.json(planResponse.data);
    } catch (error) {
        console.error(error);
        return res.status(500).send('Error fetching plan');
    }
});

module.exports = router;