import type { Model, Api, ProviderHeaders, TranscriptContext, StreamOptions, SimpleStreamOptions, AssistantMessageEventStream, ProviderStreams } from "../types.ts";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

function withSessionHeader<T extends { headers?: ProviderHeaders; sessionId?: string }>(
	options: T | undefined,
): T | undefined {
	if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return options;
	return {
		...options,
		headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: options.sessionId },
	};
}

/** Adds OpenCode's required per-conversation routing header before API dispatch. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream {
			return streams.stream(model, context, withSessionHeader(options));
		},
		streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
			return streams.streamSimple(model, context, withSessionHeader(options));
		},
	};
}
