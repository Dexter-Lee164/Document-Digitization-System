'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { loadConfig } = require('./config');
const { Db } = require('./database/db');
const { Storage } = require('./utils/storage');
const { ProcessingSchema } = require('./utils/processingSchema');
const { CvClient } = require('./services/cvClient');
const { ProcessingService } = require('./services/processingService');
const { SqliteSessionStore } = require('./services/sessionStore');
const { securityHeaders, noStore } = require('./middleware/security');
const { csrfProtection } = require('./middleware/csrf');
const { optionalUser } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

const { createAuthController } = require('./controllers/authController');
const { createDocumentsController } = require('./controllers/documentsController');
const { createProcessingController } = require('./controllers/processingController');
const { createOcrController } = require('./controllers/ocrController');
const { createExportsController } = require('./controllers/exportsController');
const { createExperimentsController } = require('./controllers/experimentsController');
const { createSettingsController } = require('./controllers/settingsController');
const { createPagesController } = require('./controllers/pagesController');
const { createSystemController } = require('./controllers/systemController');

const { authRoutes } = require('./routes/auth');
const { pageRoutes } = require('./routes/pages');
const { apiRoutes } = require('./routes/api');

/**
 * Application factory. The server and the automated tests both use it.
 * `overrides`: { env, config } for loadConfig, plus optional `cv` (a stand-in CV client) and `logger`.
 * Returns { app, ctx, close }.
 */
function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = overrides.logger || console;

  const db = new Db(config.databasePath).init();
  const storage = new Storage(config.storagePath).ensure();
  const schema = new ProcessingSchema(config.schemaPath);
  const cv = overrides.cv || new CvClient({
    baseUrl: config.cvServiceUrl,
    token: config.cvServiceToken,
    timeoutMs: config.cvTimeoutMs,
    experimentTimeoutMs: config.experimentTimeoutMs,
  });
  const processing = new ProcessingService({ db, cv, config, logger });
  const store = new SqliteSessionStore(db, { ttlMs: config.sessionTtlMs });

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.frontendDir, 'views'));
  app.set('etag', false);

  app.use(securityHeaders(config));

  // Static assets (no session needed). User documents are NOT here - they live in the private storage folder and are
  // streamed only through the authenticated /api/documents/:id/* routes.
  const maxAge = config.isProd ? '1h' : 0;
  app.use('/static', express.static(path.join(config.frontendDir, 'public'), { maxAge, index: false, dotfiles: 'ignore' }));
  app.use('/vendor/bootstrap', express.static(path.join(config.root, 'node_modules', 'bootstrap', 'dist'), { maxAge, index: false }));
  app.use('/vendor/bootstrap-icons', express.static(path.join(config.root, 'node_modules', 'bootstrap-icons', 'font'), { maxAge, index: false }));

  app.get('/healthz', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ status: 'ok' }); });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(session({
    name: 'dv.sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionTtlMs, path: '/' },
  }));
  app.use(noStore);
  app.use(csrfProtection());
  app.use(optionalUser(db));

  const ctx = { config, db, storage, schema, cv, processing, store, logger };

  const authController = createAuthController({ db, config });
  const pages = createPagesController({ db, config });
  const c = {
    system: createSystemController({ db, config, cv, storage }),
    documents: createDocumentsController({ db, config, storage, cv }),
    processing: createProcessingController({ db, schema, processing }),
    ocr: createOcrController({ db, schema, processing }),
    exports: createExportsController({ db, storage, cv }),
    experiments: createExperimentsController({ db, schema, cv }),
    settings: createSettingsController({ db, config }),
  };

  app.use('/auth', authRoutes({ authController }));
  app.use('/api', apiRoutes({ db, config, c }));
  app.use('/', pageRoutes({ db, pages }));

  app.use(notFoundHandler);
  app.use(errorHandler(config, logger));

  processing.start();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    processing.stop();
    store.close();
    db.close();
  };
  return { app, ctx, close };
}

module.exports = { createApp };
