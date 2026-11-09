/** Bun embeds files imported with `{ type: "file" }` into compiled binaries. */
declare module "*.wav" {
  const path: string;
  export default path;
}
