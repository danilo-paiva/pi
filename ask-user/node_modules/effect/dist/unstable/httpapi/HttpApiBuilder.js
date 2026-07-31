import * as Context from "../../Context.js";
import * as Effect from "../../Effect.js";
import * as Encoding from "../../Encoding.js";
import * as Fiber from "../../Fiber.js";
import { identity } from "../../Function.js";
import { stringOrRedacted } from "../../internal/redacted.js";
import * as Layer from "../../Layer.js";
import * as Option from "../../Option.js";
import { pipeArguments } from "../../Pipeable.js";
import { hasProperty } from "../../Predicate.js";
import * as Redacted from "../../Redacted.js";
import * as Result from "../../Result.js";
import * as Schema from "../../Schema.js";
import * as SchemaAST from "../../SchemaAST.js";
import * as SchemaIssue from "../../SchemaIssue.js";
import * as SchemaTransformation from "../../SchemaTransformation.js";
import * as Scope from "../../Scope.js";
import * as Stream from "../../Stream.js";
import * as UndefinedOr from "../../UndefinedOr.js";
import * as Sse from "../encoding/Sse.js";
import * as HttpEffect from "../http/HttpEffect.js";
import * as HttpMethod from "../http/HttpMethod.js";
import * as HttpRouter from "../http/HttpRouter.js";
import * as Request from "../http/HttpServerRequest.js";
import { HttpServerRequest } from "../http/HttpServerRequest.js";
import * as Response from "../http/HttpServerResponse.js";
import * as Multipart from "../http/Multipart.js";
import * as UrlParams from "../http/UrlParams.js";
import * as HttpApiEndpoint from "./HttpApiEndpoint.js";
import { HttpApiSchemaError } from "./HttpApiError.js";
import * as HttpApiMiddleware from "./HttpApiMiddleware.js";
import * as HttpApiSchema from "./HttpApiSchema.js";
import * as MediaType from "./internal/mediaType.js";
import * as OpenApi from "./OpenApi.js";
/**
 * Registers an `HttpApi` with a `HttpRouter`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = (api, options) => HttpRouter.use(Effect.fnUntraced(function* (router) {
  const services = yield* Effect.context();
  const routes = [];
  const availableGroups = Array.from(services.mapUnsafe.keys()).filter(key => key.startsWith("effect/httpapi/HttpApiGroup/"));
  const groups = Object.values(api.groups);
  for (const group of groups) {
    const groupRoutes = services.mapUnsafe.get(group.key)?.routes;
    if (groupRoutes === undefined) {
      const available = availableGroups.length === 0 ? "none" : availableGroups.join(", ");
      return yield* Effect.die(`HttpApiGroup "${group.identifier}" not found (key: "${group.key}"). Did you forget to provide HttpApiBuilder.group(api, "${group.identifier}", ...)? Available groups: ${available}`);
    }
    routes.push(...groupRoutes);
  }
  yield* router.addAll(routes);
  if (options?.openapiPath) {
    const spec = OpenApi.fromApi(api);
    yield* router.add("GET", options.openapiPath, Effect.succeed(Response.jsonUnsafe(spec)));
  }
}));
/**
 * Create a `Layer` that implements all endpoints in an `HttpApi` group.
 *
 * **Details**
 *
 * The `build` function receives an unimplemented `Handlers` instance that can
 * be used to add handlers to the group. Implement endpoints with
 * `handlers.handle`.
 *
 * @category handlers
 * @since 4.0.0
 */
export const group = (api, groupIdentifier, build) => Layer.effectContext(Effect.gen(function* () {
  const services = (yield* Effect.context()).pipe(Context.omit(Scope.Scope));
  const group = api.groups[groupIdentifier];
  const result = build(makeHandlers(group));
  const handlers = Effect.isEffect(result) ? yield* result : result;
  const routes = [];
  for (const item of handlers.handlers.values()) {
    routes.push(handlerToRoute(group, item, services));
  }
  return Context.makeUnsafe(new Map([[group.key, {
    routes,
    handlers: handlers.handlers
  }]]));
}));
const HandlersTypeId = "~effect/httpapi/HttpApiBuilder/Handlers";
/**
 * Builds the server-side HTTP effect for a single endpoint in an API group using
 * the endpoint metadata, middleware, codecs, and supplied handler.
 *
 * @category handlers
 * @since 4.0.0
 */
export const endpoint = (api, groupIdentifier, endpointIdentifier, handler) => Effect.contextWith(context => {
  const group = api.groups[groupIdentifier];
  const endpoint = group.endpoints[endpointIdentifier];
  return Effect.succeed(handlerToHttpEffect(group, endpoint, Context.omit(Scope.Scope)(context), handler, false));
});
/**
 * Decodes credentials for an HTTP API security scheme from the current request,
 * supporting bearer, API key, and basic authentication inputs.
 *
 * @category security
 * @since 4.0.0
 */
export const securityDecode = self => {
  switch (self._tag) {
    case "Http":
      {
        return Effect.map(HttpServerRequest, request => Redacted.make(getAuthorizationCredential(request.headers.authorization, self.scheme) ?? ""));
      }
    case "ApiKey":
      {
        const key = self.in === "header" ? self.key.toLowerCase() : self.key;
        const schema = Schema.Struct({
          [key]: Schema.String
        });
        const decode = self.in === "query" ? Request.schemaSearchParams(schema) : self.in === "cookie" ? Request.schemaCookies(schema) : Request.schemaHeaders(schema);
        return Effect.match(decode, {
          onFailure: () => Redacted.make(""),
          onSuccess: match => Redacted.make(match[key])
        });
      }
    case "Basic":
      {
        const empty = {
          username: "",
          password: Redacted.make("")
        };
        return Effect.map(HttpServerRequest, request => {
          const encoded = getAuthorizationCredential(request.headers.authorization, basicScheme);
          if (encoded === undefined) return empty;
          const decoded = Result.getOrUndefined(Encoding.decodeBase64String(encoded));
          if (decoded === undefined) return empty;
          // RFC 7617, Section 2: only the first colon separates the user-id from the password.
          // https://www.rfc-editor.org/rfc/rfc7617.html#section-2
          const separator = decoded.indexOf(":");
          if (separator === -1) return empty;
          return {
            username: decoded.slice(0, separator),
            password: Redacted.make(decoded.slice(separator + 1))
          };
        });
      }
  }
};
/**
 * Registers a pre-response handler that sets an API-key cookie on the outgoing
 * response, defaulting the cookie to `secure` and `httpOnly` unless overridden.
 *
 * @category security
 * @since 4.0.0
 */
export const securitySetCookie = (self, value, options) => HttpEffect.appendPreResponseHandler((_req, response) => Effect.orDie(Response.setCookie(response, self.key, stringOrRedacted(value), {
  secure: true,
  httpOnly: true,
  ...options
})));
// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------
const basicScheme = "Basic";
function getAuthorizationCredential(authorization, scheme) {
  const schemeLength = scheme.length;
  // RFC 9110, Section 11.1: schemes are case-insensitive and credentials follow 1*SP.
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-11.1
  if (authorization === undefined || authorization.length <= schemeLength || authorization.charCodeAt(schemeLength) !== 32 || authorization.slice(0, schemeLength).toLowerCase() !== scheme.toLowerCase()) {
    return undefined;
  }
  let credentialStart = schemeLength + 1;
  while (authorization.charCodeAt(credentialStart) === 32) {
    credentialStart++;
  }
  return credentialStart === authorization.length ? undefined : authorization.slice(credentialStart);
}
const registerHandler = (self, identifier, handler, isRaw, options) => {
  if (!Object.hasOwn(self.group.endpoints, identifier)) {
    throw new Error(`HttpApiEndpoint "${identifier}" not found in HttpApiGroup "${self.group.identifier}"`);
  }
  if (self.handlers.has(identifier)) {
    throw new Error(`Handler for HttpApiEndpoint "${identifier}" is already registered in HttpApiGroup "${self.group.identifier}"`);
  }
  const endpoint = self.group.endpoints[identifier];
  self.handlers.set(identifier, {
    endpoint,
    handler,
    isRaw,
    uninterruptible: options?.uninterruptible ?? false
  });
  return self;
};
const HandlersProto = {
  [HandlersTypeId]: HandlersTypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
  handle(identifier, handler, options) {
    return registerHandler(this, identifier, handler, false, options);
  },
  handleAll(handlers) {
    for (const [identifier, entry] of Object.entries(handlers)) {
      const handler = typeof entry === "function" ? entry : entry.handler;
      const options = typeof entry === "function" ? undefined : entry.options;
      registerHandler(this, identifier, handler, false, options);
    }
    return this;
  },
  handleRaw(identifier, handler, options) {
    return registerHandler(this, identifier, handler, true, options);
  }
};
const makeHandlers = group => {
  const self = Object.create(HandlersProto);
  self.group = group;
  self.handlers = new Map();
  return self;
};
function buildPayloadDecoders(payloadMap) {
  const result = new Map();
  payloadMap.forEach(({
    encoding,
    schemas
  }, contentType) => {
    const decode = Schema.decodeUnknownEffect(Schema.Union(schemas));
    if (encoding._tag === "Multipart") {
      result.set(contentType, {
        _tag: "Multipart",
        mode: encoding.mode,
        limits: encoding.limits,
        decode
      });
    } else {
      result.set(contentType, {
        _tag: encoding._tag,
        decode,
        nullOnEmpty: schemas.some(s => SchemaAST.isNull(SchemaAST.toEncoded(s.ast)))
      });
    }
  });
  return result;
}
function decodePayload(payloadBy, httpRequest, query) {
  const hasBody = HttpMethod.hasBody(httpRequest.method);
  const contentType = hasBody ? MediaType.normalize(httpRequest.headers["content-type"] ?? "application/json") : "application/x-www-form-urlencoded";
  const existing = payloadBy.get(contentType);
  if (!existing) {
    return Response.text(`Unsupported content-type: ${contentType}`, {
      status: 415
    });
  }
  const {
    _tag,
    decode
  } = existing;
  switch (_tag) {
    case "Multipart":
      {
        if (existing.mode === "buffered") {
          let eff = Effect.orDie(httpRequest.multipart);
          if (existing.limits) {
            eff = Effect.provideContext(eff, Multipart.limitsServices(existing.limits));
          }
          return Effect.flatMap(eff, decode);
        }
        return Effect.succeed(existing.limits ? Stream.provideContext(httpRequest.multipartStream, Multipart.limitsServices(existing.limits)) : httpRequest.multipartStream);
      }
    case "Json":
      return Effect.flatMap(Effect.orDie(httpRequest.text), text => {
        if (text === "") {
          return decode(existing.nullOnEmpty ? null : undefined);
        }
        try {
          return decode(JSON.parse(text));
        } catch (cause) {
          return Effect.fail(new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some(text), {
            message: `Invalid JSON: ${cause}`
          })));
        }
      });
    case "Text":
      return Effect.flatMap(Effect.orDie(httpRequest.text), decode);
    case "FormUrlEncoded":
      {
        const source = hasBody ? Effect.map(Effect.orDie(httpRequest.urlParamsBody), UrlParams.toRecord) : Effect.succeed(query);
        return Effect.flatMap(source, decode);
      }
    case "Uint8Array":
      return Effect.flatMap(Effect.map(Effect.orDie(httpRequest.arrayBuffer), buffer => new Uint8Array(buffer)), decode);
  }
}
function handlerToHttpEffect(group, endpoint, context, handler, isRaw) {
  const encodeSuccess = Schema.encodeUnknownEffect(makeSuccessSchema(endpoint));
  const encodeError = Schema.encodeUnknownEffect(makeErrorSchema(endpoint));
  const decodeParams = UndefinedOr.map(endpoint.params, Schema.decodeUnknownEffect);
  const decodeHeaders = UndefinedOr.map(endpoint.headers, Schema.decodeUnknownEffect);
  const decodeQuery = UndefinedOr.map(endpoint.query, Schema.decodeUnknownEffect);
  const encodeStream = makeStreamEncoder(endpoint);
  const shouldParsePayload = endpoint.payload.size > 0 && !isRaw;
  const payloadBy = shouldParsePayload ? buildPayloadDecoders(endpoint.payload) : undefined;
  return applyMiddleware(group, endpoint, context, Effect.gen(function* () {
    const fiber = Fiber.getCurrent();
    const context = fiber.context;
    const httpRequest = Context.getUnsafe(context, HttpServerRequest);
    const routeContext = Context.getUnsafe(context, HttpRouter.RouteContext);
    const query = Context.getUnsafe(context, Request.ParsedSearchParams);
    const request = {
      request: httpRequest,
      endpoint,
      group
    };
    if (decodeParams) {
      request.params = yield* HttpApiSchemaError.wrap("Params", decodeParams(routeContext.params));
    }
    if (decodeHeaders) {
      request.headers = yield* HttpApiSchemaError.wrap("Headers", decodeHeaders(httpRequest.headers));
    }
    if (decodeQuery) {
      request.query = yield* HttpApiSchemaError.wrap("Query", decodeQuery(query));
    }
    if (payloadBy) {
      const result = decodePayload(payloadBy, httpRequest, query);
      if (Response.isHttpServerResponse(result)) {
        return result;
      }
      if (result !== undefined) {
        request.payload = yield* HttpApiSchemaError.wrap("Payload", result);
      }
    }
    const response = yield* handler(request);
    if (Response.isHttpServerResponse(response)) {
      return response;
    }
    const streamResponse = encodeStream?.(response, context);
    if (streamResponse !== undefined) {
      return yield* HttpApiSchemaError.wrap("Body", streamResponse);
    }
    return yield* HttpApiSchemaError.wrap("Body", encodeSuccess(response));
  })).pipe(Effect.withErrorReporting, Effect.catch(error => {
    if (HttpApiSchemaError.is(error)) return Effect.die(error);
    return Effect.orDie(encodeError(error));
  }), Effect.provideContext(context));
}
/** @internal */
export function handlerToRoute(group, handler, context) {
  const endpoint = handler.endpoint;
  return HttpRouter.route(endpoint.method, endpoint.path, handlerToHttpEffect(group, endpoint, context, handler.handler, handler.isRaw), {
    uninterruptible: handler.uninterruptible
  });
}
const applyMiddleware = (group, endpoint, context, handler) => {
  const options = {
    group,
    endpoint
  };
  for (const key_ of endpoint.middlewares) {
    const key = key_;
    const service = Context.getUnsafe(context, key);
    const apply = HttpApiMiddleware.isSecurity(key) ? makeSecurityMiddleware(key, service) : service;
    handler = apply(handler, options);
  }
  return handler;
};
const securityMiddlewareCache = /*#__PURE__*/new WeakMap();
const makeSecurityMiddleware = (key, service) => {
  const cached = securityMiddlewareCache.get(service);
  if (cached !== undefined) {
    return cached;
  }
  const entries = Object.entries(key.security).map(([securityKey, security]) => ({
    decode: securityDecode(security),
    middleware: service[securityKey]
  }));
  if (entries.length === 0) {
    return identity;
  }
  const middleware = Effect.fnUntraced(function* (handler, options) {
    handler = Effect.mapError(handler, error => new HandlerError(error));
    let lastResult;
    for (let i = 0; i < entries.length; i++) {
      const {
        decode,
        middleware
      } = entries[i];
      const result = yield* Effect.result(Effect.flatMap(decode, credential => middleware(handler, {
        credential,
        endpoint: options.endpoint,
        group: options.group
      })));
      if (Result.isFailure(result)) {
        if (isHandlerError(result.failure)) {
          return yield* Effect.fail(result.failure.error);
        }
        lastResult = result;
        continue;
      }
      return result.success;
    }
    return yield* Effect.fromResult(lastResult);
  });
  securityMiddlewareCache.set(service, middleware);
  return middleware;
};
const HandlerErrorTypeId = "~effect/httpapi/HttpApiBuilder/HandlerError";
class HandlerError {
  [HandlerErrorTypeId] = HandlerErrorTypeId;
  error;
  constructor(error) {
    this.error = error;
  }
}
const isHandlerError = value => hasProperty(value, HandlerErrorTypeId);
const $HttpServerResponse = /*#__PURE__*/Schema.declare(Response.isHttpServerResponse);
function makeStreamEncoder(endpoint) {
  const streamSchema = getStreamSuccessSchema(endpoint);
  if (streamSchema === undefined) {
    return undefined;
  }
  const hasBuffered = hasBufferedSuccess(endpoint);
  const status = HttpApiSchema.getStatusStream(streamSchema);
  const contentType = streamSchema.contentType;
  if (HttpApiSchema.isStreamUint8Array(streamSchema)) {
    return (response, context) => {
      if (!Stream.isStream(response)) {
        return hasBuffered ? undefined : new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some(response), {
          message: "Expected a streaming response"
        }));
      }
      return Effect.succeed(Response.stream(Stream.provideContext(response, context), {
        status,
        contentType
      }));
    };
  }
  const sseEncoder = makeSseEncoder(streamSchema);
  return (response, context) => {
    if (!Stream.isStream(response)) {
      return hasBuffered ? undefined : new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some(response), {
        message: "Expected a streaming response"
      }));
    }
    return Effect.succeed(Response.stream(Stream.provideContext(encodeSseStream(response, sseEncoder), context), {
      status,
      contentType
    }));
  };
}
function getStreamSuccessSchema(endpoint) {
  for (const schema of endpoint.success) {
    if (HttpApiSchema.isStreamSchema(schema)) {
      return schema;
    }
  }
}
function hasBufferedSuccess(endpoint) {
  for (const schema of endpoint.success) {
    if (Schema.isSchema(schema) && !HttpApiSchema.isStreamSchema(schema)) return true;
  }
  return endpoint.success.size === 0;
}
function makeSseEncoder(streamSchema) {
  const CauseSchema = Schema.toCodecJson(Schema.Cause(streamSchema.error, Schema.Defect()));
  return {
    sseMode: streamSchema.sseMode,
    encodeEvents: Schema.encodeUnknownEffect(Schema.Array(streamSchema.events)),
    encodeCause: Schema.encodeUnknownEffect(Schema.fromJsonString(CauseSchema))
  };
}
function encodeSseStream(stream, encoder) {
  return stream.pipe(encoder.sseMode === "data" ? Stream.map(value => ({
    id: undefined,
    event: "message",
    data: value
  })) : identity, Stream.mapArrayEffect(chunk => Effect.orDie(encoder.encodeEvents(chunk))), Stream.catchCause(cause => Stream.fromEffect(encodeFailureEvent(cause, encoder))), Stream.map(renderSseEvent), Stream.encodeText);
}
function encodeFailureEvent(cause, encoder) {
  return encoder.encodeCause(cause).pipe(Effect.orDie, Effect.map(encodedCause => ({
    id: undefined,
    event: reservedStreamFailureEvent,
    data: encodedCause
  })));
}
const reservedStreamFailureEvent = "effect/httpapi/stream/failure";
function renderSseEvent(event) {
  return Sse.encoder.write({
    _tag: "Event",
    event: event.event,
    id: event.id,
    data: event.data
  });
}
const toResponseSuccessSchema = /*#__PURE__*/toResponseSchema(HttpApiSchema.getStatusSuccess);
const toResponseErrorSchema = /*#__PURE__*/toResponseSchema(HttpApiSchema.getStatusError);
function makeSuccessSchema(endpoint) {
  const schemas = HttpApiEndpoint.getSuccessSchemas(endpoint).map(toResponseSuccessSchema);
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas);
}
function makeErrorSchema(endpoint) {
  const schemas = HttpApiEndpoint.getErrorSchemas(endpoint).map(toResponseErrorSchema);
  if (schemas.length === 0) return Schema.Never;
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas);
}
function toResponseSchema(getStatus) {
  const cache = new WeakMap();
  return schema => {
    const cached = cache.get(schema.ast);
    if (cached !== undefined) {
      return cached;
    }
    const responseSchema = $HttpServerResponse.pipe(Schema.decodeTo(schema, getResponseTransformation(getStatus, schema)));
    cache.set(schema.ast, responseSchema);
    return responseSchema;
  };
}
function getResponseTransformation(getStatus, schema) {
  const ast = schema.ast;
  const encode = getResponseEncode(getStatus(ast), HttpApiSchema.getResponseEncoding(ast), HttpApiSchema.isNoContent(ast));
  return SchemaTransformation.transformOrFail({
    decode: res => Effect.fail(new SchemaIssue.Forbidden(Option.some(res), {
      message: "Encode only schema"
    })),
    encode
  });
}
function getResponseEncode(status, encoding, isNoContent) {
  switch (encoding._tag) {
    case "Json":
      {
        return e => {
          if (e === undefined || isNoContent) {
            return Effect.succeed(Response.empty({
              status
            }));
          }
          try {
            const s = JSON.stringify(e);
            return Effect.succeed(Response.text(s, {
              status,
              contentType: encoding.contentType
            }));
          } catch (error) {
            return Effect.fail(new SchemaIssue.InvalidValue(Option.some(e), {
              message: globalThis.String(error)
            }));
          }
        };
      }
    case "Text":
      return e => Effect.succeed(Response.text(e, {
        status,
        contentType: encoding.contentType
      }));
    case "Uint8Array":
      return e => Effect.succeed(Response.uint8Array(e, {
        status,
        contentType: encoding.contentType
      }));
    case "FormUrlEncoded":
      return e => Effect.succeed(Response.urlParams(e, {
        status
      }).pipe(Response.setHeader("content-type", encoding.contentType)));
  }
}
//# sourceMappingURL=HttpApiBuilder.js.map