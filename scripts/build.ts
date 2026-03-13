import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { execSync } from "node:child_process"

const rootDir = resolve(import.meta.dirname, "..")
const themesDir = join(rootDir, "themes")
const shouldInstall = process.argv.includes("--install")

interface ThemeBase {
  readonly name: string
  readonly type: string
  readonly semanticHighlighting: boolean
}

interface TokenRule {
  readonly scope: readonly string[]
  readonly settings: Record<string, string>
}

interface ThemePackageJson {
  readonly name: string
  readonly version: string
}

const colorPartFiles = ["colors-editor.json", "colors-ui.json", "colors-terminal.json"] as const

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8"))

const writeJson = (path: string, data: unknown): void =>
  writeFileSync(path, JSON.stringify(data, null, 2))

const discoverThemes = (): readonly string[] =>
  readdirSync(themesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(themesDir, e.name, "parts")))
    .map(e => e.name)

const mergeColors = (partsDir: string): Record<string, string> =>
  colorPartFiles.reduce((acc, file) => {
    const filePath = join(partsDir, file)
    return existsSync(filePath)
      ? { ...acc, ...readJson<Record<string, string>>(filePath) }
      : acc
  }, {} as Record<string, string>)

const mergeTheme = (themeId: string): string => {
  const themeDir = join(themesDir, themeId)
  const partsDir = join(themeDir, "parts")
  const outDir = join(themeDir, "themes")
  mkdirSync(outDir, { recursive: true })

  const base = readJson<ThemeBase>(join(partsDir, "base.json"))
  const colors = mergeColors(partsDir)

  const tokensPath = join(partsDir, "tokens.json")
  const tokenColors: readonly TokenRule[] = existsSync(tokensPath) ? readJson(tokensPath) : []

  const semanticPath = join(partsDir, "semantic.json")
  const semanticTokenColors: Record<string, string> = existsSync(semanticPath) ? readJson(semanticPath) : {}

  const theme = {
    name: base.name,
    type: base.type,
    semanticHighlighting: base.semanticHighlighting,
    colors,
    tokenColors,
    ...(Object.keys(semanticTokenColors).length > 0 && { semanticTokenColors }),
  }

  const outPath = join(outDir, `${themeId}-color-theme.json`)
  writeJson(outPath, theme)
  return outPath
}

const packageTheme = (themeId: string): string => {
  const themeDir = join(themesDir, themeId)
  const { version } = readJson<ThemePackageJson>(join(themeDir, "package.json"))
  execSync("pnpm exec vsce package --allow-missing-repository", { cwd: themeDir, stdio: "inherit" })
  return join(themeDir, `${themeId}-${version}.vsix`)
}

const installTheme = (vsixPath: string): void =>
  execSync(`code --install-extension "${vsixPath}" --force`, { stdio: "inherit" })

// Main
const themes = discoverThemes()
console.log(`Found themes: ${themes.join(", ")}`)

const vsixPaths = themes.map(themeId => {
  console.log(`\n--- ${themeId} ---`)

  const themePath = mergeTheme(themeId)
  console.log(`Merged: ${themePath}`)

  const vsixPath = packageTheme(themeId)
  console.log(`Packaged: ${vsixPath}`)

  return vsixPath
})

if (shouldInstall) {
  console.log("\n--- Installing ---")
  vsixPaths.forEach(installTheme)
  console.log("\nAll themes installed. Press Cmd+K Cmd+T to select.")
}
