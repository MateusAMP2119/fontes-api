// Repository migrations use one statement per semicolon, except trigger bodies.
// Keep complete CREATE TRIGGER ... END; blocks when loading them through D1 prepare.
export function migrationStatements(sql) {
  const statements = []
  let pending = ''
  for (const line of sql.replace(/^\s*--.*$/gm, '').split('\n')) {
    pending += line + '\n'
    const trigger = /^\s*CREATE TRIGGER\b/i.test(pending)
    if (trigger ? /^END;\s*$/i.test(line.trim()) : pending.trimEnd().endsWith(';')) {
      statements.push(pending.trim())
      pending = ''
    }
  }
  if (pending.trim()) throw new Error('Incomplete migration statement')
  return statements
}
