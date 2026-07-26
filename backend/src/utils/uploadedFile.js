const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const logger = require('./logger');

const uploadRoot = path.resolve(process.cwd(), env.upload.dir);

/**
 * Deletes a previously-uploaded local file, given the public URL stored in
 * the DB (e.g. "/uploads/169..-abc.png"), the same shape produced by
 * upload.middleware. Used to clean up orphaned files when a slide's image
 * is replaced or the slide itself is deleted.
 *
 * - No-ops for anything that isn't a local "/uploads/..." path — external
 *   URLs (e.g. a seed's placehold.co link, or an admin-provided CDN URL)
 *   are never touched.
 * - `path.basename` strips any directory segments defensively, and the
 *   resolved path is re-checked against `uploadRoot` so a crafted value
 *   like "/uploads/../../.env" can never escape the uploads directory.
 * - Never throws: a missing/already-deleted file (or any other fs error)
 *   must not fail the calling request — it's logged and swallowed.
 */
function deleteLocalUpload(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const filename = path.basename(url);
  const filePath = path.join(uploadRoot, filename);
  if (!filePath.startsWith(uploadRoot)) return;

  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.error(`Failed to delete uploaded file ${filePath}: ${err.message}`);
    }
  });
}

module.exports = { deleteLocalUpload };
