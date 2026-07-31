import type { Issue } from "./SchemaIssue.ts";
declare const TypeId = "~effect/SchemaError/SchemaError";
declare const SchemaError_base: new <A extends Record<string, any> = {}>(args: import("./Types.ts").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("./Cause.ts").YieldableError & {
    readonly _tag: "SchemaError";
} & Readonly<A>;
/**
 * Error thrown (or returned as the error channel value) when schema decoding
 * or encoding fails.
 *
 * **Details**
 *
 * The `issue` field contains a structured {@link Issue} tree describing
 * every validation failure, including the path to the problematic value,
 * expected types, and actual values received. `message` renders the issue tree
 * as a human-readable string.
 *
 * Use {@link isSchemaError} to narrow an unknown value to `SchemaError`.
 *
 * **Example** (Catching a SchemaError)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * try {
 *   Schema.decodeUnknownSync(Schema.Number)("not a number")
 * } catch (err) {
 *   if (Schema.isSchemaError(err)) {
 *     console.log(err.message)
 *     // Expected number, actual "not a number"
 *   }
 * }
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export declare class SchemaError extends SchemaError_base<{
    readonly issue: Issue;
}> {
    readonly [TypeId]: typeof TypeId;
    constructor(issue: Issue);
    get message(): string;
    toString(): string;
}
/**
 * Returns `true` if `u` is a {@link SchemaError}.
 *
 * @category guards
 * @since 4.0.0
 */
export declare function isSchemaError(u: unknown): u is SchemaError;
export {};
//# sourceMappingURL=SchemaError.d.ts.map