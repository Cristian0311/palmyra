const fs = require('fs');
const store = fs.readFileSync('src/store/useStore.ts', 'utf8');
const transfers = fs.readFileSync('src/pages/Transfers.tsx', 'utf8');

console.log("Transfers uses branchId:", transfers.includes('formData.fromBranchId'));
console.log("Transfers uses variantLabel check:", transfers.match(/i\.variantLabel \|\| ''/g));

