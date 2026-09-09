import { Sha256 } from "@aws-crypto/sha256-js";
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  DescribeLogGroupsCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  context,
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Attributes,
  type Span,
  type SpanContext,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BasicTracerProvider, BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { fetch as undiciFetch } from "undici";
import { CONCIERGE_RUNTIME_NAME } from "./runtime-name";

// Observability (issue #24 / ADR-0008, revised): AgentCore does not
// auto-emit OTEL spans for a Runtime-hosted agent (confirmed empirically —
// see ADR-0007's Revision — zero X-Ray traces existed for this account
// despite Transaction Search being ACTIVE), and the AWS Node ADOT distro
// (`@aws/aws-distro-opentelemetry-node-autoinstrumentation`) only exposes a
// `require()`-patching auto-instrument entry point with no importable API —
// useless here since the Concierge's bundle is ESM (`bedrock-agentcore` is
// ESM-only), and ESM's own module graph never goes through `require()` for
// auto-instrumentation to patch. This hand-rolls the minimum real pipeline
// instead: a BasicTracerProvider with the X-Ray-compatible id generator,
// exporting via a small SigV4-signed exporter straight to X-Ray's OTLP
// endpoint (https://xray.<region>.amazonaws.com/v1/traces) — the same
// endpoint/auth AWS's own OTEL Collector config for CloudWatch uses.
const SERVICE_NAME = "wayfarer-concierge";

// AgentCore Evaluations' SESSION-level LLM-as-a-judge rejects spans outright
// ("SessionValidationException: ... no spans with supported scope") unless
// their instrumentation-library scope name matches one of a fixed allow-list
// of known agent frameworks — confirmed live (issue #23): the real Evaluate
// call for wayfarer_itinerary_quality failed until the tracer's own name
// changed to this. This repo's own hand-rolled span shape
// (gen_ai.tool.call.arguments/gen_ai.tool.call.result, gen_ai.input.messages/
// gen_ai.output.messages) already matches what this scope's own spans carry
// (docs.aws.amazon.com/bedrock-agentcore .../supported-frameworks-langgraph),
// which is why this is the compatibility label used rather than any other
// allow-listed name — not a claim that this Concierge actually runs LangChain.
const INSTRUMENTATION_SCOPE_NAME = "opentelemetry.instrumentation.langchain";

let tracingStarted = false;
// Only ever read once tracingStarted is true (startTracing sets both
// together) - a placeholder default keeps the type plain `string` rather
// than `string | undefined`, since it's never actually used unset: every
// event-record path below is itself guarded by tracingStarted.
let cloudWatchLogsRegion = "";

// AgentCore's Evaluations LLM-judge reads a session in one of two telemetry
// "delivery modes" (docs.aws.amazon.com/bedrock-agentcore/.../supported-
// frameworks-telemetry.html) — confirmed live (issue #23, ADR-0007's
// Revision 3): this account/Runtime defaults to SPLIT telemetry (setting
// UNIFIED_TRACES_DESTINATION_ENABLED=true didn't change it — that flag only
// takes effect when the platform recognizes the sender as a real ADOT SDK
// build, which this hand-rolled tracer isn't). Split telemetry expects the
// large payload attributes (gen_ai.task.input/output,
// gen_ai.tool.call.arguments/result, gen_ai.input.messages/output.messages)
// pulled OFF the span and delivered as a separate "event record" — same
// traceId/spanId, content in `body` — to the otel-rt-logs stream in the
// Runtime's own CloudWatch log group. Without one, the judge rejects the
// span's trace with LogEventMissingException. This is that second pipeline.
const EVENT_RECORD_LOG_STREAM = "otel-rt-logs";

let cachedLogsClient: CloudWatchLogsClient | undefined;
function logsClient(): CloudWatchLogsClient {
  if (!cachedLogsClient) {
    cachedLogsClient = new CloudWatchLogsClient({ region: cloudWatchLogsRegion });
  }
  return cachedLogsClient;
}

// Memoized: the Runtime's own log group name
// (/aws/bedrock-agentcore/runtimes/<agentRuntimeId>-DEFAULT) isn't knowable
// at CDK synth time — referencing the Runtime's own generated agentRuntimeId
// from a policy or environment variable on that same Runtime resource is a
// circular CloudFormation dependency (Runtime -> Role/EnvVars -> Runtime) —
// so this discovers it once per process by prefix-searching on the fixed,
// known Runtime name instead.
let logGroupNamePromise: Promise<string> | undefined;
function discoverLogGroupName(): Promise<string> {
  if (!logGroupNamePromise) {
    logGroupNamePromise = logsClient()
      .send(new DescribeLogGroupsCommand({ logGroupNamePrefix: `/aws/bedrock-agentcore/runtimes/${CONCIERGE_RUNTIME_NAME}` }))
      .then((response) => {
        // A Runtime replacement (a future deploy that changes something CDK
        // can't update in place) leaves its old log group behind - AWS
        // never deletes it - so more than one group can match this prefix.
        // The most recently created one is the live Runtime's; DescribeLogGroups
        // makes no ordering guarantee on its own, so this sorts explicitly
        // rather than trusting index 0.
        const newest = [...(response.logGroups ?? [])].sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0))[0];
        if (!newest?.logGroupName) {
          throw new Error(`no CloudWatch log group found with prefix /aws/bedrock-agentcore/runtimes/${CONCIERGE_RUNTIME_NAME}`);
        }
        return newest.logGroupName;
      });
    // A failed discovery must not poison the cache — the next span's event
    // record should try discovering again, not permanently reuse a
    // rejected Promise.
    logGroupNamePromise.catch(() => {
      logGroupNamePromise = undefined;
    });
  }
  return logGroupNamePromise;
}

// Memoized per log group: CreateLogStream is idempotent in effect (a
// pre-existing stream just means "already ensured") but not in the API
// itself, so a concurrent second call must not also attempt creation.
const ensuredLogStreams = new Set<string>();
async function ensureLogStream(logGroupName: string): Promise<void> {
  if (ensuredLogStreams.has(logGroupName)) {
    return;
  }
  try {
    await logsClient().send(new CreateLogStreamCommand({ logGroupName, logStreamName: EVENT_RECORD_LOG_STREAM }));
  } catch (error) {
    if (!(error instanceof ResourceAlreadyExistsException)) {
      throw error;
    }
  }
  ensuredLogStreams.add(logGroupName);
}

type EventRecordBody = { readonly input?: unknown; readonly output?: unknown };

// Repackages the same content this repo's spans already carry as
// attributes (issue #24) into the parts-format `body.input.messages`/
// `body.output.messages` shape split telemetry's event records use
// (docs.aws.amazon.com/bedrock-agentcore/.../supported-frameworks-
// langgraph.html's split-telemetry examples) - undefined for span kinds
// (Memory's get_last_k_turns/create_event/RetrieveMemoryRecords) the judge
// never asks for a companion event record for.
function buildEventRecordBody(attributes: Attributes): EventRecordBody | undefined {
  switch (attributes["gen_ai.operation.name"]) {
    case "invoke_agent":
      return {
        input: { messages: [{ role: "user", content: attributes["gen_ai.task.input"] }] },
        output:
          attributes["gen_ai.task.output"] === undefined
            ? undefined
            : { messages: [{ role: "assistant", content: attributes["gen_ai.task.output"] }] },
      };
    case "chat":
      return {
        input: { messages: parseJsonMessages(attributes["gen_ai.input.messages"]) },
        output: { messages: parseJsonMessages(attributes["gen_ai.output.messages"]) },
      };
    case "execute_tool":
      return {
        input: { messages: [{ content: attributes["gen_ai.tool.call.arguments"] }] },
        output: {
          messages: [{ role: "tool", name: attributes["gen_ai.tool.name"], content: attributes["gen_ai.tool.call.result"] }],
        },
      };
    default:
      return undefined;
  }
}

function parseJsonMessages(value: unknown): unknown {
  if (typeof value !== "string") {
    return [];
  }
  try {
    return JSON.parse(value);
  } catch {
    return [{ content: value }];
  }
}

// Best-effort: a failed event-record delivery must never break the
// Caller-facing response this span is wrapping around - swallowed silently,
// the same treatment the Traces exporter above already gives a failed
// export (its resultCallback({code: FAILED}) has no registered diag logger
// to surface through either). Every adapter's own acceptance test imports
// infra/handler.ts directly, running this same startTracing() for real
// against test credentials with no CloudWatch Logs network-boundary mock -
// logging here would be test noise, not a signal anyone acts on.
async function emitEventRecord(spanContext: SpanContext, body: EventRecordBody): Promise<void> {
  try {
    const logGroupName = await discoverLogGroupName();
    await ensureLogStream(logGroupName);
    await logsClient().send(
      new PutLogEventsCommand({
        logGroupName,
        logStreamName: EVENT_RECORD_LOG_STREAM,
        logEvents: [
          {
            timestamp: Date.now(),
            message: JSON.stringify({
              spanId: spanContext.spanId,
              traceId: spanContext.traceId,
              scope: { name: INSTRUMENTATION_SCOPE_NAME },
              body,
            }),
          },
        ],
      }),
    );
  } catch {
    // Best-effort only - see comment above.
  }
}

// The exporter needs a signable, binary (protobuf) POST — createSigV4Fetch
// (sigv4-fetch.ts) only forwards a `string` body, so this signs directly
// with the same @smithy primitives rather than stretching that helper to a
// second, binary-body use case it wasn't written for.
function createSigV4XRayExporter(region: string): SpanExporter {
  const endpoint = new URL(`https://xray.${region}.amazonaws.com/v1/traces`);
  const signer = new SignatureV4({ service: "xray", region, credentials: defaultProvider(), sha256: Sha256 });

  return {
    async export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
      try {
        const body = ProtobufTraceSerializer.serializeRequest(spans);
        const request = new HttpRequest({
          method: "POST",
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          path: endpoint.pathname,
          headers: { host: endpoint.hostname, "content-type": "application/x-protobuf" },
          body,
        });
        const signed = await signer.sign(request);
        const response = await undiciFetch(endpoint, {
          method: signed.method,
          headers: signed.headers,
          body: signed.body as Uint8Array,
        });
        if (!response.ok) {
          resultCallback({ code: ExportResultCode.FAILED, error: new Error(`X-Ray OTLP export failed: ${response.status} ${await response.text()}`) });
          return;
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      } catch (error) {
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
      }
    },
    async shutdown(): Promise<void> {},
  };
}

// Called once at module load (infra/handler.ts), before any span is
// created — registers the global context manager (async_hooks-based, so a
// span started in one async function is still the "active" parent when a
// later `await`ed call starts its own child span) and the tracer provider.
export function startTracing(region: string): void {
  if (tracingStarted) {
    return;
  }
  tracingStarted = true;
  cloudWatchLogsRegion = region;

  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const provider = new BasicTracerProvider({
    idGenerator: new AWSXRayIdGenerator(),
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor(createSigV4XRayExporter(region))],
  });
  trace.setGlobalTracerProvider(provider);
}

// trace.getTracer() is safe to call whether or not startTracing() has run —
// the OTEL API returns a working no-op tracer until a real provider is
// registered. That's deliberate here: every adapter's unit test constructs
// it directly (never through infra/handler.ts, the only place that calls
// startTracing()), so withSpan() must stay a harmless no-op in that context
// rather than requiring every test file to boot a tracer first.
function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_SCOPE_NAME);
}

// The LangChain instrumentation scope tags every span with a
// "traceloop.span.kind" (Traceloop's own vocabulary that scope reuses) —
// confirmed live (issue #23): AgentCore Evaluations' LLM-judge rejected our
// spans with "no spans to evaluate... have model/tool/agent invocation
// details for the provided scope" until this was added, even after the
// scope name itself was accepted. Derived from gen_ai.operation.name rather
// than threaded through every withSpan() call site.
function traceloopSpanKind(attributes: Attributes): string {
  switch (attributes["gen_ai.operation.name"]) {
    case "invoke_agent":
      return "workflow";
    case "chat":
      return "llm";
    case "execute_tool":
      return "tool";
    default:
      return "task";
  }
}

// Every instrumented adapter method in this codebase returns a
// Result<TValue, TError> (domain/result.ts) rather than throwing for an
// expected failure (a GatewayError, a MemoryError, ...) - withSpan must
// recognize that shape itself, or every one of those adapters' real
// failures (a Policy denial, a downed Gateway, ConsentRequired) would mark
// its span OK just because the wrapped async function didn't throw.
function isErrResult(value: unknown): value is { readonly ok: false; readonly error: unknown } {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false;
}

// Mirrors every span.setAttribute(...) call - both withSpan's own initial
// ones and any a caller makes on the `span` it receives (e.g. handler.ts
// setting gen_ai.task.output once the reply is known) - into `sink`, so
// withSpan can build this span's split-telemetry event record (issue #23)
// from the complete attribute set once `fn` resolves, not just the
// attributes known before it ran. Every other Span method passes straight
// through to the real span unchanged.
function trackAttributes(span: Span, sink: Attributes): Span {
  return new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === "setAttribute") {
        return (key: string, value: AttributeValue) => {
          sink[key] = value;
          return target.setAttribute(key, value);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The one seam every instrumented primitive touchpoint uses (issue #24):
// starts `name` as a child of whatever span is active on the current async
// context, sets `attributes`, runs `fn`, records success/failure, and always
// ends the span - callers never manage a Span's lifecycle themselves.
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    const collectedAttributes: Attributes = { ...attributes, "traceloop.span.kind": traceloopSpanKind(attributes) };
    span.setAttributes(collectedAttributes);
    const trackedSpan = trackAttributes(span, collectedAttributes);
    try {
      const result = await fn(trackedSpan);
      if (isErrResult(result)) {
        const message = JSON.stringify(result.error);
        span.setAttribute("error.type", (result.error as { type?: string })?.type ?? "unknown");
        span.setStatus({ code: SpanStatusCode.ERROR, message });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      // In `finally`, not just the try block's success path - a thrown
      // exception (e.g. Bedrock throttling inside a "chat" span) must still
      // get its event record, or that span reproduces the exact
      // LogEventMissingException this pipeline exists to prevent. Fire-and-
      // forget (not awaited): emitEventRecord is already best-effort and
      // silent on failure, so nothing depends on its completion, and
      // awaiting it here would add a CloudWatch Logs round trip to every
      // content-bearing span's Caller-facing response latency for no
      // correctness benefit.
      //
      // tracingStarted also guards this: every adapter's unit test builds
      // it directly, without startTracing() ever running, and the no-op
      // tracer OTEL's API hands back still executes `fn` (spec-compliant
      // no-op behavior) - without this guard, tests would try to construct
      // a real CloudWatchLogsClient and reach out over the network.
      if (tracingStarted) {
        const eventRecordBody = buildEventRecordBody(collectedAttributes);
        if (eventRecordBody) {
          void emitEventRecord(span.spanContext(), eventRecordBody);
        }
      }
      span.end();
    }
  });
}

// Identity's consent-flow spans (issue #24) redact OAuth token/secret
// values while keeping flow state like "pending"/"approved" visible - the
// one genuine credential in this trace, per ADR-0008. Budget figures and
// preference facts are deliberately NOT run through this anywhere else.
const REDACTED = "[REDACTED]";
export function redactTokenValue(value: string | undefined): string {
  return value ? REDACTED : "(none)";
}
