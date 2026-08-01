const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  await Promise.all([
    fs.rm(path.join(context.appOutDir, 'resources', 'default_app.asar'), { force: true }),
    fs.rm(path.join(context.appOutDir, 'version'), { force: true }),
  ])
}
