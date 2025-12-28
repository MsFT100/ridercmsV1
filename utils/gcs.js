const { Storage } = require('@google-cloud/storage');
const path = require('path');
const logger = require('./logger');

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;

if (!GCS_BUCKET_NAME) {
  logger.warn('GCS_BUCKET_NAME environment variable not set. File uploads will be disabled.');
}

const storage = new Storage();
const bucket = GCS_BUCKET_NAME ? storage.bucket(GCS_BUCKET_NAME) : null;

/**
 * Uploads a file buffer to Google Cloud Storage.
 *
 * @param {Buffer} buffer The file buffer to upload.
 * @param {string} originalname The original name of the file.
 * @param {string} destinationFolder The folder within the bucket to upload to (e.g., 'profile-pictures').
 * @returns {Promise<string>} A promise that resolves with the public URL of the uploaded file.
 */
const uploadToGcs = (buffer, originalname, destinationFolder) => {
  if (!bucket) {
    return Promise.reject(new Error('Google Cloud Storage bucket is not configured.'));
  }

  return new Promise((resolve, reject) => {
    // Create a unique filename to avoid overwrites
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const extension = path.extname(originalname);
    const filename = `${path.basename(originalname, extension)}-${uniqueSuffix}${extension}`;
    const destination = `${destinationFolder}/${filename}`;

    const file = bucket.file(destination);

    const stream = file.createWriteStream({
      resumable: false,
      metadata: {
        // You can add custom metadata here if needed
        // cacheControl: 'public, max-age=31536000',
      },
    });

    stream.on('error', (err) => {
      logger.error(`GCS upload error for ${destination}:`, err);
      reject(err);
    });

    stream.on('finish', () => {
      // Make the file public. For more granular control, you can use signed URLs.
      file.makePublic().then(() => {
        const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${destination}`;
        logger.info(`Successfully uploaded ${filename} to GCS. Public URL: ${publicUrl}`);
        resolve(publicUrl);
      }).catch(reject);
    });

    stream.end(buffer);
  });
};

module.exports = { uploadToGcs, bucket };