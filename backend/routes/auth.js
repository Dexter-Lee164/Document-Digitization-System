'use strict';
const express = require('express');

function authRoutes({ authController }) {
  const router = express.Router();
  router.get('/csrf', authController.csrf);
  router.post('/register', authController.register);
  router.post('/login', authController.login);
  router.post('/logout', authController.logout);
  return router;
}

module.exports = { authRoutes };
