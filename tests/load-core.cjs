// Loads the real public/core.js (the file the browser runs) for the tests, so
// the tests can never drift from it. core.js is a plain browser script that
// fills module.exports when there is one.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'public', 'core.js');
const wrapped = vm.runInThisContext('(function (module) {' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
const holder = { exports: {} };
wrapped(holder);
module.exports = holder.exports;
