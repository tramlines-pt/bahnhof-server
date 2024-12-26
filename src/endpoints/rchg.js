const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const router = express.Router();

router.get('/:evaNo', async (req, res) => {
    const evaNo = req.params.evaNo;

    try {
        const response = await axios.get(`https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/rchg/${evaNo}`, {
            headers: {
                "DB-Client-ID": process.env.DB_CLIENT_ID,
                "DB-Api-Key": process.env.DB_CLIENT_SECRET,
                accept: 'application/xml'
            }
        });
    
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        parser.parseString(response.data, (err, result) => {
            if (err) {
                console.log(err);
                return res.status(500).send('Error parsing XML');
            }
    
            res.json(result);
        });
    } catch (error) {
        //console.log(error);
        return res.status(500).send('Error fetching timetable');
    }
});

module.exports = router;