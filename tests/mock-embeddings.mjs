// Deterministic model double, loaded only by test subprocesses. Never accesses model caches/network.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@huggingface/transformers') return { url: 'data:text/javascript,' + encodeURIComponent(`
    export const env = {};
    export async function pipeline() { return async (text) => ({data: new Float32Array([1, 0])}); }
  `), shortCircuit: true };
  return next(specifier, context);
} });
