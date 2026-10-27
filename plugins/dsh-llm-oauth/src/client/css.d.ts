/** Class names emitted by the client CSS-module build. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
