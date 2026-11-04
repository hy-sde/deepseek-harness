/**
 * Curated public API exports for @modelcontextprotocol/core-internal.
 *
 * This module defines the stable, public-facing API surface. Client and server
 * packages re-export from here so that end users only see supported symbols.
 *
 * Internal utilities (stdio parsing, schema helpers, etc.) remain available via the
 * internal barrel (@modelcontextprotocol/core-internal) for use by client/server
 * packages.
 */

// Auth error classes
export { OAuthError, OAuthErrorCode } from '../../auth/errors.ts';

// SDK error types (local errors that never cross the wire)
export type { SdkHttpErrorData } from '../../errors/sdkErrors.ts';
export { SdkError, SdkErrorCode, SdkHttpError } from '../../errors/sdkErrors.ts';

// Auth TypeScript types (NOT Zod schemas like OAuthMetadataSchema)
export type {
    AuthorizationServerMetadata,
    IdJagTokenExchangeResponse,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientRegistrationError,
    OAuthErrorResponse,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    OAuthTokenRevocationRequest,
    OAuthTokens,
    OpenIdProviderDiscoveryMetadata,
    OpenIdProviderMetadata,
    StoredOAuthClientInformation,
    StoredOAuthTokens
} from '../../shared/auth.ts';

// Auth utilities
export { checkResourceAllowed, resourceUrlFromServerUrl } from '../../shared/authUtils.ts';

// Media-type utilities (for transport and framework-adapter authors)
export { isJsonContentType } from '../../shared/mediaType.ts';

// Metadata utilities
export { getDisplayName } from '../../shared/metadataUtils.ts';

// Protocol types and the Protocol base class
export type {
    BaseContext,
    ClientContext,
    NotificationOptions,
    ProgressCallback,
    ProtocolOptions,
    RequestHandlerSchemas,
    RequestOptions,
    RequestStateAccessor,
    ServerContext
} from '../../shared/protocol.ts';
export { DEFAULT_REQUEST_TIMEOUT_MSEC, mergeCapabilities, Protocol } from '../../shared/protocol.ts';

// stdio message framing utilities (for custom transport authors)
export { deserializeMessage, ReadBuffer, serializeMessage, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '../../shared/stdio.ts';

// Transport types (NOT normalizeHeaders)
export type { FetchLike, Transport, TransportSendOptions } from '../../shared/transport.ts';
export { createFetchWithInit } from '../../shared/transport.ts';
export { InMemoryTransport } from '../../util/inMemory.ts';

// URI Template
export type { Variables } from '../../shared/uriTemplate.ts';
export { UriTemplate } from '../../shared/uriTemplate.ts';

// Types — all TypeScript types (standalone interfaces + schema-derived).
// This is the one intentional `export *`: types.ts contains only spec-derived TS
// types, and every type there should be public. See comment in types.ts.
export * from '../../types/types.ts';

// Constants
export {
    BAGGAGE_META_KEY,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    LOG_LEVEL_META_KEY,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION_META_KEY,
    RELATED_TASK_META_KEY,
    SERVER_INFO_META_KEY,
    SUBSCRIPTION_ID_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY
} from '../../types/constants.ts';

// Protocol-era helpers
export type { ProtocolEra } from '../../shared/protocolEras.ts';

// Enums
export { ProtocolErrorCode } from '../../types/enums.ts';

// Error classes
export {
    MissingRequiredClientCapabilityError,
    ProtocolError,
    ResourceNotFoundError,
    UnsupportedProtocolVersionError,
    UrlElicitationRequiredError
} from '../../types/errors.ts';

// Type guards and message parsing
export {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    isCallToolResult,
    isInitializedNotification,
    isInitializeRequest,
    isInputRequiredResult,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResponse,
    isJSONRPCResultResponse,
    isTaskAugmentedRequestParams,
    parseJSONRPCMessage
} from '../../types/guards.ts';

// Validator types and classes
export type { SpecTypeName, SpecTypes } from '../../types/specTypeSchema.ts';
export { isSpecType, specTypeSchemas } from '../../types/specTypeSchema.ts';
export type { StandardSchemaV1, StandardSchemaV1Sync, StandardSchemaWithJSON } from '../../util/standardSchema.ts';
// Validator provider classes stay subpath-only. Re-exporting them here, even as
// `type`, can make generated root declarations advertise runtime-shaped root
// exports that the package root does not provide.
// fromJsonSchema is intentionally NOT exported here — the server and client packages
// provide runtime-aware wrappers that default to the appropriate validator via _shims.
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '../../validators/types.ts';
