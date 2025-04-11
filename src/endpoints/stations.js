const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const CACHE_DIR = path.join(__dirname, '../../.tramlines');
const CACHE_FILE = path.join(CACHE_DIR, 'stations_cache.json');
const CACHE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

// Add spatial index to speed up geo queries
let spatialIndex = null;

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

// Create a spatial index from the stations data
function buildSpatialIndex(stations) {
  // Create a simple grid-based spatial index
  const index = {
    cells: {},
    cellSize: 0.1, // approximately 11km at the equator
    
    // Get cell key for a lat/lon
    getCellKey(lat, lon) {
      const latCell = Math.floor(lat / this.cellSize);
      const lonCell = Math.floor(lon / this.cellSize);
      return `${latCell},${lonCell}`;
    },
    
    // Add a station to the index
    addStation(station) {
      const [lon, lat] = station.evaNumbers?.[0]?.geographicCoordinates?.coordinates || [NaN, NaN];
      if (isNaN(lat) || isNaN(lon)) return;
      
      const key = this.getCellKey(lat, lon);
      if (!this.cells[key]) this.cells[key] = [];
      this.cells[key].push(station);
    },
    
    // Find stations near a point within radius
    findNearby(lat, lon, radiusKm) {
      // Calculate how many cells to check in each direction based on radius
      const cellsToCheck = Math.ceil(radiusKm / (this.cellSize * 111)); // 111km per degree at equator
      const centerKey = this.getCellKey(lat, lon);
      const [centerLat, centerLon] = centerKey.split(',').map(Number);
      
      const candidates = [];
      
      // Check all surrounding cells
      for (let latOffset = -cellsToCheck; latOffset <= cellsToCheck; latOffset++) {
        for (let lonOffset = -cellsToCheck; lonOffset <= cellsToCheck; lonOffset++) {
          const key = `${centerLat + latOffset},${centerLon + lonOffset}`;
          const cell = this.cells[key];
          if (cell) candidates.push(...cell);
        }
      }
      
      return candidates;
    }
  };
  
  // Add all stations to the index
  stations.forEach(station => index.addStation(station));
  
  return index;
}

// Calculate Haversine distance efficiently
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRadians = degrees => degrees * (Math.PI / 180);
  const R = 6371000; // Earth radius in meters
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.get('/', async (req, res) => {
  let cachedStations = loadCache();

  if (!cachedStations) {
    try {
      cachedStations = await fetchStations();
      saveCache(cachedStations);
    } catch (error) {
      return res.status(500).send('Error fetching stations');
    }
  }

  // Build spatial index if we don't have one yet
  if (!spatialIndex) {
    spatialIndex = buildSpatialIndex(cachedStations.result);
  }

  const federalStates = req.query.federalstate;
  const searchString = req.query.searchstring;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius);
  const radiusKm = radius / 1000; // Convert to kilometers
  const limit = parseInt(req.query.limit);

  let filteredStations = {};

  // Use different filtering strategies based on query parameters
  if (!isNaN(lat) && !isNaN(lon) && !isNaN(radius)) {
    // Use spatial index for location-based queries - much faster!
    const candidateStations = spatialIndex.findNearby(lat, lon, radiusKm);
    
    // Now do exact distance calculation only on the candidates
    const stationsWithDistance = candidateStations
      .map(station => {
        const [stationLon, stationLat] = station.evaNumbers?.[0]?.geographicCoordinates?.coordinates || [NaN, NaN];
        if (isNaN(stationLat) || isNaN(stationLon)) return null;
        
        const distance = haversineDistance(lat, lon, stationLat, stationLon);
        return { ...station, distance };
      })
      .filter(station => station !== null && station.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    
    // Apply limit if provided
    const limitedStations = !isNaN(limit) 
      ? stationsWithDistance.slice(0, limit) 
      : stationsWithDistance;
    
    // Convert to the expected format
    filteredStations = limitedStations.reduce((acc, station) => {
      acc[station.number] = station;
      return acc;
    }, {});
  } else {
    // For non-geographic queries, use the original filtering logic
    if (federalStates) {
      // Federal state filtering logic...
      const statesArray = Array.isArray(federalStates) 
        ? federalStates.map(state => state.toLowerCase()) 
        : [federalStates.toLowerCase()];
      
      for (let station of cachedStations.result) {
        if (statesArray.includes(station.federalState.toLowerCase())) {
          filteredStations[station.number] = station;
        }
      }
    } else {
      // Include all stations
      for (let station of cachedStations.result) {
        filteredStations[station.number] = station;
      }
    }

    // Search string filtering
    if (searchString) {
      const searchPatterns = searchString.split(',').map(pattern => {
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(regexPattern, 'i');
      });
    
      filteredStations = Object.values(filteredStations)
        .filter(station => searchPatterns.some(pattern => pattern.test(station.name)))
        .reduce((acc, station) => {
          acc[station.number] = station;
          return acc;
        }, {});
    }
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