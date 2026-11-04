export * from './auth/errors.ts';
export * from './errors/crossBundleBrand.ts';
export * from './errors/sdkErrors.ts';
export * from './shared/auth.ts';
export * from './shared/authUtils.ts';
export * from './shared/clientCapabilityRequirements.ts';
export * from './shared/envelope.ts';
export * from './shared/inboundClassification.ts';
export * from './shared/inputRequired.ts';
export * from './shared/inputRequiredDriver.ts';
export * from './shared/inputRequiredEngine.ts';
export * from './shared/mcpParamHeaders.ts';
export * from './shared/mediaType.ts';
export * from './shared/metadataUtils.ts';
export * from './shared/protocol.ts';
export * from './shared/protocolEras.ts';
export * from './shared/resultCacheHints.ts';
export * from './shared/stdio.ts';
export * from './shared/toolNameValidation.ts';
export * from './shared/transport.ts';
export * from './shared/uriTemplate.ts';
export * from './types/index.ts';
export * from './util/inMemory.ts';
// Wire-codec internals: the version→codec resolver the sibling packages need
// (era state itself lives on Protocol and is written through the
// package-internal write hook exported by shared/protocol.ts), plus the
// internal modern-revision literal so sibling packages can name the era a
// 2026-only seam runs in. NOTHING per-revision (registries, codec objects,
// per-revision schemas) is ever exported on this barrel — sibling packages
// reach the wire layer ONLY through `codecForVersion`'s function-only
// `WireCodec` surface. Sole exemption: the shared result-family ruling
// (`wire/resultFamilies.ts`), era-independent by design — the server's
// authoring normalization and the e2e wire sniffer apply the same ruling
// (and name the same vocabulary) as the 2025 wire seam.
export * from './util/schema.ts';
export * from './util/standardSchema.ts';
export * from './util/zodCompat.ts';
export { codecForVersion, MODERN_WIRE_REVISION } from './wire/codec.ts';
// Revision-neutral warm-up entry for the lazy wire-schema layers. Exposes no
// per-revision objects — it only forces the memos every consumer already
// pulls through — so it stays within the no-per-revision-exports rule above.
// Re-exported as public API by the client and server packages for platforms
// that bill request CPU but not module evaluation.
export { preloadSchemas } from './wire/preload.ts';
export { normalizeContentlessToolResult, TOOL_RESULT_FOREIGN_FAMILY_KEYS } from './wire/resultFamilies.ts';

// Validator provider classes stay subpath-only. Re-exporting them here, even as
// `type`, can make generated client/server root declarations advertise
// runtime-shaped root exports that the package root does not provide.
export * from './validators/fromJsonSchema.ts';
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types.ts';
