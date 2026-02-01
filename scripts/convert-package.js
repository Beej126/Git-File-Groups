const fs = require('fs');

const content = fs.readFileSync('package.jsonc', 'utf8');
// remove block comments and line comments
let clean = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
// remove trailing commas before } or ]
clean = clean.replace(/,\s*([}\]])/g, '$1');

try {
    const parsed = JSON.parse(clean);
    fs.writeFileSync('package.json', JSON.stringify(parsed, null, 2) + '\n');
} catch (err) {
    // fallback: write cleaned text preserving line breaks (no aggressive whitespace collapse)
    fs.writeFileSync('package.json', clean.trim() + '\n');
    console.error('convert-package.js: failed to parse JSONC — wrote cleaned fallback. Error:', err.message);
}
