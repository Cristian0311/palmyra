import fs from 'fs';
const inventory = fs.readFileSync('src/pages/Inventory.tsx', 'utf8');
console.log(inventory.match(/branches\[0\]\?\.id/g));
