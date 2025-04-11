const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const CACHE_DIR = path.join(__dirname, '../../.tramlines');
const CACHE_FILE = path.join(CACHE_DIR, 'stations_cache.json');
const INDEX_FILE = path.join(CACHE_DIR, 'spatial_index.json');
const CACHE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

// Add spatial index to speed up geo queries
let spatialIndex = null;
// Recent query cache
const queryCache = new Map();
const QUERY_CACHE_SIZE = 20;
const QUERY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

// Try to load the spatial index from disk
function loadSpatialIndex() {
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (Date.now() - index.timestamp < CACHE_DURATION) {
        console.log("Loading spatial index from file");
        return rebuildIndexMethods(index);
      }
    } catch (error) {
      console.error("Error loading index:", error);
    }
  }
  return null;
}

// Save index to disk for faster startup
function saveSpatialIndex(index) {
  const serializedIndex = {
    ...index,
    timestamp: Date.now()
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(serializedIndex), 'utf8');
  console.log("Saved spatial index to disk");
}

// Reattach methods to loaded JSON index
function rebuildIndexMethods(index) {
  return {
    ...index,
    getCellKey: function(lat, lon) {
      const latCell = Math.floor(lat / this.cellSize);
      const lonCell = Math.floor(lon / this.cellSize);
      return `${latCell},${lonCell}`;
    },
    findNearby: function(lat, lon, radiusKm) {
      // Fast square approximation first
      const cellsToCheck = Math.ceil(radiusKm / (this.cellSize * 111));
      const centerKey = this.getCellKey(lat, lon);
      const [centerLat, centerLon] = centerKey.split(',').map(Number);
      
      const candidates = [];
      
      // Check cells in expanding squares (optimization: check closer cells first)
      for (let r = 0; r <= cellsToCheck; r++) {
        // If r=0, just check center cell
        if (r === 0) {
          const key = `${centerLat},${centerLon}`;
          if (this.cells[key]) candidates.push(...this.cells[key]);
          continue;
        }
        
        // Check the perimeter of a square with radius r
        for (let i = -r; i <= r; i++) {
          // Top and bottom edges of the square
          const topKey = `${centerLat-r},${centerLon+i}`;
          const bottomKey = `${centerLat+r},${centerLon+i}`;
          
          if (this.cells[topKey]) candidates.push(...this.cells[topKey]);
          if (this.cells[bottomKey] && r !== 0) candidates.push(...this.cells[bottomKey]);
          
          // Left and right edges (avoid corners which we've already done)
          if (i > -r && i < r) {
            const leftKey = `${centerLat+i},${centerLon-r}`;
            const rightKey = `${centerLat+i},${centerLon+r}`;
            
            if (this.cells[leftKey]) candidates.push(...this.cells[leftKey]);
            if (this.cells[rightKey]) candidates.push(...this.cells[rightKey]);
          }
        }
        
        // Early stopping: if we have enough candidates, stop searching
        // This is a significant optimization for large radius searches
        if (candidates.length > 200) break;
      }
      
      return candidates;
    }
  };
}

// Create an optimized spatial index
function buildSpatialIndex(stations) {
  // First try to load from file
  const loadedIndex = loadSpatialIndex();
  if (loadedIndex) return loadedIndex;
  
  console.log("Building new spatial index");
  
  // Create a simple grid-based spatial index with pre-extracted coordinates
  const index = {
    cells: {},
    cellSize: 0.05, // smaller cells for better precision (approx 5.5km)
    stationCoords: {}, // Pre-extract coordinates for quick access
    
    getCellKey(lat, lon) {
      const latCell = Math.floor(lat / this.cellSize);
      const lonCell = Math.floor(lon / this.cellSize);
      return `${latCell},${lonCell}`;
    },
    
    addStation(station) {
      const [lon, lat] = station.evaNumbers?.[0]?.geographicCoordinates?.coordinates || [NaN, NaN];
      if (isNaN(lat) || isNaN(lon)) return;
      
      // Store coordinates for quick access later
      this.stationCoords[station.number] = { lat, lon };
      
      // Create a lightweight station object with just essential info
      const lightStation = {
        number: station.number,
        name: station.name,
        evaNumbers: station.evaNumbers
      };
      
      // Add to primary cell
      const key = this.getCellKey(lat, lon);
      if (!this.cells[key]) this.cells[key] = [];
      this.cells[key].push(lightStation);
      
      // For stations near cell boundaries, add to neighboring cells too
      // to avoid edge cases in searches
      const latRemainder = (lat / this.cellSize) - Math.floor(lat / this.cellSize);
      const lonRemainder = (lon / this.cellSize) - Math.floor(lon / this.cellSize);
      
      if (latRemainder < 0.1) {
        const neighborKey = this.getCellKey(lat - this.cellSize * 0.2, lon);
        if (!this.cells[neighborKey]) this.cells[neighborKey] = [];
        this.cells[neighborKey].push(lightStation);
      } else if (latRemainder > 0.9) {
        const neighborKey = this.getCellKey(lat + this.cellSize * 0.2, lon);
        if (!this.cells[neighborKey]) this.cells[neighborKey] = [];
        this.cells[neighborKey].push(lightStation);
      }
      
      if (lonRemainder < 0.1) {
        const neighborKey = this.getCellKey(lat, lon - this.cellSize * 0.2);
        if (!this.cells[neighborKey]) this.cells[neighborKey] = [];
        this.cells[neighborKey].push(lightStation);
      } else if (lonRemainder > 0.9) {
        const neighborKey = this.getCellKey(lat, lon + this.cellSize * 0.2);
        if (!this.cells[neighborKey]) this.cells[neighborKey] = [];
        this.cells[neighborKey].push(lightStation);
      }
    },
    
    findNearby(lat, lon, radiusKm) {
      // Fast square approximation first
      const cellsToCheck = Math.ceil(radiusKm / (this.cellSize * 111));
      const centerKey = this.getCellKey(lat, lon);
      const [centerLat, centerLon] = centerKey.split(',').map(Number);
      
      const candidates = [];
      
      // Check cells in expanding squares (optimization: check closer cells first)
      for (let r = 0; r <= cellsToCheck; r++) {
        // If r=0, just check center cell
        if (r === 0) {
          const key = `${centerLat},${centerLon}`;
          if (this.cells[key]) candidates.push(...this.cells[key]);
          continue;
        }
        
        // Check the perimeter of a square with radius r
        for (let i = -r; i <= r; i++) {
          // Top and bottom edges of the square
          const topKey = `${centerLat-r},${centerLon+i}`;
          const bottomKey = `${centerLat+r},${centerLon+i}`;
          
          if (this.cells[topKey]) candidates.push(...this.cells[topKey]);
          if (this.cells[bottomKey] && r !== 0) candidates.push(...this.cells[bottomKey]);
          
          // Left and right edges (avoid corners which we've already done)
          if (i > -r && i < r) {
            const leftKey = `${centerLat+i},${centerLon-r}`;
            const rightKey = `${centerLat+i},${centerLon+r}`;
            
            if (this.cells[leftKey]) candidates.push(...this.cells[leftKey]);
            if (this.cells[rightKey]) candidates.push(...this.cells[rightKey]);
          }
        }
        
        // Early stopping: if we have enough candidates, stop searching
        if (candidates.length > 200) break;
      }
      
      return candidates;
    }
  };
  
  // Add all stations to the index
  stations.forEach(station => index.addStation(station));
  
  // Save the index to disk for faster startup next time
  saveSpatialIndex(index);
  
  return index;
}

// Fast approximate distance for first-pass filtering
function approximateDistance(lat1, lon1, lat2, lon2) {
  const latDiff = (lat2 - lat1) * 111000; // 111km per degree
  const lonDiff = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI/180);
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
}

// Accurate Haversine distance for final sorting
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

// Generate a cache key for query parameters
function generateCacheKey(params) {
  const { lat, lon, radius, limit, searchString, federalStates } = params;
  let key = '';
  
  if (!isNaN(lat) && !isNaN(lon)) {
    // Round coordinates for better cache hits
    key += `geo:${Math.round(lat * 100) / 100},${Math.round(lon * 100) / 100},${radius}`;
  } else if (searchString) {
    key += `search:${searchString}`;
  } else if (federalStates) {
    key += `state:${federalStates}`;
  } else {
    key = 'all';
  }
  
  if (!isNaN(limit)) key += `,limit:${limit}`;
  return key;
}

router.get('/', async (req, res) => {
  // Check query cache first
  const cacheKey = generateCacheKey({
    lat: parseFloat(req.query.lat),
    lon: parseFloat(req.query.lon),
    radius: parseFloat(req.query.radius),
    limit: parseInt(req.query.limit),
    searchString: req.query.searchstring,
    federalStates: req.query.federalstate
  });
  
  if (queryCache.has(cacheKey)) {
    const cachedResult = queryCache.get(cacheKey);
    if (Date.now() - cachedResult.timestamp < QUERY_CACHE_TTL) {
      return res.json(cachedResult.data);
    }
    // Expired cache entry, remove it
    queryCache.delete(cacheKey);
  }
  
  // Load stations from cache
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
  let startTime = Date.now();

  // Use different filtering strategies based on query parameters
  if (!isNaN(lat) && !isNaN(lon) && !isNaN(radius)) {
    // Use spatial index for location-based queries
    const candidateStations = spatialIndex.findNearby(lat, lon, radiusKm);
    
    // Fast approximate distance for initial filtering
    let stationsWithDistance = candidateStations
      .map(station => {
        const [stationLon, stationLat] = station.evaNumbers?.[0]?.geographicCoordinates?.coordinates || [NaN, NaN];
        if (isNaN(stationLat) || isNaN(stationLon)) return null;
        
        // Use the pre-stored coordinates when possible
        const coords = spatialIndex.stationCoords[station.number] || { lat: stationLat, lon: stationLon };
        
        // Fast approximate distance first
        const approxDistance = approximateDistance(lat, lon, coords.lat, coords.lon);
        
        // Early rejection based on approximate distance
        if (approxDistance > radius * 1.1) return null; // 10% buffer for approximation error
        
        // Only calculate accurate distance for nearby stations
        const distance = haversineDistance(lat, lon, coords.lat, coords.lon);
        
        // Get full station data if needed
        const fullStation = cachedStations.result.find(s => s.number === station.number);
        
        return { ...fullStation, distance };
      })
      .filter(station => station !== null && station.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    
    // Apply limit if provided
    if (!isNaN(limit) && limit > 0) {
      stationsWithDistance = stationsWithDistance.slice(0, limit);
    }
    
    // Convert to the expected format
    filteredStations = stationsWithDistance.reduce((acc, station) => {
      acc[station.number] = station;
      return acc;
    }, {});
  } else {
    // For non-geographic queries, use the original filtering logic
    if (federalStates) {
      const statesArray = Array.isArray(federalStates) 
        ? federalStates.map(state => state.toLowerCase()) 
        : [federalStates.toLowerCase()];
      
      for (let station of cachedStations.result) {
        if (statesArray.includes(station.federalState?.toLowerCase())) {
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

  // Store in query cache
  queryCache.set(cacheKey, {
    timestamp: Date.now(),
    data: filteredStations
  });
  
  // LRU cache management - remove oldest entries if cache gets too big
  if (queryCache.size > QUERY_CACHE_SIZE) {
    const oldestKey = queryCache.keys().next().value;
    queryCache.delete(oldestKey);
  }
  
  // Log performance data in dev
  if (process.env.NODE_ENV !== 'production') {
    const duration = Date.now() - startTime;
    console.log(`Query completed in ${duration}ms for ${cacheKey}. Found ${Object.keys(filteredStations).length} stations.`);
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