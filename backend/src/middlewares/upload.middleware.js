const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

const uploadRoot = path.resolve(process.cwd(), env.upload.dir);
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadRoot),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(ApiError.badRequest('فرمت فایل مجاز نیست (فقط تصویر)'));
  }
  cb(null, true);
}

const multerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.upload.maxMb * 1024 * 1024 },
});

// ─── Content verification (magic bytes) ─────────────────────────────────
// The multer fileFilter above only checks the client-supplied `mimetype`
// header, which a malicious client can freely spoof (e.g. rename a script
// to "image.png" and send Content-Type: image/png). Once the file is on
// disk, we read its real first bytes and confirm they match one of the
// four allowed image formats' actual binary signature. A mismatch here
// means the declared type was spoofed, and the file is rejected + deleted.
const MAGIC_BYTE_SIGNATURES = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // Classic GIF signatures: "GIF87a" or "GIF89a" — checking "GIF8" covers both.
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
};

function matchesSignature(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, i) => buffer[i] === byte);
}

function isValidImageContent(buffer, mimetype) {
  if (mimetype === 'image/webp') {
    // WEBP: "RIFF" .... "WEBP" — a 4-byte size field sits between the two markers.
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  const signatures = MAGIC_BYTE_SIGNATURES[mimetype];
  if (!signatures) return false;
  return signatures.some((sig) => matchesSignature(buffer, sig));
}

function readHeaderBytes(filePath, length = 12) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function collectFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

function cleanupFiles(files) {
  files.forEach((file) => {
    fs.unlink(file.path, () => {
      // Best-effort cleanup; nothing actionable if this fails (e.g. file
      // already gone), so we deliberately swallow the error here.
    });
  });
}

/**
 * Runs after multer has written the file(s) to disk. Verifies the real
 * file content matches the declared (and already MIME-allowlisted) type;
 * on mismatch, deletes every file from this request and rejects with 400.
 */
function verifyUploadedFileContent(req, res, next) {
  const files = collectFiles(req);
  if (files.length === 0) return next();

  try {
    for (const file of files) {
      const header = readHeaderBytes(file.path);
      if (!isValidImageContent(header, file.mimetype)) {
        cleanupFiles(files);
        return next(ApiError.badRequest('محتوای فایل ارسالی با نوع تصویر اعلام‌شده مطابقت ندارد'));
      }
    }
    next();
  } catch (err) {
    cleanupFiles(files);
    next(err);
  }
}

// Same public surface as the raw multer instance (`.single` / `.fields`),
// but each returns [multerMiddleware, verifyUploadedFileContent] instead of
// just the multer middleware. Express flattens nested middleware arrays
// passed to router methods, so every existing call site (upload.single(...),
// upload.fields(...)) keeps working unchanged while gaining the extra
// content-verification step automatically.
const upload = {
  single: (fieldName) => [multerUpload.single(fieldName), verifyUploadedFileContent],
  fields: (fieldsConfig) => [multerUpload.fields(fieldsConfig), verifyUploadedFileContent],
};

module.exports = upload;
