// verb -> skill(ctx, args). Verbs of catalog.json missing here fail with cause `invalid` ("not implemented").
'use strict'
module.exports = Object.assign({},
  require('./movement'), require('./gather'), require('./craft'), require('./combat'), require('./inventory'), require('./social'),
  { achieve: (ctx, a) => require('../plan/live').achieve(ctx, a) })
for (const k of ['SCAFFOLD', 'useOnMob', 'missingFor']) delete module.exports[k]
