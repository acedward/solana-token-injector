'use strict';
// Writes the fake decryptor's map file atomically (temp + rename), so the
// fake never reads a half-written file.

const fs = require('fs');
const path = require('path');

const FAKE_DECRYPTOR = path.join(__dirname, '..', 'fixtures', 'fake-decryptor.js');

function createFakeMap(file, initial = {}) {
  let map = { ...initial };
  const write = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, file);
  };
  write();
  return {
    file,
    get: () => map,
    set(key, value) {
      map = { ...map, [key]: value };
      write();
    },
    replace(next) {
      map = { ...next };
      write();
    },
  };
}

module.exports = { createFakeMap, FAKE_DECRYPTOR };
