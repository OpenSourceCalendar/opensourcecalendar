// Wrangler and @cloudflare/vite-plugin load a `.wasm` import as a compiled WebAssembly.Module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
