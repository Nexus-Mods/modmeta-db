require('ts-node/register');
let { ModDB, serveREST } = require('./index.ts');

ModDB.create('mods', 'skyrimse', [])
  .then(db => serveREST(db));
