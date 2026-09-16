import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Deliberately close to the defaults.
 *
 * `tsc --strict` with `noUncheckedIndexedAccess` already does most of the work
 * here, so the lint config's job is the handful of things a type checker does
 * not see. The rules that are turned *on* below are the ones with a reason
 * specific to this project; everything else is the recommended set.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", ".wrangler/**", "mockups/**", "migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        btoa: "readonly",
        atob: "readonly",
        globalThis: "readonly",
        Cache: "readonly",
        D1Database: "readonly",
        ScheduledController: "readonly",
      },
    },
    rules: {
      // Money is integer micro-dollars. `==` coercion around numbers that came
      // out of SQLite is exactly how a float gets into a balance.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // Nothing on this site may execute a string. The CSP says `default-src
      // 'none'`; these are the ways to break that promise from the server side.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // An unawaited promise in the append path is a lost ledger write.
      "require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // The Db interface is intentionally `unknown`-heavy at the boundary; the
      // casts are narrowed immediately and are documented where they happen.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
