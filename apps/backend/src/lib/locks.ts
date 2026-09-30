import { Prisma } from '@tracelayer/db';

/** Tables whose rows act as locks for their children. Fixed list, so the name is never user input. */
type LockableTable = 'workspaces' | 'projects' | 'environments' | 'alert_rules';

/**
 * Locks one parent row for the rest of the transaction (SELECT … FOR UPDATE).
 * Used to serialize "check then insert" sequences under a parent, such as enforcing a limit
 * on the number of children or case-insensitive name uniqueness, which a unique index alone
 * cannot express. Returns false if the row does not exist.
 */
export async function lockRow(
  tx: Prisma.TransactionClient,
  table: LockableTable,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`,
  );
  return rows.length > 0;
}
