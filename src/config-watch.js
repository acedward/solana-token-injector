'use strict';
// Hot reload of config.json (US4, FR-108). Polls the file's stat (robust to
// editors that save by rename); on a change it reloads after a short settle
// delay. `load()` either returns the new config or throws; on a throw the
// caller keeps the previous config.

const fs = require('fs');

function watchConfig(configPath, { load, onReload, onError, intervalMs = 250, settleMs = 100 }) {
  let timer = null;
  const listener = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      let cfg;
      try {
        cfg = load();
      } catch (err) {
        onError(err);
        return;
      }
      onReload(cfg);
    }, settleMs);
  };
  fs.watchFile(configPath, { interval: intervalMs, persistent: false }, listener);
  return function stop() {
    fs.unwatchFile(configPath, listener);
    if (timer) clearTimeout(timer);
  };
}

module.exports = { watchConfig };
