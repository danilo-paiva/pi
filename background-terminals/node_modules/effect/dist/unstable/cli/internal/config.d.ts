/**
 * Config Internal
 * ================
 *
 * The processed internal representation of a Command.Config declaration.
 * Separates the user's declared config shape from the flat parsing representation.
 *
 * Key concepts:
 * - ConfigInternal: The full processed form (flags, arguments, tree)
 * - ConfigInternal.Tree: Maps declaration keys to nodes
 * - ConfigInternal.Node: Param reference, Array, or Nested subtree
 *
 * Example transformation from Command.Config to Command.Config.Internal:
 *
 * ```ts
 * // User declares:
 * const config = {
 *   verbose: Flag.boolean("verbose"),
 *   server: {
 *     host: Flag.string("host"),
 *     port: Flag.integer("port")
 *   },
 *   files: Argument.string("files").pipe(Argument.variadic)
 * }
 *
 * // Becomes Config.Internal:
 * {
 *   arguments: [filesParam],           // Flat array of arguments
 *   flags: [verboseParam, hostParam, portParam],  // Flat array of flags
 *   orderedParams: [verboseParam, hostParam, portParam, filesParam],
 *   tree: {                            // Preserves nested structure
 *     verbose: { _tag: "Param", index: 0 },
 *     server: {
 *       _tag: "Nested",
 *       tree: {
 *         host: { _tag: "Param", index: 1 },
 *         port: { _tag: "Param", index: 2 }
 *       }
 *     },
 *     files: { _tag: "Param", index: 3 }
 *   }
 * }
 * ```
 *
 * This separation allows:
 * 1. Flat iteration over all params for parsing/validation
 * 2. Reconstruction of original nested shape for handler input
 */
import * as Param from "../Param.ts";
declare const ConfigInternalTypeId: "~effect/cli/Command/Config/Internal";
/**
 * The processed internal representation of a Command.Config declaration.
 *
 * Created by parsing the user's config. Separates parameters by type
 * while preserving the original nested structure via the tree.
 */
export interface ConfigInternal {
    readonly [ConfigInternalTypeId]: typeof ConfigInternalTypeId;
    /** The command's positional argument parameters. */
    readonly arguments: ReadonlyArray<Param.AnyArgument>;
    /** The command's flag parameters. */
    readonly flags: ReadonlyArray<Param.AnyFlag>;
    /** All parameters in declaration order. */
    readonly orderedParams: ReadonlyArray<Param.Any>;
    /** Tree structure for reconstructing nested config. */
    readonly tree: ConfigInternal.Tree;
}
/**
 * Namespace containing the tree and node types used to reconstruct parsed
 * command configuration values.
 *
 * @since 4.0.0
 */
export declare namespace ConfigInternal {
    /**
     * Maps declaration keys to their node representations.
     * Preserves the shape of the user's config object.
     */
    interface Tree {
        [key: string]: Node;
    }
    /**
     * A node in the config tree.
     *
     * - Param: References a parameter by index in orderedParams
     * - Array: Contains child nodes for tuple/array declarations
     * - Nested: Contains a subtree for nested config objects
     */
    type Node = {
        readonly _tag: "Param";
        readonly index: number;
    } | {
        readonly _tag: "Array";
        readonly children: ReadonlyArray<Node>;
    } | {
        readonly _tag: "Nested";
        readonly tree: Tree;
    };
}
export {};
//# sourceMappingURL=config.d.ts.map