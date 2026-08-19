#!/usr/bin/env node
/**
 * Compatibility entry point for the historical shim test name.
 * MMClaude's provider-specific coverage lives in test-mmclaude.mjs.
 */
await import('./test-mmclaude.mjs');
