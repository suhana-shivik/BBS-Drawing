// Vite's `?url` asset import for the pdf.js worker. Declared locally because
// the project tsconfig does not pull in vite/client types.
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
