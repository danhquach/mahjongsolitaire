// Build-time constants injected by Vite's `define` (issue #81), and the raw
// import Vite's `?raw` suffix provides. Node's test build never evaluates
// these — only main.ts uses them, and no test imports main.ts.

declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;

declare module '*.md?raw' {
  const content: string;
  export default content;
}
