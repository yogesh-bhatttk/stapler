import { Project, SyntaxKind, JsxText, JsxExpression, StringLiteral } from 'ts-morph';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const localesDir = path.join(root, 'src', 'core', 'i18n', 'locales');
const project = new Project({
  tsConfigFilePath: path.join(root, 'tsconfig.json')
});

const uiFiles = project.getSourceFiles('src/ui/**/*.tsx');

let dictionary: Record<string, string> = {};

function addKey(text: string): string {
  // Trim spaces and newlines
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (/^[\W_]+$/.test(clean)) return ''; // Ignore strings that are just punctuation/symbols
  if (!dictionary[clean]) {
    dictionary[clean] = clean;
  }
  return clean;
}

// Ensure the file imports useTranslation
function ensureTranslationImport(sourceFile: any) {
  const imports = sourceFile.getImportDeclarations();
  const hasI18nImport = imports.some(
    imp =>
      imp.getModuleSpecifierValue() === '../../core/i18n' ||
      imp.getModuleSpecifierValue() === '../../../core/i18n' ||
      imp.getModuleSpecifierValue() === '../../../../core/i18n' ||
      imp.getModuleSpecifierValue().endsWith('core/i18n')
  );

  if (!hasI18nImport) {
    // Determine relative path to src/core/i18n
    const filePath = sourceFile.getFilePath();
    const relativeToCore = path
      .relative(path.dirname(filePath), path.join(root, 'src', 'core', 'i18n'))
      .replace(/\\/g, '/');
    const importPath = relativeToCore.startsWith('.') ? relativeToCore : `./${relativeToCore}`;
    sourceFile.addImportDeclaration({
      moduleSpecifier: importPath,
      namedImports: [{ name: 'useTranslation' }]
    });
  }
}

// Ensure the component calls useTranslation
function ensureUseTranslationCall(functionDecl: any) {
  const body = functionDecl.getBody();
  if (!body) return;
  const statements = body.getStatements();
  const hasCall = statements.some(s => s.getText().includes('useTranslation()'));
  if (!hasCall) {
    body.insertStatements(0, 'const t = useTranslation();');
  }
}

let modifiedFiles = 0;

uiFiles.forEach(file => {
  let fileModified = false;

  const jsxElements = file.getDescendantsOfKind(SyntaxKind.JsxElement);
  const jsxSelfClosingElements = file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);

  // Find all JsxText (text inside tags)
  const jsxTexts = file.getDescendantsOfKind(SyntaxKind.JsxText);
  for (const jsxText of jsxTexts) {
    const text = jsxText.getLiteralText();
    const cleanText = addKey(text);
    if (cleanText && cleanText.length > 1) {
      // Replace with {t('key')}
      jsxText.replaceWithText(`{t(${JSON.stringify(cleanText)})}`);
      fileModified = true;
    }
  }

  // Find strings passed to common attributes: label, title, hint, placeholder
  const targetAttrs = ['label', 'title', 'hint', 'placeholder', 'legend'];
  const attributes = file.getDescendantsOfKind(SyntaxKind.JsxAttribute);
  for (const attr of attributes) {
    if (attr.isKind(SyntaxKind.JsxAttribute)) {
      const name = attr.getNameNode().getText();
      if (targetAttrs.includes(name)) {
        const init = attr.getInitializer();
        if (init && init.isKind(SyntaxKind.StringLiteral)) {
          const text = init.getLiteralText();
          const cleanText = addKey(text);
          if (cleanText && cleanText.length > 1) {
            attr.setInitializer(`{t(${JSON.stringify(cleanText)})}`);
            fileModified = true;
          }
        }
      }
    }
  }

  if (fileModified) {
    ensureTranslationImport(file);
    // Add const t = useTranslation() to all exported functions or components
    const functions = file.getFunctions();
    for (const fn of functions) {
      if (fn.isExported() || fn.getName()?.match(/^[A-Z]/)) {
        ensureUseTranslationCall(fn);
      }
    }
    const arrowFunctions = file
      .getVariableDeclarations()
      .filter(v => v.getInitializerIfKind(SyntaxKind.ArrowFunction));
    for (const v of arrowFunctions) {
      const name = v.getName();
      if (name.match(/^[A-Z]/)) {
        const fn = v.getInitializerIfKind(SyntaxKind.ArrowFunction);
        ensureUseTranslationCall(fn);
      }
    }

    file.saveSync();
    modifiedFiles++;
  }
});

console.log(`Modified ${modifiedFiles} files.`);

if (!fs.existsSync(localesDir)) {
  fs.mkdirSync(localesDir, { recursive: true });
}

// Generate locales
const locales = ['en', 'es', 'pt-BR', 'de', 'fr', 'hi', 'id', 'ja', 'ru', 'zh-CN', 'ar'];
for (const loc of locales) {
  const filePath = path.join(localesDir, `${loc}.json`);
  let currentDict = {};
  if (fs.existsSync(filePath)) {
    try {
      currentDict = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {}
  }

  // Merge
  const finalDict = { ...dictionary, ...currentDict };
  // Sort keys alphabetically
  const sortedDict = Object.keys(finalDict)
    .sort()
    .reduce((acc, key) => {
      acc[key] = finalDict[key];
      return acc;
    }, {});

  fs.writeFileSync(filePath, JSON.stringify(sortedDict, null, 2), 'utf-8');
}

console.log(`Wrote dictionaries to ${localesDir}`);
