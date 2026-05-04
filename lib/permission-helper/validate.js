// validate.js — Permission-change spec validator.
//
// Validates the spec format documented in the tech design at
// /shared/projects/access-control/artifacts/permission-change-helper-tech-design.md
//
// Hand-rolled (no ajv) because the schema is fixed and small. ~150 lines.

'use strict';

const ALLOWED_OPS = new Set(['share', 'unshare', 'transfer_ownership']);
const ALLOWED_ROLES = new Set(['Reader', 'Commenter', 'Writer']);
const ALLOWED_MODES = new Set(['fail_soft', 'all_or_nothing']);
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SPEC_VERSION = '1.0';

/**
 * Validate a permission-change spec.
 * @param {*} spec  Parsed JSON spec.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validate(spec) {
  const errors = [];

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['Spec must be a JSON object.'] };
  }

  // version
  if (spec.version !== SPEC_VERSION) {
    errors.push(`spec.version must be "${SPEC_VERSION}" (got: ${JSON.stringify(spec.version)})`);
  }

  // operations
  if (!Array.isArray(spec.operations)) {
    errors.push('spec.operations must be an array.');
  } else if (spec.operations.length === 0) {
    errors.push('spec.operations must be non-empty.');
  } else {
    spec.operations.forEach((op, i) => validateOperation(op, i, errors));
    // No more than one transfer_ownership per spec.
    const transferCount = spec.operations.filter(o => o && o.op === 'transfer_ownership').length;
    if (transferCount > 1) {
      errors.push(`spec.operations: at most one transfer_ownership per spec (got: ${transferCount}).`);
    }
    // Cannot transfer ownership to the requestor (would be a no-op or worse).
    const requestor = spec.context && spec.context.requestor;
    spec.operations.forEach((op, i) => {
      if (op && op.op === 'transfer_ownership' && op.recipient === requestor) {
        errors.push(`spec.operations[${i}]: cannot transfer ownership to the requestor.`);
      }
    });
  }

  // context
  if (spec.context === null || typeof spec.context !== 'object' || Array.isArray(spec.context)) {
    errors.push('spec.context must be a JSON object.');
  } else {
    if (typeof spec.context.requestor !== 'string' || spec.context.requestor.length === 0) {
      errors.push('spec.context.requestor must be a non-empty string (member_hash).');
    }
    if (typeof spec.context.purpose !== 'string' || spec.context.purpose.length === 0) {
      errors.push('spec.context.purpose must be a non-empty string.');
    }
    if (spec.context.calling_task !== undefined && typeof spec.context.calling_task !== 'string') {
      errors.push('spec.context.calling_task must be a string if present.');
    }
  }

  // mode (optional, defaults fail_soft)
  if (spec.mode !== undefined && !ALLOWED_MODES.has(spec.mode)) {
    errors.push(`spec.mode, if present, must be one of: ${[...ALLOWED_MODES].join(', ')} (got: ${JSON.stringify(spec.mode)})`);
  }

  return { ok: errors.length === 0, errors };
}

function validateOperation(op, i, errors) {
  const prefix = `spec.operations[${i}]`;

  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    errors.push(`${prefix} must be a JSON object.`);
    return;
  }

  if (!ALLOWED_OPS.has(op.op)) {
    errors.push(`${prefix}.op must be one of: ${[...ALLOWED_OPS].join(', ')} (got: ${JSON.stringify(op.op)})`);
  }

  if (typeof op.resource !== 'string' || !op.resource.startsWith('/')) {
    errors.push(`${prefix}.resource must be a string starting with "/" (got: ${JSON.stringify(op.resource)})`);
  }

  // recipient is required for share, unshare, transfer_ownership.
  if (typeof op.recipient !== 'string' || !EMAIL_REGEX.test(op.recipient)) {
    errors.push(`${prefix}.recipient must be a valid email address (got: ${JSON.stringify(op.recipient)})`);
  }

  // role is required for share only.
  if (op.op === 'share') {
    if (!ALLOWED_ROLES.has(op.role)) {
      errors.push(`${prefix}.role for share ops must be one of: ${[...ALLOWED_ROLES].join(', ')} (got: ${JSON.stringify(op.role)})`);
    }
  } else if (op.role !== undefined) {
    // Allowed but unused for non-share ops. Don't error — just informational.
  }

  // before is optional. If present, must have a recipients array.
  if (op.before !== undefined) {
    if (op.before === null || typeof op.before !== 'object') {
      errors.push(`${prefix}.before, if present, must be a JSON object.`);
    } else if (!Array.isArray(op.before.recipients)) {
      errors.push(`${prefix}.before.recipients must be an array if before is present.`);
    } else {
      op.before.recipients.forEach((r, j) => {
        if (!r || typeof r !== 'object' || typeof r.email !== 'string' || typeof r.role !== 'string') {
          errors.push(`${prefix}.before.recipients[${j}] must have string email and role.`);
        }
      });
    }
  }

  // excluded is optional, set by the page on submit.
  if (op.excluded !== undefined && typeof op.excluded !== 'boolean') {
    errors.push(`${prefix}.excluded, if present, must be a boolean.`);
  }
}

/**
 * Filter out operations marked excluded: true.
 * Returns a fresh spec with the included operations only.
 */
function applyExclusions(spec) {
  return {
    ...spec,
    operations: spec.operations.filter(op => !op.excluded),
  };
}

module.exports = { validate, applyExclusions, SPEC_VERSION };
