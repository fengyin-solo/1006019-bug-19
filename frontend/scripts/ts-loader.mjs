/**
 * 极简 TS ESM 加载器：只服务于本地验收脚本。
 * - 把 '@/...' 别名解析到 src/
 * - 用 typescript（纯 JS 实现）把 .ts 即时转成 ESM，不依赖平台相关的 esbuild 二进制
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { transpileModule, ModuleKind } = require('typescript')

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolvePath(here, '..', 'src')

export async function resolve(specifier, context, nextResolve) {
  let base = null
  if (specifier.startsWith('@/')) {
    base = resolvePath(srcRoot, specifier.slice(2))
  } else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL
  ) {
    base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
  }
  if (base) {
    const candidates = [base + '.ts', resolvePath(base, 'index.ts')]
    for (const candidate of candidates) {
      try {
        readFileSync(candidate)
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      } catch {
        // try next
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { outputText } = transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ES2020,
        target: 'ES2020',
        sourceMap: false,
      },
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
