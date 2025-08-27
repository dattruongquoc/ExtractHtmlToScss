import * as vscode from "vscode";
import { CheerioAPI, load as loadHtml } from "cheerio";
import type { Element } from "domhandler";
import * as path from "path";
import * as fs from "fs/promises";
//custom class ignore from setting
const IGNORE_CLASS_PATTERNS: string[] = vscode.workspace.getConfiguration("ExtractHtmlToScss").get("ignoreClassPatterns", ["br_*", ".br_*"]);

/** Convert a glob-style pattern (*) into a RegExp */
function globToRegExp(glob: string): RegExp {
  const g = glob.startsWith(".") ? glob.slice(1) : glob;
  const esc = g.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  const regex = "^" + esc.replace(/\*/g, ".*") + "$";
  return new RegExp(regex);
}

/** Check if a class matches any pattern in the ignore list */
function isIgnoredClass(cls: string): boolean {
  return IGNORE_CLASS_PATTERNS.some((pat) => globToRegExp(pat).test(cls));
}


/**
  * Rules for selecting the display selector:
 * - rule01: If both id and class exist → use class only.
 * - rule02: If multiple classes exist → use only the first class.
 * - rule03: If no class or id exists → skip the element.
 * - rule04: filter out classes that are listed in the ignore list
 */
function selectorForElement(
  $: CheerioAPI,
  el: Element
): { sel: string | null; note?: string } {
  const tag = el.tagName?.toLowerCase?.() || "";
  if (tag === "script" || tag === "style" || tag === "br") return { sel: null };
  const $el = $(el);
  const classAttr = ($el.attr("class") || "").trim();
  const idAttr = ($el.attr("id") || "").trim();

  const classes = classAttr.split(/\s+/).filter(Boolean);

  const usableClasses = classes.filter((c) => !isIgnoredClass(c));

  //rule01 + rule02 + rule04
  if (usableClasses.length > 0) {
    const firstClass = usableClasses[0];
    return { sel: `.${firstClass}` };
  }

  //set iD attr if not has class
  if (idAttr) {
    return { sel: `#${idAttr}` };
  }

  if (["h3", "h4", "h5", "h6"].includes(tag)) {
    return { sel: tag };
  }

  return { sel: null };
}

/**
 * Recursively traverse the DOM, collecting only nodes with class/id, and nest them according to the DOM structure.
 */
function buildNestedScss($: CheerioAPI, root: Element, indent = 1): string[] {
  const lines: string[] = [];
  const children = $(root).children().toArray();
  const seenThisLevel = new Set<string>();

  for (const child of children) {
    const tag = (child as any).tagName?.toLowerCase?.() || "";
    const { sel, note } = selectorForElement($, child);
    if (!sel) {
      // No class/id → element may still have valid children, continue recursion to traverse through this level
      lines.push(...buildNestedScss($, child, indent));
      continue;
    }

    if (seenThisLevel.has(sel)) {
      continue;
    }
    seenThisLevel.add(sel);

    const childLines = buildNestedScss($, child, indent + 1);

    const lineHead = `${"  ".repeat(indent)}${sel} {${note ?? ""}`;
    if (childLines.length === 0) {
      lines.push(`${"  ".repeat(indent)}${sel}{${note ?? ""}}`);
    } else {
      lines.push(lineHead);
      lines.push(...childLines);
      lines.push(`${"  ".repeat(indent)}}`);
    }
  }
  return lines;
}

function wrapWithRootSelector(
  rootSelector: string,
  innerLines: string[]
): string {
  const out: string[] = [];
  out.push(`${rootSelector} {`);
  out.push(...innerLines);
  out.push(`}`);
  return out.join("\n");
}

async function pickHtmlFileFromWorkspace(): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles(
    "**/*.html",
    "**/node_modules/**",
    100
  );
  if (files.length === 0) {
    vscode.window.showErrorMessage("No HTML source file was found in the workspace.");
    return undefined;
  }
    // Prioritize specific files
  const priorityNames = ["index.html", "under.html", "interview.html"];
  const sortedFiles = [
    ...priorityNames
      .map(name => files.find(uri => path.basename(uri.fsPath).toLowerCase() === name))
      .filter(Boolean),
    ...files.filter(uri => !priorityNames.includes(path.basename(uri.fsPath).toLowerCase()))
  ];
  const items = sortedFiles
    .filter((uri): uri is vscode.Uri => !!uri)
    .map((uri) => ({
      label: path.basename(uri.fsPath),
      description: vscode.workspace.asRelativePath(uri.fsPath),
      uri,
    }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select the source HTML file from which to extract CSS selectors",
  });
  return picked?.uri;
}

async function readFileUtf8(uri: vscode.Uri): Promise<string> {
  const buf = await fs.readFile(uri.fsPath);
  return buf.toString("utf8");
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "ExtractHtmlToScss",
    async () => {
      // 1) Select the source html file
      const htmlUri = await pickHtmlFileFromWorkspace();
      if (!htmlUri) {
        return;
      }

      // 3) Enter the root selector
      const rootSelector = await vscode.window.showInputBox({
        prompt: "Enter the CSS selector for the root element (e.g., .idxn01 .card)",
        placeHolder: ".idx01 .card",
        validateInput: (v) =>
          v && v.trim().length > 0 ? null : "Selector cannot be empty",
      });
      if (!rootSelector) {
        return;
      }

      // 4) Read & parse HTML
      let html = "";
      try {
        html = await readFileUtf8(htmlUri);
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Cannot read HTML file: ${e?.message || e}`
        );
        return;
      }
      const $ = loadHtml(html, { xmlMode: false });

      // 5) Find the root element
      const rootMatch = $(rootSelector).first();
      const rootElement = rootMatch.get(0);
      if (!rootElement || rootElement.type !== "tag") {
        vscode.window.showWarningMessage(
          `Cannot find a valid element with selector: ${rootSelector}`
        );
        return;
      }

      // 6) Generate SCSS
      const innerLines = buildNestedScss($, rootElement as Element, 1);
      const scssBlock = wrapWithRootSelector(rootSelector, innerLines);

      // 7) Insert into the current SCSS file at the cursor position
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        // If no editor is open, create new untitled SCSS
        const doc = await vscode.workspace.openTextDocument({
          language: "scss",
          content: scssBlock,
        });
        await vscode.window.showTextDocument(doc);
      } else {
        await editor.edit((editBuilder) => {
          editBuilder.insert(editor.selection.active, `\n${scssBlock}\n`);
        });
      }

      vscode.window.showInformationMessage(
        "Generated CSS from HTML based on selector"
      );
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
