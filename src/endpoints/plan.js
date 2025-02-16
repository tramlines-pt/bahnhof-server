const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const router = express.Router();

const CACHE_DURATION = 24 * 60 * 60 * 1000; // Cache duration: 24 hours
const planCache = {};

router.get('/:evaNo/:date?/:hour?', async (req, res) => {
  const evaNo = req.params.evaNo;
  // date is in format YYMMDD
  const date = req.params.date || new Date().toISOString().slice(2, 10).replace(/-/g, '');
  // hour is in format HH, note that we need to consider timezone of Germany
  const hour = req.params.hour || new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).slice(0, 2);
  const cacheKey = `${evaNo}_${date}_${hour}`;
  
  // Serve from cache if available and valid
  if (planCache[cacheKey] && Date.now() - planCache[cacheKey].timestamp < CACHE_DURATION) {
    res.type('application/json').send(planCache[cacheKey].data);
    return;
  }

  try {
    const response = await axios.get(`https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/plan/${evaNo}/${date}/${hour}`, {
      headers: {
        "DB-Client-ID": process.env.DB_CLIENT_ID,
        "DB-Api-Key": process.env.DB_CLIENT_SECRET,
        accept: 'application/xml'
      }
    });
  
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    parser.parseString(response.data, (err, result) => {
      if (err) {
        //console.log(err);
        return res.status(500).send('Error parsing XML');
      }
      
      // Cache the result
      planCache[cacheKey] = {
        timestamp: Date.now(),
        data: result
      };
      
      res.type('application/json').send(result);
    });
  } catch (error) {
    //console.error(error);
    return res.status(500).send('Error fetching timetable');
  }
});

module.exports = router;