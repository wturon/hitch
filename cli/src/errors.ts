// The CLI's two failure kinds, mapped to exit codes in index.ts:
//   UsageError → exit 2 (the invocation was wrong; the message shows the
//                 exact correct one — errors teach, that's the product)
//   CliError   → exit 1 (the invocation was fine, the operation failed)
// Anything else that escapes is a bug and also exits 1.

export class UsageError extends Error {}

export class CliError extends Error {}
