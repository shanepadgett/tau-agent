import { errorNeedsCause } from "./error-rules.ts";
import { testRule } from "./rule-tester.ts";

const EFFECT = "import { Effect } from 'effect';\n";

testRule("error-needs-cause", errorNeedsCause, {
  valid: [
    "export const read = () => { try { return 1; } catch (error) { throw new ReadError('failed', { cause: error }); } };",
    "export const read = () => { try { return 1; } catch (error) { throw error; } };",
    "export const read = () => { try { return 1; } catch (error) { throw new ReadError(String(error)); } };",
    "export const read = () => { throw new ReadError('failed'); };",
    "export const read = () => { try { return 1; } catch (error) { throw new Result(error); } };",
    EFFECT +
      "export const read = Effect.tryPromise({ try: () => fetch('x'), catch: (error) => new ReadError({ cause: error }) });",
    EFFECT +
      "export const read = Effect.tryPromise({ try: () => fetch('x'), catch: (error) => error });",
    EFFECT +
      "export const map = (task: Effect.Effect<number, string>) => task.pipe(Effect.mapError((error) => new ReadError({ message: error })));",
    "const Effect = { mapError: (handler: () => unknown) => handler }; export const map = Effect.mapError(() => new ReadError());",
  ],
  invalid: [
    {
      code: "export const read = () => { try { return 1; } catch (error) { throw new Error('failed'); } };",
      errors: [{ message: /Pass the caught error as `cause`/, line: 1 }],
    },
    {
      code: "export const read = () => { try { return 1; } catch { throw new ReadError('failed'); } };",
      errors: 1,
    },
    {
      code: "export const read = () => { try { return 1; } catch (error) { throw new ReadError('failed ' + errors); } };",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const read = Effect.tryPromise({ try: () => fetch('x'), catch: () => new ReadError({ message: 'failed' }) });",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const read = Effect.try({ try: () => JSON.parse('x'), catch: (error) => new ParseError({ message: 'bad' }) });",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const map = (task: Effect.Effect<number, string>) => task.pipe(Effect.mapError(() => new ReadError({ message: 'failed' })));",
      errors: 1,
    },
  ],
});
