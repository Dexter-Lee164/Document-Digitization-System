'use strict';
const fs = require('node:fs');
const { badRequest } = require('./errors');

/**
 * Validates processing requests against shared/processing_schema.json - the SAME file the Python service loads - so
 * both sides always agree on parameter names, types and ranges.
 */
class ProcessingSchema {
  constructor(file) {
    this.schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  get presets() { return Object.keys(this.schema.presets); }

  defaults() {
    const out = {};
    for (const [k, spec] of Object.entries(this.schema.parameters)) out[k] = spec.default;
    return out;
  }

  /** Public description for the UI (presets + parameter specs). */
  describe() {
    return {
      version: this.schema.version,
      parameters: this.schema.parameters,
      presets: Object.fromEntries(Object.entries(this.schema.presets).map(([name, p]) => [name, {
        label: p.label,
        description: p.description,
        adaptive: p.adaptive,
        params: { ...this.defaults(), ...(name === 'custom' ? this.schema.presets.document_scan.params : {}), ...p.params },
      }])),
      geometry: this.schema.geometry,
      ocr: this.schema.ocr,
    };
  }

  _validateValue(name, spec, value) {
    switch (spec.type) {
      case 'bool':
        if (typeof value !== 'boolean') throw badRequest(`'${name}' must be true or false.`, { field: name });
        return value;
      case 'enum':
        if (!spec.values.includes(value)) throw badRequest(`'${name}' must be one of: ${spec.values.join(', ')}.`, { field: name });
        return value;
      case 'int':
      case 'float': {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`'${name}' must be a number.`, { field: name });
        if (spec.type === 'int' && !Number.isInteger(value)) throw badRequest(`'${name}' must be a whole number.`, { field: name });
        if (value < spec.min || value > spec.max) throw badRequest(`'${name}' must be between ${spec.min} and ${spec.max}.`, { field: name });
        if (spec.type === 'int' && spec.odd && value % 2 === 0) return value + 1 <= spec.max ? value + 1 : value - 1;
        return value;
      }
      default:
        throw badRequest(`Unsupported parameter '${name}'.`);
    }
  }

  /** Returns { preset, params } ready to send to the CV service. Custom parameters are only kept for the custom preset. */
  validateSettings(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const preset = raw.preset === undefined ? 'automatic' : raw.preset;
    if (!this.presets.includes(preset)) throw badRequest(`Unknown preset '${preset}'.`, { field: 'preset' });
    const params = {};
    if (preset === 'custom' && raw.params !== undefined) {
      if (typeof raw.params !== 'object' || raw.params === null || Array.isArray(raw.params)) throw badRequest("'params' must be an object.", { field: 'params' });
      for (const [k, v] of Object.entries(raw.params)) {
        const spec = this.schema.parameters[k];
        if (!spec) throw badRequest(`Unknown processing parameter '${k}'.`, { field: k });
        params[k] = this._validateValue(k, spec, v);
      }
    }
    return { preset, params };
  }

  /** Geometry options: auto flags, manual rotation, fine angle and optional manual corners. */
  validateGeometry(input, imageSize) {
    const raw = input && typeof input === 'object' ? input : {};
    const flag = (name, fallback) => {
      if (raw[name] === undefined) return fallback;
      if (typeof raw[name] !== 'boolean') throw badRequest(`'${name}' must be true or false.`, { field: name });
      return raw[name];
    };
    const geo = this.schema.geometry;
    const manualRotation = raw.manual_rotation === undefined ? 0 : raw.manual_rotation;
    if (!geo.manual_rotation.values.includes(manualRotation)) throw badRequest('manual_rotation must be 0, 90, 180 or 270.', { field: 'manual_rotation' });
    const manualAngle = raw.manual_angle === undefined ? 0 : raw.manual_angle;
    if (typeof manualAngle !== 'number' || !Number.isFinite(manualAngle) || manualAngle < geo.manual_angle.min || manualAngle > geo.manual_angle.max) {
      throw badRequest(`manual_angle must be a number between ${geo.manual_angle.min} and ${geo.manual_angle.max}.`, { field: 'manual_angle' });
    }
    let corners = null;
    if (raw.corners !== undefined && raw.corners !== null) {
      corners = this.validateCorners(raw.corners, imageSize);
    }
    return {
      auto_detect: flag('auto_detect', true),
      auto_orient: flag('auto_orient', true),
      auto_deskew: flag('auto_deskew', true),
      manual_rotation: manualRotation,
      manual_angle: manualAngle,
      corners,
    };
  }

  validateCorners(value, imageSize) {
    if (!Array.isArray(value) || value.length !== 4) throw badRequest('Exactly four corner points are required.', { field: 'corners' });
    const out = value.map((p) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw badRequest('Each corner must be an [x, y] pair of numbers.', { field: 'corners' });
      }
      return [p[0], p[1]];
    });
    if (imageSize && imageSize.width && imageSize.height) {
      const tolX = imageSize.width * 0.02;
      const tolY = imageSize.height * 0.02;
      for (const [x, y] of out) {
        if (x < -tolX || x > imageSize.width + tolX || y < -tolY || y > imageSize.height + tolY) {
          throw badRequest('One or more corners lie outside the image.', { field: 'corners' });
        }
      }
    }
    return out;
  }

  validatePsm(value, mode) {
    const spec = this.schema.ocr.psm;
    if (value === undefined || value === null) return mode === 'form' ? spec.default_form : spec.default_general;
    if (!spec.values.includes(value)) throw badRequest(`psm must be one of ${spec.values.join(', ')}.`, { field: 'psm' });
    return value;
  }
}

module.exports = { ProcessingSchema };
