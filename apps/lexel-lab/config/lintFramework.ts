// Re-exports only the non-UI lint-framework primitives used by Lexel Lab so
// Vite never pulls Harper's SuggestionBox (and its FontAwesome runtime) into
// the Lab bundle, while keeping vendor/harper completely unmodified.
export * from '../../../vendor/harper/packages/lint-framework/src/lint/Box';
export { default as computeLintBoxes } from '../../../vendor/harper/packages/lint-framework/src/lint/computeLintBoxes/index';
export * from '../../../vendor/harper/packages/lint-framework/src/lint/domUtils';
export * from '../../../vendor/harper/packages/lint-framework/src/lint/editorUtils';
export { default as Highlights } from '../../../vendor/harper/packages/lint-framework/src/lint/Highlights';
export * from '../../../vendor/harper/packages/lint-framework/src/lint/lintKindColor';
export { default as RenderBox } from '../../../vendor/harper/packages/lint-framework/src/lint/RenderBox';
export * from '../../../vendor/harper/packages/lint-framework/src/lint/unpackLint';
export { default as unpackLint } from '../../../vendor/harper/packages/lint-framework/src/lint/unpackLint';
