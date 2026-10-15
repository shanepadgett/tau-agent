/** Gives Bun file imports for bundled notification audio a path type. */

declare module "*.wav" {
  const path: string;
  export default path;
}
