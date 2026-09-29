// The prebuilt bundle has no types of its own; this is the one call /api-docs makes.
declare module "swagger-ui-dist/swagger-ui-bundle.js" {
  const SwaggerUIBundle: (options: { domNode: HTMLElement; url: string }) => unknown
  export default SwaggerUIBundle
}
