/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from 'react';

import {
  EntityContextType,
  LanguageIdEnum,
  setupLanguageFeatures,
  type CompletionService,
  type ICompletionItem,
  vsPlusTheme,
} from 'monaco-sql-languages';
import { loader } from '../../dist';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import PgSQLWorker from 'monaco-sql-languages/esm/languages/pgsql/pgsql.worker?worker';
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution';
import { language as pgsqlLanguage } from 'monaco-sql-languages/esm/languages/pgsql/pgsql';
import { languages as monacoLanguages } from 'monaco-editor';

import Editor, { type Monaco } from '../../dist';

// Currently only PostgreSQL is wired to monaco-sql-languages. Oracle is kept
// in the dropdown for UX continuity but is disabled (see the <select> below).
type SqlDialect = 'pgsql';

const DIALECT_LANGUAGE_ID: Record<SqlDialect, LanguageIdEnum> = {
  pgsql: LanguageIdEnum.PG,
};

const DIALECT_LABEL: Record<SqlDialect, string> = {
  pgsql: 'PostgreSQL',
};

// Reuse the same type keyword list that monaco-sql-languages uses for
// highlighting, so the suggestions stay consistent with the tokenizer.
function extractTypeKeywords(lang: unknown): string[] {
  const types = (lang as { typeKeywords?: string[] }).typeKeywords ?? [];
  return Array.from(new Set(types)).sort();
}

const PG_TYPE_KEYWORDS = extractTypeKeywords(pgsqlLanguage);

// Inline Monaco setup (instead of separate `monaco-setup.ts`) so CI build
// cannot fail from a missing side-effect module.
const pgsqlRootRules = (pgsqlLanguage as unknown as { tokenizer: { root: unknown[] } }).tokenizer.root;
const hasTypecastRule = pgsqlRootRules.some(
  (rule) => Array.isArray(rule) && String((rule as unknown[])[0]) === String(/::/),
);
if (!hasTypecastRule) {
  pgsqlRootRules.unshift([/::/, 'operator.symbol']);
}

(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === LanguageIdEnum.PG) {
      return new PgSQLWorker();
    }
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('sql-light', vsPlusTheme.lightThemeData);
monaco.editor.defineTheme('sql-dark', vsPlusTheme.darkThemeData);
loader.config({ monaco });

type Schema = Record<string, string[]>;

const DIALECT_SCHEMAS: Record<SqlDialect, Schema> = {
  pgsql: {
    users: ['id', 'email', 'first_name', 'last_name', 'created_at', 'status'],
    orders: ['id', 'user_id', 'total_amount', 'currency', 'created_at', 'status'],
    products: ['id', 'sku', 'title', 'price', 'category_id', 'in_stock'],
    categories: ['id', 'name', 'parent_id', 'is_active'],
  },
};

function detectCastContext(sqlBeforeCursor: string): 'none' | 'pg-typecast' | 'cast-as' {
  // PostgreSQL `value::type` shorthand. Match optional whitespace + partial word
  // after the `::` so the check also succeeds while the user is typing the type name.
  if (/::\s*\w*$/.test(sqlBeforeCursor)) {
    return 'pg-typecast';
  }

  // `CAST(x AS type)` — walk back to the last occurrence of `cast(` to make
  // sure we're still inside that expression. A simple heuristic, enough for the demo.
  const lowered = sqlBeforeCursor.toLowerCase();
  const castIdx = lowered.lastIndexOf('cast(');
  if (castIdx !== -1) {
    const tail = sqlBeforeCursor.slice(castIdx);
    if (!tail.includes(')') && /\bas\s+\w*$/i.test(tail)) {
      return 'cast-as';
    }
  }

  return 'none';
}

function buildCompletionService(getSchema: () => Schema): CompletionService {
  return async (model, position, _context, suggestions, entities, snippets) => {
    if (!suggestions) {
      return [];
    }

    const schema = getSchema();
    const tables = Object.keys(schema);
    const results: ICompletionItem[] = [];

    // Handle type-cast suggestions (PostgreSQL `::type` and `CAST(x AS type)`)
    // BEFORE returning table/column results — inside a cast, only types make sense.
    const sqlBeforeCursor = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    const castContext = detectCastContext(sqlBeforeCursor);

    if (castContext !== 'none') {
      return PG_TYPE_KEYWORDS.map<ICompletionItem>((type) => ({
        label: type,
        kind: monacoLanguages.CompletionItemKind.TypeParameter,
        detail: 'type',
        insertText: type,
        sortText: '0' + type,
      }));
    }

    const keywordItems: ICompletionItem[] = suggestions.keywords.map((keyword) => ({
      label: keyword,
      kind: monacoLanguages.CompletionItemKind.Keyword,
      detail: 'keyword',
      insertText: keyword,
      sortText: '3' + keyword,
    }));

    suggestions.syntax.forEach((item) => {
      if (item.syntaxContextType === EntityContextType.TABLE) {
        tables.forEach((table) => {
          results.push({
            label: table,
            kind: monacoLanguages.CompletionItemKind.Struct,
            detail: 'table',
            insertText: table,
            sortText: '1' + table,
          });
        });
      }

      if (item.syntaxContextType === EntityContextType.COLUMN) {
        // Prefer columns that belong to tables already referenced in the query.
        // This covers cases like: SELECT u.| FROM users u
        const referencedTables = (entities ?? [])
          .filter(
            (entity) =>
              entity.entityContextType === EntityContextType.TABLE && schema[entity.text],
          )
          .map((entity) => entity.text);

        const targetTables = referencedTables.length > 0 ? referencedTables : tables;
        const seen = new Set<string>();

        targetTables.forEach((table) => {
          (schema[table] ?? []).forEach((column) => {
            const key = `${table}.${column}`;
            if (seen.has(key)) return;
            seen.add(key);
            results.push({
              label: { label: column, description: table },
              kind: monacoLanguages.CompletionItemKind.Field,
              detail: `column · ${table}`,
              insertText: column,
              sortText: '2' + column,
            });
          });
        });
      }
    });

    const snippetItems: ICompletionItem[] = (snippets ?? []).map((snippet) => ({
      label: snippet.label || snippet.prefix,
      kind: monacoLanguages.CompletionItemKind.Snippet,
      detail: snippet.description ?? 'SQL Snippet',
      insertText: snippet.insertText,
      insertTextRules: monacoLanguages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: snippet.prefix,
      sortText: '4' + snippet.prefix,
    }));

    return [...results, ...keywordItems, ...snippetItems];
  };
}

function App() {
  const [query, setQuery] = useState('');
  const [dialect] = useState<SqlDialect>('pgsql');
  const monacoRef = useRef<Monaco | null>(null);

  const activeSchema = DIALECT_SCHEMAS[dialect];
  const schemaRef = useRef(activeSchema);

  useEffect(() => {
    schemaRef.current = activeSchema;
  }, [activeSchema]);

  // Register the shared custom completion / diagnostics config for the
  // supported dialect exactly once. The completion service reads the latest
  // schema from the ref.
  useEffect(() => {
    const completionService = buildCompletionService(() => schemaRef.current);

    (Object.values(DIALECT_LANGUAGE_ID) as LanguageIdEnum[]).forEach((languageId) => {
      setupLanguageFeatures(languageId, {
        completionItems: {
          enable: true,
          // `:` triggers the popup for `value::type` (PostgreSQL type cast).
          triggerCharacters: [' ', '.', ':'],
          completionService,
        },
        diagnostics: true,
      });
    });
  }, []);

  const handleEditorMount = (_editor: unknown, monaco: Monaco) => {
    monacoRef.current = monaco;
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 32,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: 'min(960px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            height: 'min(640px, calc(100vh - 64px))',
            border: '1px solid #cfd4dc',
            borderRadius: 8,
            overflow: 'hidden',
            backgroundColor: '#ffffff',
            boxShadow: '0 1px 2px rgba(16, 24, 40, 0.06)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              borderBottom: '1px solid #e4e7ec',
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              backgroundColor: '#f8f9fb',
            }}
          >
            <label htmlFor="sql-dialect-select" style={{ fontSize: 13, color: '#344054' }}>
              SQL dialect:
            </label>
            <select
              id="sql-dialect-select"
              value={dialect}
              onChange={() => {
                // No-op: only PostgreSQL is selectable. Oracle is shown but disabled.
              }}
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid #cfd4dc' }}
            >
              <option value="pgsql">PostgreSQL</option>
              <option value="oracle" disabled title="Oracle is not supported by monaco-sql-languages">
                Oracle (not supported)
              </option>
            </select>
          </div>

          <div style={{ flex: 1 }}>
            <Editor
              height="100%"
              language={DIALECT_LANGUAGE_ID[dialect]}
              theme="sql-light"
              value={query}
              onChange={(value) => setQuery(value ?? '')}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                wordWrap: 'on',
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                formatOnType: true,
                formatOnPaste: true,
                lineNumbers: 'off',
                glyphMargin: false,
                folding: false,
                overviewRulerLanes: 0,
                scrollbar: { vertical: 'auto', horizontal: 'auto' },
                padding: { top: 14, bottom: 14 },
                suggest: {
                  snippetsPreventQuickSuggestions: false,
                },
              }}
            />
          </div>
        </div>

        <div
          style={{
            border: '1px solid #cfd4dc',
            borderRadius: 8,
            backgroundColor: '#ffffff',
            boxShadow: '0 1px 2px rgba(16, 24, 40, 0.06)',
            padding: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: '#344054', marginBottom: 10 }}>
            Mock schema ({DIALECT_LABEL[dialect]})
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {Object.entries(activeSchema).map(([table, columns]) => (
              <div key={table} style={{ border: '1px solid #e4e7ec', borderRadius: 6, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{table}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {columns.map((column) => (
                    <span
                      key={`${table}-${column}`}
                      style={{
                        fontSize: 12,
                        border: '1px solid #d0d5dd',
                        borderRadius: 999,
                        padding: '2px 8px',
                        backgroundColor: '#f8f9fb',
                      }}
                    >
                      {column}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
