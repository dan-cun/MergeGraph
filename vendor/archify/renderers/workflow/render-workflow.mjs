import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiagramWithBrandMarks, writeDiagram } from '../shared/cli.mjs';
import { throwDiagnosticError } from '../shared/diagnostics.mjs';
import { compileWorkflow } from './workflow-compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Compile a validated Archify workflow document without reading process.argv
 * or writing files. The caller owns HTML templating and persistence.
 */
export function renderWorkflow(workflow, { sourceEvidence = null, qualityProfile } = {}) {
  const compiled = compileWorkflow({
    workflow,
    qualityProfile: qualityProfile || workflow.meta?.quality_profile || 'standard',
    sourceEvidence,
  });
  if (!compiled.ok) {
    throwDiagnosticError(compiled.error || 'Workflow compilation failed.', compiled.diagnostics);
  }
  return {
    diagramType: 'workflow',
    meta: workflow.meta,
    svg: compiled.svg,
    cards: workflow.cards,
    sourceEvidence,
    receipt: compiled.receipt,
  };
}

// Preserve the upstream standalone CLI behavior when this file itself is
// executed. MergeGraph imports renderWorkflow directly and never enters this
// block.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { diagram: workflow, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks({
    rendererDir: __dirname,
    diagramType: 'workflow',
    defaultExample: 'agent-tool-call.workflow.json'
  });
  const compiled = renderWorkflow(workflow, { sourceEvidence, qualityProfile: process.env.ARCHIFY_QUALITY_PROFILE });
  if (process.argv.includes('--layout-json')) {
    process.stdout.write(`${JSON.stringify(compiled.receipt, null, 2)}\n`);
  } else {
    writeDiagram({ ...compiled, outPath, template });
  }
}
