// prismjs ships no type declarations and we only need its runtime default export
// to pin the global before MDXEditor/Lexical load (see prism-global.ts).
declare module "prismjs" {
  const Prism: unknown;
  export default Prism;
}
