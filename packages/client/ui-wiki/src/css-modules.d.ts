/** CSS Modules declaration for `*.module.css` imports. */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
