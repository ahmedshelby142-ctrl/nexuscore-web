/**
 * Browser-safe `createServerFn` shim.
 *
 * The original `createServerFn` from `@tanstack/react-start` requires a
 * TanStack Start runtime (Nitro/h3) — its dependency on
 * `@tanstack/start-storage-context` pulls in `node:async_hooks`, which
 * Vite cannot bundle for the browser.
 *
 * This project runs as a plain Vite + React-Router-DOM SPA. Every server
 * function in `src/lib/api/**` already has a complete in-memory /
 * Supabase-client fallback inside its handler, so it is safe to invoke
 * the handler directly on the client.
 *
 * The shim preserves the original call shape and *types*:
 *
 *     const fn = createServerFn({ method: "POST" })
 *       .validator(z.object({ x: z.string() }))
 *       .handler(async ({ data }) => { ... });
 *
 *     await fn({ data: { x: "hi" } });
 *
 * Behaviour:
 *   - `validator` / `inputValidator` accept a zod schema (or anything
 *     with a `.parse(data)` method). The inferred TS type is piped
 *     through to the handler so the original code keeps type-checking
 *     without changes.
 *   - `handler(fn)` returns a callable that runs `fn({ data })` with
 *     the parsed payload. The callable's return type is inferred from
 *     the handler's own return type (mirroring TanStack Start).
 *   - The `method` config is ignored (kept for compatibility).
 *
 * Scope: this shim is intentionally tiny. If a future deployment adds
 * a real TanStack Start server, swap this import for the real one and
 * the call sites do not change.
 */

// We avoid `import { z } from "zod"` here to keep this file
// dependency-free. We rely on duck-typing: a validator is anything
// with a `parse(input: unknown) => unknown` method. The TS type is
// inferred via a `Validator<T>` generic so the handler keeps its
// original signature.
export interface Validator<T> {
  parse: (input: unknown) => T;
}

type AnyValidator = Validator<unknown>;
type InferValidator<S> = S extends Validator<infer T> ? T : unknown;

type ServerFnConfig = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
};

interface ServerFnBuilder<In> {
  validator: <S extends AnyValidator>(schema: S) => ServerFnBuilder<InferValidator<S>>;
  inputValidator: <S extends AnyValidator>(schema: S) => ServerFnBuilder<InferValidator<S>>;
  /**
   * The handler's return type is inferred freely from the supplied
   * function. We intentionally do NOT use `Handler<In, Out>` here —
   * that would force `Out = unknown` and erase every server-fn return
   * type, cascading `unknown` into every consumer.
   */
  handler: <R>(
    fn: (args: { data: In }) => Promise<R> | R,
  ) => (args: { data: unknown }) => Promise<R>;
}

export function createServerFn<In = unknown>(
  _config?: ServerFnConfig,
): ServerFnBuilder<In> {
  let validator: ((input: unknown) => In) | null = null;
  const builder: ServerFnBuilder<In> = {
    validator(schema) {
      validator = (input: unknown) => schema.parse(input) as In;
      return builder as unknown as ServerFnBuilder<never>;
    },
    inputValidator(schema) {
      return builder.validator(schema);
    },
    handler(fn) {
      const parse = validator;
      return async (args: { data: unknown }) => {
        const parsed = parse ? parse(args.data) : (args.data as In);
        return await fn({ data: parsed });
      };
    },
  };
  return builder;
}

export default createServerFn;
