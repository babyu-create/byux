const fs = require('node:fs/promises')

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function abortError() {
  return Object.assign(new Error('書き出しが中止されました'), {
    code: 'ECANCELED',
  })
}

function throwIfAborted(options) {
  if (options.shouldAbort?.()) throw abortError()
}

async function renameWithRetry(source, target, options = {}) {
  const rename = options.rename ?? fs.rename
  const attempts = options.attempts ?? 40
  const delayMs = options.delayMs ?? 250
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(options)
    try {
      await rename(source, target)
      return
    } catch (error) {
      lastError = error
      if (
        !TRANSIENT_RENAME_CODES.has(error?.code) ||
        attempt + 1 >= attempts
      ) {
        throw error
      }
      throwIfAborted(options)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      throwIfAborted(options)
    }
  }
  throw lastError
}

async function syncFileForCommit(filePath, options = {}) {
  const open = options.open ?? fs.open
  const attempts = options.attempts ?? 12
  const delayMs = options.delayMs ?? 250
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(options)
    let handle
    let primaryError
    try {
      handle = await open(filePath, 'r+')
      await handle.sync()
    } catch (error) {
      primaryError = error
      lastError = error
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch (closeError) {
          if (!primaryError) throw closeError
        }
      }
    }
    if (!primaryError) return
    if (
      !TRANSIENT_RENAME_CODES.has(primaryError?.code) ||
      attempt + 1 >= attempts
    ) {
      throw primaryError
    }
    throwIfAborted(options)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    throwIfAborted(options)
  }
  throw lastError
}

module.exports = { renameWithRetry, syncFileForCommit }
