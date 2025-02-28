const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// Load environment variables from .env file in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const port = process.env.PORT || 3000;

// Function to recursively load endpoints from directories
function loadEndpointsRecursively(basePath, currentPath = '') {
  const fullPath = path.join(basePath, currentPath);
  
  fs.readdirSync(fullPath).forEach((item) => {
    const itemPath = path.join(fullPath, item);
    const stats = fs.statSync(itemPath);
    
    if (stats.isDirectory()) {
      // Recursively process subdirectory
      loadEndpointsRecursively(basePath, path.join(currentPath, item));
    } else if (stats.isFile() && path.extname(item) === '.js') {
      // Load the route module
      const endpoint = require(itemPath);
      
      // Create route path: /currentPath/filename (without extension)
      let routePath = currentPath ? 
        `/${currentPath}/${path.basename(item, path.extname(item))}` : 
        `/${path.basename(item, path.extname(item))}`;
      
      // Normalize slashes and handle special case for index files
      routePath = routePath.replace(/\\/g, '/');
      if (routePath.endsWith('/index')) {
        routePath = routePath.substring(0, routePath.length - 6) || '/';
      }
      
      console.log(`Registering route: ${routePath}`);
      app.use(routePath, endpoint);
    }
  });
}

// Start loading endpoints
const endpointsPath = path.join(__dirname, 'endpoints');
loadEndpointsRecursively(endpointsPath);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});