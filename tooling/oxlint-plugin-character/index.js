// This repo's own oxlint rules. They guard the privacy rules in AGENTS.md: photos never leave the device, are never
// logged, and runtime code runs in browsers, workers and Electron renderers only. Enabled for src/** in .oxlintrc.json.
import path from "node:path"

const LOADER = "src/scan/loader.ts"
const ENGINE = "src/scan/engine.ts"

function projectPath(filename) {
  return path.relative(process.cwd(), path.resolve(filename)).split(path.sep).join("/")
}

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "tls",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
])

const noConsole = {
  meta: { type: "problem", docs: { description: "No console in runtime code: image data must never be logged." } },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "console") return
        context.report({
          node,
          message: 'No console.* in runtime code (AGENTS.md "Privacy"): report through scan events instead.',
        })
      },
    }
  },
}

const NETWORK_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"])

const noNetworkOutsideLoader = {
  meta: {
    type: "problem",
    docs: { description: `Network access only in ${LOADER}, which fetches pinned assets and checks their SHA-256.` },
  },
  create(context) {
    if (projectPath(context.filename) === LOADER) return {}
    const report = (node, what) =>
      context.report({
        node,
        message: `${what} outside ${LOADER}. Only the pinned asset loader may touch the network (AGENTS.md "Privacy").`,
      })
    return {
      Identifier(node) {
        if (!NETWORK_GLOBALS.has(node.name)) return
        const parent = node.parent
        // A property key or member name (`options.fetch`, `{ fetch: … }`) is not the global.
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return
        if ((parent?.type === "Property" || parent?.type === "PropertyDefinition") && parent.key === node) return
        if (parent?.type === "ImportSpecifier" || parent?.type === "ExportSpecifier") return
        report(node, `\`${node.name}\``)
      },
      MemberExpression(node) {
        if (node.property.type === "Identifier" && node.property.name === "sendBeacon") report(node, "`sendBeacon`")
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && typeof node.source.value === "string") return
        report(node, "Dynamic `import()` of a computed URL")
      },
    }
  },
}

const noNodeBuiltins = {
  meta: { type: "problem", docs: { description: "No Node or Bun modules in runtime code." } },
  create(context) {
    const check = (node, source) => {
      if (typeof source !== "string") return
      if (source.startsWith("node:") || source === "bun" || source.startsWith("bun:") || NODE_BUILTINS.has(source))
        context.report({
          node,
          message: `\`${source}\` is a Node/Bun module; runtime code runs in browsers, workers and Electron renderers.`,
        })
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ExportAllDeclaration(node) {
        check(node, node.source?.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value)
      },
    }
  },
}

// Heuristic: a postMessage whose message is an object literal with a key named like image data. The worker protocol
// sends landmarks and numbers back, never pixels; only the engine transfers the input bitmaps to the worker, once.
const IMAGE_KEY = /image|bitmap|pixel|rgba|photo|blob/i

function imageKeys(node) {
  if (node?.type !== "ObjectExpression") return []
  const keys = []
  for (const property of node.properties) {
    if (property.type !== "Property") continue
    const key = property.key.type === "Identifier" ? property.key.name : String(property.key.value ?? "")
    if (IMAGE_KEY.test(key)) keys.push(key)
    keys.push(...imageKeys(property.value))
  }
  return keys
}

const noImageDataInMessages = {
  meta: { type: "problem", docs: { description: "No image data in postMessage outside the scan engine." } },
  create(context) {
    if (projectPath(context.filename) === ENGINE) return {}
    return {
      CallExpression(node) {
        const callee = node.callee
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && callee.property.type === "Identifier"
              ? callee.property.name
              : ""
        if (name !== "postMessage") return
        const keys = imageKeys(node.arguments[0])
        if (keys.length > 0)
          context.report({
            node,
            message: `postMessage carries ${keys.map((key) => `\`${key}\``).join(", ")}: only ${ENGINE} may send the input images, and results never carry pixels.`,
          })
      },
    }
  },
}

export default {
  meta: { name: "character" },
  rules: {
    "no-console": noConsole,
    "no-network-outside-loader": noNetworkOutsideLoader,
    "no-node-builtins": noNodeBuiltins,
    "no-image-data-in-messages": noImageDataInMessages,
  },
}
