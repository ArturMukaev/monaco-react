import React, { useEffect, useMemo, useRef, useState } from 'react';

import Editor, { type Monaco } from '../../dist';

type SqlDialect = 'postgresql' | 'oracle';

const DIALECT_SCHEMAS: Record<SqlDialect, Record<string, string[]>> = {
  postgresql: {
    users: ['id', 'email', 'first_name', 'last_name', 'created_at', 'status'],
    orders: ['id', 'user_id', 'total_amount', 'currency', 'created_at', 'status'],
    products: ['id', 'sku', 'title', 'price', 'category_id', 'in_stock'],
    categories: ['id', 'name', 'parent_id', 'is_active'],
  },
  oracle: {
    USERS: ['ID', 'EMAIL', 'FIRST_NAME', 'LAST_NAME', 'CREATED_AT', 'STATUS'],
    ORDERS: ['ID', 'USER_ID', 'TOTAL_AMOUNT', 'CURRENCY', 'CREATED_AT', 'STATUS'],
    PRODUCTS: ['ID', 'SKU', 'TITLE', 'PRICE', 'CATEGORY_ID', 'IN_STOCK'],
    CATEGORIES: ['ID', 'NAME', 'PARENT_ID', 'IS_ACTIVE'],
  },
};

const DIALECT_KEYWORDS: Record<SqlDialect, string[]> = {
  postgresql: [
    'SELECT',
    'FROM',
    'WHERE',
    'JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'GROUP BY',
    'ORDER BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'RETURNING',
    'ILIKE',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'WITH',
    'AND',
    'OR',
    'IN',
    'NOT',
    'NULL',
    'AS',
  ],
  oracle: [
    'SELECT',
    'FROM',
    'WHERE',
    'JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'GROUP BY',
    'ORDER BY',
    'HAVING',
    'FETCH FIRST',
    'ROWNUM',
    'MERGE',
    'NVL',
    'SYSDATE',
    'SYSTIMESTAMP',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'CONNECT BY',
    'START WITH',
    'AND',
    'OR',
    'IN',
    'NOT',
    'NULL',
    'AS',
  ],
};

function getAliasToTableMap(sql: string) {
  const aliasMap = new Map<string, string>();
  const aliasRegex = /\b(?:from|join)\s+([a-z_][\w$]*)\s+([a-z_][\w$]*)\b/gi;
  let match: RegExpExecArray | null = aliasRegex.exec(sql);

  while (match) {
    aliasMap.set(match[2].toLowerCase(), match[1]);
    match = aliasRegex.exec(sql);
  }

  return aliasMap;
}

function resolveCompletionContext(sqlBeforeCursor: string) {
  const normalized = sqlBeforeCursor.toLowerCase();
  const aliasDotMatch = normalized.match(/([a-z_][\w$]*)\.\s*$/i);

  if (aliasDotMatch) {
    return { kind: 'alias-column' as const, alias: aliasDotMatch[1] };
  }

  if (/\b(from|join|update|into|table)\s+[a-z_0-9$]*$/i.test(normalized)) {
    return { kind: 'table' as const };
  }

  if (/\b(select|where|on|having|group\s+by|order\s+by|set|and|or)\s+[a-z_0-9$]*$/i.test(normalized)) {
    return { kind: 'column' as const };
  }

  return { kind: 'any' as const };
}

function App() {
  const [query, setQuery] = useState("");
  const [dialect, setDialect] = useState<SqlDialect>('postgresql');
  const providerRef = useRef<{ dispose: () => void } | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const activeSchema = useMemo(() => DIALECT_SCHEMAS[dialect], [dialect]);
  const tableNames = useMemo(() => Object.keys(activeSchema), [activeSchema]);
  const columnNames = useMemo(() => Object.values(activeSchema).flat(), [activeSchema]);
  const activeKeywords = useMemo(() => DIALECT_KEYWORDS[dialect], [dialect]);

  useEffect(() => {
    return () => {
      providerRef.current?.dispose();
    };
  }, []);

  const registerCompletionProvider = (monaco: Monaco) => {
    providerRef.current?.dispose();
    providerRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model, position) => {
        const sqlBeforeCursor = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const context = resolveCompletionContext(sqlBeforeCursor);
        const aliasMap = getAliasToTableMap(sqlBeforeCursor);
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const keywordSuggestions = activeKeywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          detail: dialect,
          range,
        }));

        const tableSuggestions = tableNames.map((table) => ({
          label: table,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: table,
          detail: 'table',
          range,
        }));

        const aliasTable = aliasMap.get(context.kind === 'alias-column' ? context.alias : '');
        const normalizedAliasTable =
          dialect === 'oracle' ? aliasTable?.toUpperCase() : aliasTable?.toLowerCase();
        const targetColumns =
          context.kind === 'alias-column'
            ? activeSchema[normalizedAliasTable ?? ''] ?? []
            : columnNames;

        const columnSuggestions = targetColumns.map((column) => ({
          label: column,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: column,
          detail: 'column',
          range,
        }));

        if (context.kind === 'table') {
          return { suggestions: tableSuggestions };
        }
        if (context.kind === 'column' || context.kind === 'alias-column') {
          return { suggestions: columnSuggestions };
        }

        return { suggestions: [...keywordSuggestions, ...tableSuggestions, ...columnSuggestions] };
      },
    });
  };

  const handleEditorMount = (_editor: unknown, monaco: Monaco) => {
    monacoRef.current = monaco;
    registerCompletionProvider(monaco);
  };

  useEffect(() => {
    if (monacoRef.current) {
      registerCompletionProvider(monacoRef.current);
    }
  }, [dialect, activeKeywords, activeSchema, tableNames, columnNames]);

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
              onChange={(event) => setDialect(event.target.value as SqlDialect)}
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid #cfd4dc' }}
            >
              <option value="postgresql">PostgreSQL</option>
              <option value="oracle">Oracle</option>
            </select>
          </div>

          <div style={{ flex: 1 }}>
            <Editor
              height="100%"
              language="sql"
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
            Mock schema ({dialect})
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
