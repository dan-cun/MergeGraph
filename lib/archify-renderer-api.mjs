/**
 * Pure in-process façade over the vendored Archify renderers.
 *
 * Each renderer accepts an already validated Archify document and returns the
 * render payload (SVG, metadata and cards). It does not read process.argv,
 * access the filesystem, or publish an artifact. MergeGraph owns validation,
 * HTML templating, persistence and receipts around this API.
 */
import { validateCrossCollectionContracts } from '../vendor/archify/renderers/shared/cli.mjs';
import { validateEngineeringProfile } from '../vendor/archify/renderers/shared/engineering-profiles.mjs';
import { validateSchema } from '../vendor/archify/renderers/shared/validator.mjs';
import { renderArchitecture } from '../vendor/archify/renderers/architecture/render-architecture.mjs';
import { renderDataflow } from '../vendor/archify/renderers/dataflow/render-dataflow.mjs';
import { renderLifecycle } from '../vendor/archify/renderers/lifecycle/render-lifecycle.mjs';
import { renderSequence } from '../vendor/archify/renderers/sequence/render-sequence.mjs';
import { renderWorkflow } from '../vendor/archify/renderers/workflow/render-workflow.mjs';

export const ARCHIFY_RENDERERS = Object.freeze({
  architecture: renderArchitecture,
  workflow: renderWorkflow,
  sequence: renderSequence,
  dataflow: renderDataflow,
  lifecycle: renderLifecycle,
});

export function validateArchifyDocument(archifyType, document) {
  const renderer = ARCHIFY_RENDERERS[archifyType];
  if (!renderer) throw new Error(`Unsupported Archify diagram type: ${archifyType}`);
  validateSchema(archifyType, document);
  validateCrossCollectionContracts(archifyType, document);
  validateEngineeringProfile(archifyType, document);
  return { ok: true, archifyType };
}

/**
 * Render one typed Archify document in-process.
 *
 * The returned object is intentionally renderer-level data. It can be passed
 * to Archify's `applyTemplate` helper by a host that needs a standalone HTML
 * artifact, or embedded directly as SVG in the MergeGraph whiteboard.
 */
export function renderArchifyDocument(archifyType, document, options = {}) {
  const { validate = true, ...renderOptions } = options;
  if (validate) validateArchifyDocument(archifyType, document);
  return ARCHIFY_RENDERERS[archifyType](document, renderOptions);
}

export {
  renderArchitecture,
  renderDataflow,
  renderLifecycle,
  renderSequence,
  renderWorkflow,
};
