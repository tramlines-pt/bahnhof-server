const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const CACHE_DIR = path.join(__dirname, '../../.tramlines');
const CACHE_FILE = path.join(CACHE_DIR, 'stations_cache.json');
const CACHE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

async function fetchStations() {
  const response = await axios.get('https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations', {
    headers: {
      "DB-Client-ID": process.env.DB_CLIENT_ID,
      "DB-Api-Key": process.env.DB_CLIENT_SECRET
    }
  });
  return response.data;
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - cache.timestamp < CACHE_DURATION) {
      return cache.data;
    }
  }
  return null;
}

function saveCache(data) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cache = {
    timestamp: Date.now(),
    data: data
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

router.get('/', async (req, res) => {
  let cachedStations = loadCache();

  if (!cachedStations) {
    try {
      cachedStations = await fetchStations();
      saveCache(cachedStations);
    } catch (error) {
      //console.log(error);
      return res.status(500).send('Error fetching stations');
    }
  }

  const federalStates = req.query.federalstate;
  const searchString = req.query.searchstring;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius);
  const limit = parseInt(req.query.limit);

  let filteredStations = {};

  if (federalStates) {
    const statesArray = Array.isArray(federalStates) ? federalStates.map(state => state.toLowerCase()) : [federalStates.toLowerCase()];
    for (let station of cachedStations.result) {
      if (statesArray.includes(station.federalState.toLowerCase())) {
        filteredStations[station.number] = station;
      }
    }
  } else {
    for (let station of cachedStations.result) {
      filteredStations[station.number] = station;
    }
  }

  if (searchString) {
    const searchPatterns = searchString.split(',').map(pattern => {
      const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(regexPattern, 'i'); // removed ^ and $ to allow partial matches.
    });
  
    filteredStations = Object.values(filteredStations).filter(station => {
      return searchPatterns.some(pattern => pattern.test(station.name));
    }).reduce((acc, station) => {
      acc[station.number] = station;
      return acc;
    }, {});
  }

  if (!isNaN(lat) && !isNaN(lon) && !isNaN(radius)) {
    const toRadians = degrees => degrees * (Math.PI / 180);
    const haversineDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371000; // Earth radius in meters
      const dLat = toRadians(lat2 - lat1);
      const dLon = toRadians(lon2 - lon1);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    // Map stations to include their distance:
    let stationsWithDistance = Object.values(filteredStations).map(station => {
      const [stationLon, stationLat] = station.evaNumbers?.[0]?.geographicCoordinates?.coordinates || [NaN, NaN];
      if (isNaN(stationLat) || isNaN(stationLon)) {
      }
      const distance = haversineDistance(lat, lon, stationLat, stationLon);
      return { ...station, distance };
    });

    // Filter based on the radius, sort by distance:
    stationsWithDistance = stationsWithDistance
      .filter(station => station.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    // Apply limit if provided:
    if (!isNaN(limit)) {
      stationsWithDistance = stationsWithDistance.slice(0, limit);
    }

    // Rebuild filteredStations as an object indexed by station number:
    filteredStations = stationsWithDistance.reduce((acc, station) => {
      acc[station.number] = station;
      return acc;
    }, {});
  }

  res.json(filteredStations);
});

router.get('/:id', async (req, res) => {
  const stationId = req.params.id;
  let cachedStations = loadCache();

  if (!cachedStations) {
    try {
      cachedStations = await fetchStations();
      saveCache(cachedStations);
    } catch (error) {
      return res.status(500).send('Error fetching stations');
    }
  }

  const station = cachedStations.result[stationId];

  if (station) {
    res.json(station);
  } else {
    res.status(404).send('Station not found');
  }
});

module.exports = router;