const multer = require('multer');
const { uploadToGcs } = require('../utils/gcs');

// Configure multer to use memory storage. This passes the file as a buffer to the next middleware.
const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // Limit file size to 5MB
  },
});

/**
 * Middleware to handle a single file upload and stream it to GCS.
 * The public URL of the uploaded file will be attached to `req.file.gcsUrl`.
 * @param {string} fieldName The name of the form field for the file (e.g., 'profileImage').
 * @param {string} destinationFolder The GCS folder to upload into (e.g., 'profile-pictures').
 */
const uploadToGcsMiddleware = (fieldName, destinationFolder) => (req, res, next) => {
  upload.single(fieldName)(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return next(); // No file was uploaded

    const { buffer, originalname } = req.file;
    req.file.gcsUrl = await uploadToGcs(buffer, originalname, destinationFolder);
    next();
  });
};

module.exports = uploadToGcsMiddleware;