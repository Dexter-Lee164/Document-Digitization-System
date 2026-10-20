'use strict';

/** Error whose message is safe to show to the user. Everything else becomes a generic 500. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details, code = 'invalid_request') => new AppError(400, code, message, details);
const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'unauthorized', message);
const forbidden = (message = 'You are not allowed to do that.', code = 'forbidden') => new AppError(403, code, message);
const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
const conflict = (message, code = 'conflict') => new AppError(409, code, message);
const tooMany = (message = 'Too many attempts. Please wait a few minutes and try again.') => new AppError(429, 'rate_limited', message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
