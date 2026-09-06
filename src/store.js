const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ accounts: [], codes: [], audit: [] }, null, 2));
    }
  }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return { accounts: [], codes: [], audit: [] }; }
  }
  write(state) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
  update(fn) {
    const state = this.read();
    const next = fn(state) || state;
    this.write(next);
    return next;
  }
}

module.exports = { JsonStore };
