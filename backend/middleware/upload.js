'use strict';
const multer = require('multer');
const { AppError, badRequest } = require('../utils/errors');

/** Single image upload kept in memory (validated, then written to private storage by the controller). */
function singleImageUpload(config) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadSize, files: 1, fields: 8, fieldSize: 4 * 1024, parts: 12 },
  }).single('file');

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(413, 'file_too_large', `The image is larger than the ${(config.maxUploadSize / (1024 * 1024)).toFixed(0)} MB upload limit.`));
        }
        return next(badRequest('The upload was rejected. Send exactly one image in the "file" field.', undefined, 'invalid_upload'));
      }
      return next(err);
    });
  };
}

module.exports = { singleImageUpload };
