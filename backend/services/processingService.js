'use strict';
const { isUniqueViolation } = require('../database/db');
const { AppError, conflict } = require('../utils/errors');
const { now, outputPrefix, touch } = require('./documents');

const STALE_AFTER_MS_FLOOR = 10 * 60 * 1000;

/**
 * Orchestrates the multi-stage pipeline by calling the CV service stage by stage:
 *   geometry (detect/perspective/orientation/deskew) -> enhancement (DSP) -> OCR
 * The job row records the CURRENT STAGE after each step, so the browser (which polls /status) shows real progress.
 */
class ProcessingService {
  constructor({ db, cv, config, logger = console }) {
    this.db = db;
    this.cv = cv;
    this.config = config;
    this.log = logger;
    this.sweeper = null;
  }

  /** Mark jobs that were running when the server stopped as failed, then start the periodic stale-job sweep. */
  start() {
    this.recoverInterrupted();
    this.sweeper = setInterval(() => this.sweepStale(), 60_000);
    this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  recoverInterrupted() {
    const ts = now();
    this.db.tx(() => {
      this.db.run("UPDATE processing_jobs SET status = 'failed', error_message = 'Processing was interrupted by a server restart. Run it again.', completed_at = ? WHERE status IN ('queued','running')", ts);
      this.db.run("UPDATE documents SET processing_status = CASE WHEN enhanced_image_path IS NOT NULL THEN 'processed' ELSE 'failed' END WHERE processing_status = 'processing'");
    });
  }

  sweepStale() {
    const limit = Math.max(this.config.cvTimeoutMs * 3 + 60_000, STALE_AFTER_MS_FLOOR);
    const cutoff = new Date(Date.now() - limit).toISOString();
    try {
      const stale = this.db.all("SELECT id, document_id FROM processing_jobs WHERE status IN ('queued','running') AND created_at < ?", cutoff);
      for (const job of stale) {
        this._finishFailed(job.id, job.document_id, 'Processing took too long and was cancelled.', null);
      }
    } catch { /* database closing */ }
  }

  _createJob(doc, kind, settings, stage) {
    try {
      const res = this.db.run(
        "INSERT INTO processing_jobs (document_id, kind, processing_settings, status, stage, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
        doc.id, kind, JSON.stringify(settings), stage, now(),
      );
      return res.lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('This document is already being processed. Wait for it to finish.', 'already_processing');
      throw err;
    }
  }

  /**
   * options: { settings:{preset,params}, geometry:{...}, scope:'full'|'enhance', run_ocr:boolean, psm:number }
   * Returns the new job id immediately; work continues in the background.
   */
  startProcess(doc, options) {
    const scope = options.scope === 'enhance' && doc.corrected_image_path ? 'enhance' : 'full';
    const jobId = this.db.tx(() => {
      const id = this._createJob(doc, 'process', { ...options, scope }, scope === 'full' ? 'geometry' : 'enhancement');
      touch(this.db, doc.id, { processing_status: 'processing' });
      return id;
    });
    setImmediate(() => {
      this._runProcess(jobId, doc, { ...options, scope }).catch((err) => this.log.error('[processing] unexpected failure', err));
    });
    return jobId;
  }

  startOcr(doc, options) {
    const jobId = this.db.tx(() => {
      const id = this._createJob(doc, 'ocr', options, 'ocr');
      touch(this.db, doc.id, { processing_status: 'processing' });
      return id;
    });
    setImmediate(() => {
      this._runOcr(jobId, doc, options).catch((err) => this.log.error('[ocr] unexpected failure', err));
    });
    return jobId;
  }

  _setJob(jobId, fields) {
    const cols = Object.keys(fields);
    this.db.run(`UPDATE processing_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), jobId);
  }

  _finishFailed(jobId, docId, message, timings, { revertToProcessed = false } = {}) {
    const ts = now();
    this.db.tx(() => {
      this._setJob(jobId, { status: 'failed', error_message: message, completed_at: ts, stage_timings: timings ? JSON.stringify(timings) : null });
      const doc = this.db.one('SELECT enhanced_image_path FROM documents WHERE id = ?', docId);
      if (doc) touch(this.db, docId, { processing_status: revertToProcessed && doc.enhanced_image_path ? 'processed' : 'failed' });
    });
  }

  _userMessage(err) {
    return err instanceof AppError ? err.message : 'Processing failed unexpectedly. Please try again.';
  }

  async _runProcess(jobId, doc, options) {
    const started = Date.now();
    const timings = {};
    const prefix = outputPrefix(doc);
    try {
      this._setJob(jobId, { status: 'running' });
      let correctedKey = doc.corrected_image_path;

      if (options.scope === 'full') {
        this._setJob(jobId, { stage: 'geometry' });
        const t = Date.now();
        const g = options.geometry;
        const res = await this.cv.geometry({
          storage_key: doc.original_image_path,
          output_prefix: prefix,
          corners: g.corners,
          auto_detect: g.auto_detect,
          auto_orient: g.auto_orient,
          auto_deskew: g.auto_deskew,
          manual_rotation: g.manual_rotation,
          manual_angle: g.manual_angle,
        });
        timings.geometry_ms = Date.now() - t;
        correctedKey = res.corrected_key;
        touch(this.db, doc.id, {
          corrected_image_path: correctedKey,
          corners_json: JSON.stringify(res.report.corners),
          geometry_json: JSON.stringify({ options: { ...g, corners: g.corners ? 'manual' : null }, report: res.report }),
        });
      }

      this._setJob(jobId, { stage: 'enhancement', stage_timings: JSON.stringify(timings) });
      let t = Date.now();
      const enh = await this.cv.enhance({ storage_key: correctedKey, output_prefix: prefix, settings: options.settings });
      timings.enhancement_ms = Date.now() - t;
      touch(this.db, doc.id, {
        enhanced_image_path: enh.enhanced_key,
        enhancement_json: JSON.stringify({ preset: enh.preset, resolved_params: enh.resolved_params, analysis: enh.analysis, report: enh.report }),
      });

      if (options.run_ocr) {
        this._setJob(jobId, { stage: 'ocr', stage_timings: JSON.stringify(timings) });
        t = Date.now();
        const ocr = await this.cv.ocr({ storage_key: enh.enhanced_key, mode: doc.document_type, psm: options.psm });
        timings.ocr_ms = Date.now() - t;
        this.saveOcrResult(doc, ocr);
      }

      const ts = now();
      this.db.tx(() => {
        this._setJob(jobId, { status: 'completed', stage: 'done', stage_timings: JSON.stringify(timings), processing_time_ms: Date.now() - started, completed_at: ts });
        touch(this.db, doc.id, { processing_status: 'processed' });
      });
    } catch (err) {
      this._finishFailed(jobId, doc.id, this._userMessage(err), timings);
    }
  }

  async _runOcr(jobId, doc, options) {
    const started = Date.now();
    const timings = {};
    try {
      this._setJob(jobId, { status: 'running', stage: 'ocr' });
      const t = Date.now();
      const ocr = await this.cv.ocr({ storage_key: doc.enhanced_image_path, mode: doc.document_type, psm: options.psm });
      timings.ocr_ms = Date.now() - t;
      this.saveOcrResult(doc, ocr);
      const ts = now();
      this.db.tx(() => {
        this._setJob(jobId, { status: 'completed', stage: 'done', stage_timings: JSON.stringify(timings), processing_time_ms: Date.now() - started, completed_at: ts });
        touch(this.db, doc.id, { processing_status: 'processed' });
      });
    } catch (err) {
      this._finishFailed(jobId, doc.id, this._userMessage(err), timings, { revertToProcessed: true });
    }
  }

  /** Persist a CV /v1/ocr payload: original + (reset) corrected text, word boxes, confidence and form fields. */
  saveOcrResult(doc, ocr) {
    const form = ocr.form || null;
    const meta = {
      mode: doc.document_type,
      psm: ocr.psm,
      lang: ocr.lang,
      image_width: ocr.image_width,
      image_height: ocr.image_height,
      confidence: ocr.confidence,
      warnings: ocr.warnings || [],
      empty: Boolean(ocr.empty),
      duration_ms: ocr.duration_ms,
    };
    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO ocr_results (document_id, original_extracted_text, corrected_text, confidence_score, bounding_boxes_json, structured_fields_json, ocr_meta_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           original_extracted_text = excluded.original_extracted_text,
           corrected_text = excluded.corrected_text,
           confidence_score = excluded.confidence_score,
           bounding_boxes_json = excluded.bounding_boxes_json,
           structured_fields_json = excluded.structured_fields_json,
           ocr_meta_json = excluded.ocr_meta_json,
           updated_at = excluded.updated_at`,
        doc.id, ocr.text || '', ocr.text || '', ocr.confidence ? ocr.confidence.mean : null,
        JSON.stringify(ocr.words || []), form ? JSON.stringify(form) : null, JSON.stringify(meta), ts,
      );
      touch(this.db, doc.id, { review_status: 'needs_review' });
    });
  }
}

module.exports = { ProcessingService };
