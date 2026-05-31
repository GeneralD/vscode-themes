import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { execSync } from "node:child_process"
import { deflateSync } from "node:zlib"

const rootDir = resolve(import.meta.dirname, "..")
const themesDir = join(rootDir, "themes")
const shouldInstall = process.argv.includes("--install")
const shouldUnify = process.argv.includes("--unified")
const shouldUninstall = process.argv.includes("--uninstall")
const shouldReadme = process.argv.includes("--readme")

// --- Types ---

interface ThemeBase {
  readonly name: string
  readonly type: string
  readonly semanticHighlighting: boolean
  readonly description?: string
  readonly colors?: readonly string[]
}

interface TokenRule {
  readonly scope: readonly string[]
  readonly settings: Record<string, string>
}

interface ThemeContribution {
  readonly label: string
  readonly uiTheme: string
  readonly path: string
}

interface ThemePackageJson {
  readonly name: string
  readonly version: string
  readonly displayName?: string
  readonly contributes?: {
    readonly themes?: readonly ThemeContribution[]
  }
}

interface UnifiedConfig {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  readonly publisher: string
  readonly repository: string
}

interface RootPackageJson {
  readonly unified: UnifiedConfig
}

// --- Utilities ---

const colorPartFiles = ["colors-editor.json", "colors-ui.json", "colors-terminal.json"] as const

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8"))

const writeJson = (path: string, data: unknown): void =>
  writeFileSync(path, JSON.stringify(data, null, 2))

const readBase = (themeId: string): ThemeBase =>
  readJson<ThemeBase>(join(themesDir, themeId, "parts", "base.json"))

const readThemePackageJson = (themeId: string): ThemePackageJson =>
  readJson<ThemePackageJson>(join(themesDir, themeId, "package.json"))

// --- PNG Icon Generation ---

const parseHex = (hex: string): readonly [number, number, number] => {
  const h = hex.replace("#", "")
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

const crc32Table: readonly number[] = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>(
    (c) => (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1),
    n,
  )
)

const crc32 = (buf: Buffer): number =>
  ~Array.from(buf).reduce((c, byte) => crc32Table[(c ^ byte) & 0xff]! ^ (c >>> 8), 0xffffffff) >>> 0

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typeData))
  return Buffer.concat([length, typeData, checksum])
}

const generateIconPng = (colors: readonly string[], size = 128): Buffer => {
  const palette = colors.length > 0 ? colors : ["#333333"]
  const rgbColors = palette.map(parseHex)
  const stripeWidth = Math.floor(size / rgbColors.length)

  const rawData = Buffer.alloc(size * (1 + size * 3))
  Array.from({ length: size }, (_, y) => {
    const rowOffset = y * (1 + size * 3)
    rawData[rowOffset] = 0 // filter: none
    Array.from({ length: size }, (_, x) => {
      const colorIndex = Math.min(Math.floor(x / stripeWidth), rgbColors.length - 1)
      const [r, g, b] = rgbColors[colorIndex]!
      const pixelOffset = rowOffset + 1 + x * 3
      rawData[pixelOffset] = r
      rawData[pixelOffset + 1] = g
      rawData[pixelOffset + 2] = b
    })
  })

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // color type: RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rawData)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

const generateIcon = (themeId: string, outputDir: string): string => {
  const base = readBase(themeId)
  const iconPath = join(outputDir, "icon.png")
  writeFileSync(iconPath, generateIconPng(base.colors ?? []))
  return iconPath
}

// --- Theme Discovery & Merge ---

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

// --- README & CHANGELOG ---

// Render each palette color as a shields.io swatch badge fully filled with the
// hex, with the hex shown as auto-contrasted text. Absolute URLs render in the
// VSCode Extensions "Details" tab (relative paths there do not), on GitHub, and
// on the Marketplace alike.
const paletteSwatches = (colors: readonly string[]): string =>
  colors
    .map(hex => {
      // shields color accepts 3/6-digit hex but treats 8-digit (#RRGGBBAA) as a
      // named color and falls back to green — drop any alpha so the swatch shows
      // the actual base color.
      const bare = hex.replace(/^#/, "").slice(0, 6)
      return `![${hex}](https://img.shields.io/badge/-${bare}-${bare}?style=flat-square)`
    })
    .join(" ")

// github.com repo URL -> raw.githubusercontent.com base for the main branch.
const rawBaseUrl = (repository: string): string =>
  `${repository.replace(/\.git$/, "").replace("https://github.com/", "https://raw.githubusercontent.com/")}/main`

const themeHeroPath = (themeId: string): string =>
  join(themesDir, themeId, "assets", "hero.png")

const collectionHeroPath = join(rootDir, "assets", "hero.png")

// Markdown image lines for a hero, or nothing when there is no hero src — keeps
// the README free of broken-image links when an asset is absent.
const heroLines = (alt: string, src: string | null): readonly string[] =>
  src ? [`![${alt}](${src})`, ""] : []

// Hero src for a theme. Pass rawBase for an absolute URL (vsix Details tab),
// or null for a repo-relative path (GitHub-native root README).
const themeHeroSrc = (themeId: string, rawBase: string | null): string | null => {
  if (!existsSync(themeHeroPath(themeId))) return null
  return rawBase ? `${rawBase}/themes/${themeId}/assets/hero.png` : `themes/${themeId}/assets/hero.png`
}

const collectionHeroSrc = (rawBase: string | null): string | null => {
  if (!existsSync(collectionHeroPath)) return null
  return rawBase ? `${rawBase}/assets/hero.png` : "assets/hero.png"
}

const generateThemeSection = (themeId: string, rawBase: string | null): string => {
  const base = readBase(themeId)
  return [
    `### ${base.name}`,
    "",
    ...heroLines(base.name, themeHeroSrc(themeId, rawBase)),
    `> ${base.description ?? ""}`,
    "",
    `**Type:** ${base.type} | **Palette:** ${paletteSwatches(base.colors ?? [])}`,
  ].join("\n")
}

const generateUnifiedReadme = (themeIds: readonly string[], unified: UnifiedConfig): string => {
  const rawBase = rawBaseUrl(unified.repository)
  const themeSections = themeIds.map(themeId => generateThemeSection(themeId, rawBase))

  return [
    `# ${unified.displayName}`,
    "",
    ...heroLines(unified.displayName, collectionHeroSrc(rawBase)),
    unified.description,
    "",
    "## Themes",
    "",
    themeSections.join("\n\n"),
    "",
    "## Features",
    "",
    "- Semantic highlighting support for all themes",
    "- Carefully crafted color palettes with consistent contrast",
    "- Full coverage of editor, UI, terminal, and syntax colors",
    "- Each theme tells a story through its unique color language",
    "",
    "## Installation",
    "",
    "1. Install the extension",
    "2. Press `Cmd+K Cmd+T` (Mac) or `Ctrl+K Ctrl+T` (Windows/Linux)",
    "3. Select your theme",
    "",
  ].join("\n")
}

const generateSingleReadme = (themeId: string, rawBase: string): string => {
  const base = readBase(themeId)
  return [
    `# ${base.name}`,
    "",
    ...heroLines(base.name, themeHeroSrc(themeId, rawBase)),
    base.description ?? "",
    "",
    `**Palette:** ${paletteSwatches(base.colors ?? [])}`,
    "",
    "## Features",
    "",
    "- Semantic highlighting support",
    "- Full coverage of editor, UI, terminal, and syntax colors",
    "",
    "## Installation",
    "",
    "1. Install the extension",
    "2. Press `Cmd+K Cmd+T` (Mac) or `Ctrl+K Ctrl+T` (Windows/Linux)",
    `3. Select **${base.name}**`,
    "",
  ].join("\n")
}

// The committed, GitHub-rendered repo README. Uses repo-relative image paths
// (rawBase = null) since GitHub resolves and camo-caches them natively. This
// file is regenerated on every build — edit the generator, not README.md.
const generateRootReadme = (themeIds: readonly string[], unified: UnifiedConfig): string => {
  const gallery = themeIds.map(themeId => generateThemeSection(themeId, null))
  return [
    "<!-- Generated by scripts/build.ts — run `pnpm readme` to regenerate. Edit the generator, not this file. -->",
    "",
    `# ${unified.displayName}`,
    "",
    ...heroLines(unified.displayName, collectionHeroSrc(null)),
    unified.description,
    "",
    "## Themes",
    "",
    gallery.join("\n\n"),
    "",
    "## Setup",
    "",
    "```bash",
    "pnpm install",
    "```",
    "",
    "Requires the `code` CLI: in VSCode, press `Cmd+Shift+P` → \"Shell Command: Install 'code' command in PATH\".",
    "",
    "## Commands",
    "",
    "```bash",
    "# Build all themes as individual .vsix files",
    "pnpm build",
    "",
    "# Build the unified .vsix (all themes in one extension)",
    "pnpm build:unified",
    "",
    "# Build + install (individual / unified)",
    "pnpm install-themes",
    "pnpm install-unified",
    "",
    "# Uninstall (individual / unified)",
    "pnpm uninstall-themes",
    "pnpm uninstall-unified",
    "",
    "# Regenerate this README",
    "pnpm readme",
    "```",
    "",
    "## Adding a New Theme",
    "",
    "Use the `/vscode-theme` skill in Claude Code. New themes under `themes/*` are discovered automatically by the build — no manual registration needed. Each theme's hero image, color-swatch palette, README, icon, and CHANGELOG are generated for you.",
    "",
  ].join("\n")
}

const generateChangelog = (version: string): string =>
  [
    `# Changelog`,
    "",
    `## ${version}`,
    "",
    "- Initial release",
    "",
  ].join("\n")

// --- Packaging ---

const packageTheme = (themeId: string): string => {
  const themeDir = join(themesDir, themeId)
  const pkg = readThemePackageJson(themeId)
  const { unified } = readJson<RootPackageJson>(join(rootDir, "package.json"))

  generateIcon(themeId, themeDir)
  writeFileSync(join(themeDir, "README.md"), generateSingleReadme(themeId, rawBaseUrl(unified.repository)))
  writeFileSync(join(themeDir, "CHANGELOG.md"), generateChangelog(pkg.version))

  const pkgWithIcon = { ...pkg, icon: "icon.png", repository: unified.repository }
  writeJson(join(themeDir, "package.json"), pkgWithIcon)

  execSync("pnpm exec vsce package --allow-missing-repository", { cwd: themeDir, stdio: "inherit" })
  return join(themeDir, `${themeId}-${pkg.version}.vsix`)
}

const collectThemeContributions = (themeIds: readonly string[]): readonly ThemeContribution[] =>
  themeIds.flatMap(themeId => {
    const pkg = readThemePackageJson(themeId)
    return (pkg.contributes?.themes ?? []).map(theme => ({
      ...theme,
      path: `./themes/${themeId}-color-theme.json`,
    }))
  })

const buildUnified = (themeIds: readonly string[]): string => {
  const { unified } = readJson<RootPackageJson>(join(rootDir, "package.json"))
  const stagingDir = join(rootDir, "dist", "unified")
  const stagingThemesDir = join(stagingDir, "themes")

  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingThemesDir, { recursive: true })

  const mergedPaths = themeIds.map(themeId => {
    const themePath = mergeTheme(themeId)
    console.log(`Merged: ${themePath}`)
    return { themeId, themePath }
  })

  mergedPaths.forEach(({ themeId, themePath }) =>
    copyFileSync(themePath, join(stagingThemesDir, `${themeId}-color-theme.json`))
  )

  const contributions = collectThemeContributions(themeIds)
  const allColors = themeIds.flatMap(id => [...(readBase(id).colors ?? [])].slice(0, 2))
  writeFileSync(join(stagingDir, "icon.png"), generateIconPng(allColors.slice(0, 8)))

  writeJson(join(stagingDir, "package.json"), {
    name: unified.name,
    displayName: unified.displayName,
    description: unified.description,
    version: unified.version,
    publisher: unified.publisher,
    repository: unified.repository,
    license: "MIT",
    icon: "icon.png",
    engines: { vscode: "^1.74.0" },
    categories: ["Themes"],
    contributes: { themes: contributions },
  })

  writeFileSync(join(stagingDir, "README.md"), generateUnifiedReadme(themeIds, unified))
  writeFileSync(join(stagingDir, "CHANGELOG.md"), generateChangelog(unified.version))

  const licensePath = join(rootDir, "LICENSE")
  if (existsSync(licensePath)) {
    copyFileSync(licensePath, join(stagingDir, "LICENSE"))
  }

  execSync("pnpm exec vsce package --allow-missing-repository", { cwd: stagingDir, stdio: "inherit" })
  return join(stagingDir, `${unified.name}-${unified.version}.vsix`)
}

// --- Install / Uninstall ---

const installExtension = (vsixPath: string): void =>
  execSync(`code --install-extension "${vsixPath}" --force`, { stdio: "inherit" })

const isExtensionInstalled = (extensionId: string): boolean =>
  execSync("code --list-extensions", { encoding: "utf8" })
    .split("\n")
    .some(line => line.trim().toLowerCase() === extensionId.toLowerCase())

const uninstallExtension = (extensionId: string): void => {
  if (!isExtensionInstalled(extensionId)) {
    console.log(`Skipped (not installed): ${extensionId}`)
    return
  }
  execSync(`code --uninstall-extension "${extensionId}"`, { stdio: "inherit" })
}

const getExtensionId = (publisher: string, name: string): string =>
  `${publisher}.${name}`

const writeRootReadme = (themeIds: readonly string[]): void => {
  const { unified } = readJson<RootPackageJson>(join(rootDir, "package.json"))
  writeFileSync(join(rootDir, "README.md"), generateRootReadme(themeIds, unified))
  console.log("Generated: README.md")
}

// --- Main ---

const themes = discoverThemes()
console.log(`Found themes: ${themes.join(", ")}`)

if (shouldReadme) {
  writeRootReadme(themes)
} else if (shouldUninstall) {
  console.log("\n--- Uninstalling ---")
  if (shouldUnify) {
    const { unified } = readJson<RootPackageJson>(join(rootDir, "package.json"))
    uninstallExtension(getExtensionId(unified.publisher, unified.name))
  } else {
    themes.forEach(themeId => {
      const pkg = readThemePackageJson(themeId)
      uninstallExtension(getExtensionId("custom", pkg.name))
    })
  }
  console.log("\nDone.")
} else if (shouldUnify) {
  console.log("\n--- Unified Build ---")
  const vsixPath = buildUnified(themes)
  console.log(`\nUnified package: ${vsixPath}`)

  if (shouldInstall) {
    console.log("\n--- Reinstalling ---")
    const { unified } = readJson<RootPackageJson>(join(rootDir, "package.json"))
    uninstallExtension(getExtensionId(unified.publisher, unified.name))
    installExtension(vsixPath)
    console.log("\nUnified theme installed. Press Cmd+K Cmd+T to select.")
  }

  writeRootReadme(themes)
} else {
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
    vsixPaths.forEach(installExtension)
    console.log("\nAll themes installed. Press Cmd+K Cmd+T to select.")
  }

  writeRootReadme(themes)
}
