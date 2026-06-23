// @kgpacks/eval — error taxonomy.
//
// The eval package fails closed: it returns valid, shape-checked data or throws
// `EvalError`. `instanceof EvalError` catches every error this package raises
// (configuration mistakes, an unsafe packId, an invalid sample size). The LLM
// judge is the one deliberate exception — a malformed grade does NOT throw, it
// scores `{ correct: false, score: 0 }`, so judge variance can only hurt an arm,
// never inflate it (see judge.ts and docs/packages/eval.md "Security model").

/** Base (and only) class for errors this package throws. */
export class EvalError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvalError';
    // Preserve the prototype chain so `instanceof` holds across transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
