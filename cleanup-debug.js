import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the cart-modal.jsx file
const filePath = join(__dirname, 'app', 'routes', 'cart-modal.jsx');
let content = readFileSync(filePath, 'utf8');

// Replace all console.log('GWP Debug: ...) with debugLog('...')
content = content.replace(/console\.log\('GWP Debug: (.*?)'\)/g, "debugLog('$1')");
content = content.replace(/console\.log\('GWP Debug: (.*?)',\s*(.*?)\)/g, "debugLog('$1', $2)");

// Replace console.error('GWP Debug: ...) with errorLog('...')
content = content.replace(/console\.error\('GWP Debug: (.*?)'\)/g, "errorLog('$1')");
content = content.replace(/console\.error\('GWP Debug: (.*?)',\s*(.*?)\)/g, "errorLog('$1', $2)");

// Write the changes back to the file
writeFileSync(filePath, content, 'utf8'); 