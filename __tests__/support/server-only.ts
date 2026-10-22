/**
 * `import "server-only"` under jest. Next resolves the marker itself (its
 * bundled copy is empty under the react-server condition and throws in a
 * client bundle); plain Node has no such package, so the tests map it here.
 */
export {}
