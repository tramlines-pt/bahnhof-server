const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();


// Load environment variables from .env file in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const port = process.env.PORT || 3000;

// Dynamically load all endpoints
const endpointsPath = path.join(__dirname, 'endpoints');
fs.readdirSync(endpointsPath).forEach((file) => {
  if (path.extname(file) === '.js') {
    const endpoint = require(path.join(endpointsPath, file));
    const route = `/${path.basename(file, path.extname(file))}`;
    app.use(route, endpoint);
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});