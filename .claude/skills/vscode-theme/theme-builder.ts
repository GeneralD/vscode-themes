#!/usr/bin/env tsx
/**
 * VSCode Theme Builder
 *
 * Commands:
 *   tsx theme-builder.ts init <theme-id> <theme-name> [--type dark|light]
 *   tsx theme-builder.ts merge <theme-id>
 *   tsx theme-builder.ts package <theme-id>
 *   tsx theme-builder.ts bump <theme-id> [patch|minor|major]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = import.meta.dirname;
const PROJECT_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const TEMPLATE_DIR = join(SCRIPT_DIR, "template");
const THEMES_DIR = join(PROJECT_ROOT, "themes");

type ThemeType = "dark" | "light";
type BumpLevel = "patch" | "minor" | "major";

interface BaseJson {
	name: string;
	type: ThemeType;
	semanticHighlighting: boolean;
	description: string;
	colors: string[];
}

interface TokenRule {
	scope: string | string[];
	settings: Record<string, string>;
}

interface ThemeJson {
	name: string;
	type: ThemeType;
	semanticHighlighting: boolean;
	colors: Record<string, string>;
	tokenColors: TokenRule[];
	semanticTokenColors?: Record<string, string>;
}

const themeDir = (themeId: string) => join(THEMES_DIR, themeId);

const readJson = <T>(filePath: string): T =>
	JSON.parse(readFileSync(filePath, "utf8")) as T;

const writeJson = (filePath: string, data: unknown) =>
	writeFileSync(filePath, JSON.stringify(data, null, 2));

const replaceInFile = (filePath: string, replacements: Record<string, string>) =>
	writeFileSync(
		filePath,
		Object.entries(replacements).reduce(
			(content, [key, value]) => content.replaceAll(key, value),
			readFileSync(filePath, "utf8"),
		),
	);

const fail = (message: string): never => {
	console.error(message);
	return process.exit(1);
};

const COLOR_FILES = ["colors-editor.json", "colors-ui.json", "colors-terminal.json"] as const;

const initTheme = (themeId: string, themeName: string, type: ThemeType = "dark") => {
	const dir = themeDir(themeId);
	if (existsSync(dir)) fail(`Theme directory already exists: ${dir}`);

	cpSync(TEMPLATE_DIR, dir, { recursive: true });

	const uiTheme = type === "light" ? "vs" : "vs-dark";

	replaceInFile(join(dir, "package.json"), {
		"{{THEME_ID}}": themeId,
		"{{THEME_NAME}}": themeName,
		"{{THEME_DESCRIPTION}}": `${themeName} - Custom VSCode Theme`,
		"{{UI_THEME}}": uiTheme,
	});

	replaceInFile(join(dir, "parts", "base.json"), {
		"{{THEME_NAME}}": themeName,
	});

	const baseJsonPath = join(dir, "parts", "base.json");
	const baseJson = readJson<BaseJson>(baseJsonPath);
	baseJson.type = type;
	writeJson(baseJsonPath, baseJson);

	console.log(`Initialized theme: ${themeName}`);
	console.log(`Directory: ${dir}`);
	console.log(`Type: ${type}`);
	console.log(`\nEdit the files in ${dir}/parts/ to customize your theme.`);
};

const mergeTheme = (themeId: string): string => {
	const dir = themeDir(themeId);
	const partsDir = join(dir, "parts");
	if (!existsSync(partsDir)) fail(`Theme "${themeId}" not found or parts directory missing.`);

	const base = readJson<BaseJson>(join(partsDir, "base.json"));

	const colors = COLOR_FILES.reduce<Record<string, string>>((acc, file) => {
		const filePath = join(partsDir, file);
		return existsSync(filePath)
			? { ...acc, ...readJson<Record<string, string>>(filePath) }
			: acc;
	}, {});

	const tokensPath = join(partsDir, "tokens.json");
	const tokenColors: TokenRule[] = existsSync(tokensPath) ? readJson(tokensPath) : [];

	const semanticPath = join(partsDir, "semantic.json");
	const semanticTokenColors: Record<string, string> = existsSync(semanticPath) ? readJson(semanticPath) : {};

	const theme: ThemeJson = {
		name: base.name,
		type: base.type,
		semanticHighlighting: base.semanticHighlighting,
		colors,
		tokenColors,
		...(Object.keys(semanticTokenColors).length > 0 && { semanticTokenColors }),
	};

	const themesDir = join(dir, "themes");
	mkdirSync(themesDir, { recursive: true });
	const themePath = join(themesDir, `${themeId}-color-theme.json`);
	writeJson(themePath, theme);

	console.log(`Merged theme: ${themePath}`);
	return themePath;
};

const packageTheme = (themeId: string): string => {
	const dir = themeDir(themeId);
	if (!existsSync(join(dir, "package.json"))) fail(`Theme "${themeId}" not found.`);

	// Delegate to the canonical repo build (scripts/build.ts) so README (with
	// hero image + color-swatch palette), icon, CHANGELOG, and repository
	// metadata are generated consistently for every theme. `pnpm build`
	// discovers and packages all themes under themes/*. execFileSync (no shell)
	// keeps the call injection-free.
	try {
		execFileSync("pnpm", ["build"], { cwd: PROJECT_ROOT, stdio: "inherit" });
		const { version } = readJson<{ version: string }>(join(dir, "package.json"));
		const vsixPath = join(dir, `${themeId}-${version}.vsix`);
		console.log(`\nPackaged: ${vsixPath}`);
		return vsixPath;
	} catch (error) {
		return fail(`Failed to package theme: ${(error as Error).message}`);
	}
};

const bumpVersion = (themeId: string, level: BumpLevel = "patch"): string => {
	const dir = themeDir(themeId);
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) fail(`Theme "${themeId}" not found.`);

	const packageJson = readJson<{ version: string }>(packageJsonPath);
	const [major, minor, patch] = packageJson.version.split(".").map(Number);

	const bumpMap: Record<BumpLevel, string> = {
		major: `${major + 1}.0.0`,
		minor: `${major}.${minor + 1}.0`,
		patch: `${major}.${minor}.${patch + 1}`,
	};

	const newVersion = bumpMap[level];
	packageJson.version = newVersion;
	writeJson(packageJsonPath, packageJson);

	console.log(`Version updated: ${newVersion}`);
	return newVersion;
};

const showHelp = () =>
	console.log(`
VSCode Theme Builder

Commands:
  init <theme-id> <theme-name> [--type dark|light]
      Copy template and initialize a new theme
      Example: tsx theme-builder.ts init ocean-blue "Ocean Blue" --type dark

  merge <theme-id>
      Merge parts/*.json into the final theme file
      Example: tsx theme-builder.ts merge ocean-blue

  package <theme-id>
      Delegate to \`pnpm build\` — rebuilds ALL themes under themes/* (each
      gets README + hero + swatches + icon + CHANGELOG). <theme-id> only
      selects which resulting .vsix path is returned.
      Example: tsx theme-builder.ts package ocean-blue

  bump <theme-id> [patch|minor|major]
      Increment version (default: patch)
      Example: tsx theme-builder.ts bump ocean-blue minor

Workflow:
  1. tsx theme-builder.ts init my-theme "My Theme" --type dark
  2. Edit my-theme/parts/*.json files
  3. tsx theme-builder.ts merge my-theme
  4. tsx theme-builder.ts package my-theme
  5. code --install-extension my-theme/my-theme-0.0.1.vsix
`);

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
	case "init": {
		const [, themeId, themeName] = args;
		const typeIndex = args.indexOf("--type");
		const type = (typeIndex >= 0 ? args[typeIndex + 1] : "dark") as ThemeType;
		if (!themeId || !themeName) fail("Usage: init <theme-id> <theme-name> [--type dark|light]");
		initTheme(themeId, themeName, type);
		break;
	}
	case "merge": {
		if (!args[1]) fail("Usage: merge <theme-id>");
		mergeTheme(args[1]);
		break;
	}
	case "package": {
		if (!args[1]) fail("Usage: package <theme-id>");
		packageTheme(args[1]);
		break;
	}
	case "bump": {
		if (!args[1]) fail("Usage: bump <theme-id> [patch|minor|major]");
		bumpVersion(args[1], (args[2] || "patch") as BumpLevel);
		break;
	}
	default:
		showHelp();
		break;
}
