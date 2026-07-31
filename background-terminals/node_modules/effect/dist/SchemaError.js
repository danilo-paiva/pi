/**
 * @since 4.0.0
 */
import * as Data from "./Data.js";
import * as Predicate from "./Predicate.js";
const TypeId = "~effect/SchemaError/SchemaError";
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
export class SchemaError extends /*#__PURE__*/Data.TaggedError("SchemaError") {
  [TypeId] = TypeId;
  constructor(issue) {
    super({
      issue
    });
  }
  get message() {
    return this.issue.toString();
  }
  toString() {
    return `SchemaError(${this.message})`;
  }
}
/**
 * Returns `true` if `u` is a {@link SchemaError}.
 *
 * @category guards
 * @since 4.0.0
 */
export function isSchemaError(u) {
  return Predicate.hasProperty(u, TypeId);
}
//# sourceMappingURL=SchemaError.js.map